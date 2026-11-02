import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rootCertificates, checkServerIdentity } from 'node:tls';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { postgresConnectionConfig } = require('../apps/api/src/postgres-connection.ts');
const base = { DATABASE_URL: 'postgresql://runtime:fixture@db.example.test:5432/dreamwalk' };

test('local non-TLS default and explicit false retain exact URL without consulting ambient PGSSLMODE', () => {
  for (const DATABASE_SSL of [undefined, 'false']) {
    const config = postgresConnectionConfig({ ...base, DATABASE_SSL, PGSSLMODE: 'no-verify' });
    assert.deepEqual(config, { connectionString: base.DATABASE_URL, ssl: false });
    assert.equal(new pg.Client(config).connectionParameters.ssl, false);
  }
});
test('verified TLS survives the actual pg connection parser and retains hostname checking', () => {
  const config = postgresConnectionConfig({ ...base, DATABASE_SSL: 'true' });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  const connection = new pg.Client(config).connectionParameters;
  assert.equal(connection.host, 'db.example.test');
  assert.equal(connection.ssl.rejectUnauthorized, true);
  assert.equal(connection.ssl.checkServerIdentity, undefined);
  assert.equal(connection.ssl.servername, undefined);
  assert.equal(
    checkServerIdentity('db.example.test', { subjectaltname: 'DNS:db.example.test' }),
    undefined,
  );
  assert.ok(checkServerIdentity('db.example.test', { subjectaltname: 'DNS:other.example.test' }));
});
test('optional CA accepts bounded PEM certificates without disabling verification', () => {
  const ca = rootCertificates[0];
  const config = postgresConnectionConfig({ ...base, DATABASE_SSL: 'true', DATABASE_SSL_CA: ca });
  assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true });
  assert.deepEqual(new pg.Client(config).connectionParameters.ssl, config.ssl);
  for (const invalid of [
    '',
    'not a certificate',
    'x'.repeat(131073),
    ca + '\nPRIVATE DATA',
    '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----',
  ])
    assert.throws(
      () => postgresConnectionConfig({ ...base, DATABASE_SSL: 'true', DATABASE_SSL_CA: invalid }),
      /DATABASE_SSL_CA_INVALID/,
    );
  assert.throws(
    () => postgresConnectionConfig({ ...base, DATABASE_SSL_CA: ca }),
    /CA_REQUIRES_TLS/,
  );
});
test('URL SSL overrides and alternate hosts are rejected before pg parses or reads files', () => {
  for (const query of [
    'sslmode=no-verify',
    'sslmode=require',
    'sslmode=verify-full',
    'ssl=false',
    'ssl=0',
    'sslrootcert=/private/file',
    'sslkey=/private/file',
    'sslcert=/private/file',
    'sslnegotiation=direct',
    'uselibpqcompat=true',
    'SSLMode=disable',
    'host=other.example.test',
    'hostaddr=127.0.0.1',
    '%73slmode=no-verify',
  ])
    for (const DATABASE_SSL of [undefined, 'true'])
      assert.throws(
        () =>
          postgresConnectionConfig({ DATABASE_URL: `${base.DATABASE_URL}?${query}`, DATABASE_SSL }),
        /CONNECTION_OVERRIDE_FORBIDDEN/,
      );
});
test('runtime and seed do not select the privileged migration URL', () => {
  const env = {
    ...base,
    DATABASE_MIGRATION_URL: 'postgres://migrator:fixture@db.example.test:5432/dreamwalk',
    DATABASE_SSL: 'true',
  };
  assert.equal(postgresConnectionConfig(env).connectionString, base.DATABASE_URL);
  assert.equal(
    postgresConnectionConfig(env, 'migration').connectionString,
    env.DATABASE_MIGRATION_URL,
  );
  assert.equal(postgresConnectionConfig(base, 'migration').connectionString, base.DATABASE_URL);
  assert.throws(
    () => postgresConnectionConfig({ ...base, DATABASE_MIGRATION_URL: '' }, 'migration'),
    /URL_REQUIRED/,
  );
});
test('malformed settings fail without reflecting credentials in errors', () => {
  for (const DATABASE_SSL of ['', 'yes', '1', 'TRUE'])
    assert.throws(() => postgresConnectionConfig({ ...base, DATABASE_SSL }), /MUST_BE_BOOLEAN/);
  for (const DATABASE_URL of [
    'invalid-secret-value',
    'https://user:fixture-secret@example.test/db',
    'postgres:///db',
    'postgres://user:fixture-secret@%2Ftmp/db',
    'postgres://user:fixture-secret@%5Ctmp/db',
    'postgres://user:fixture-secret@example.test/db#fragment',
  ]) {
    assert.throws(
      () => postgresConnectionConfig({ DATABASE_URL }),
      (error) => {
        assert.equal(error.message, 'DATABASE_CONNECTION_URL_INVALID');
        assert.ok(!JSON.stringify(error).includes('fixture-secret'));
        return true;
      },
    );
  }
});
