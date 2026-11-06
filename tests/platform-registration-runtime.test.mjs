/** Disposable PostgreSQL regression: owner-role tests cannot detect production RLS failures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, 'A local disposable PostgreSQL database is required');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname));
assert.notEqual(process.env.NODE_ENV, 'production');
// Exercise immediate local registration only; never inherit the optional mail rollout.
process.env.AUTH_EMAIL_VERIFICATION_REQUIRED = 'false';
const require = createRequire(import.meta.url);
const { AccountController, Auth } = require('../apps/api/dist/auth.js');
const { grantRegistrationDreams } = require('../apps/api/dist/generation/starter-dreams.js');

test('non-owner runtime can register once while Dreams RLS denies other roles', async () => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    // These no-login roles and all fixture changes disappear at the final rollback.
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM pg_roles WHERE rolname IN ('dreamwalk_runtime','dreamwalk_registration_untrusted')",
        )
      ).rows[0].count,
      '0',
    );
    await client.query('CREATE ROLE dreamwalk_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await client.query(
      'CREATE ROLE dreamwalk_registration_untrusted NOLOGIN NOSUPERUSER NOBYPASSRLS',
    );
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
    assert.match(schema, /^[a-z_][a-z0-9_]*$/);
    // Mirror the existing backend grants. The regression is missing policies, not a missing GRANT.
    await client.query(
      `GRANT USAGE ON SCHEMA "${schema}" TO dreamwalk_runtime, dreamwalk_registration_untrusted`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO dreamwalk_runtime, dreamwalk_registration_untrusted`,
    );
    await client.query(
      `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO dreamwalk_runtime, dreamwalk_registration_untrusted`,
    );
    const db = {
      query: async (sql, values = []) => (await client.query(sql, values)).rows,
      tx: async (work) => work(client),
    };
    const auth = new Auth(db);
    const controller = new AccountController(auth, db);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const body = {
      email: `Runtime-${suffix}@Example.Test`,
      handle: `Runtime_${suffix}`,
      name: 'Runtime Tester',
      password: 'synthetic-runtime-password',
    };
    const req = { headers: { 'user-agent': 'local-registration-regression' } };
    let sessionCookie;
    const res = {
      cookie: (name, value) => {
        assert.equal(name, 'dreamwalk_session');
        sessionCookie = value;
      },
    };
    await client.query('SAVEPOINT without_policy');
    await client.query('SET LOCAL ROLE dreamwalk_runtime');
    await assert.rejects(controller.register(body, req, res), (error) => error.code === '42501');
    await client.query('ROLLBACK TO SAVEPOINT without_policy');
    await client.query('RESET ROLE');
    assert.equal(
      (await client.query('SELECT count(*) FROM users WHERE email=$1', [body.email.toLowerCase()]))
        .rows[0].count,
      '0',
    );
    await client.query(
      await readFile(
        new URL('../packages/db/migrations/071_dreams_runtime_policies.sql', import.meta.url),
        'utf8',
      ),
    );
    await client.query('SET LOCAL ROLE dreamwalk_runtime');
    const privileges = (
      await client.query(
        'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    assert.deepEqual(privileges, {
      name: 'dreamwalk_runtime',
      rolsuper: false,
      rolbypassrls: false,
    });
    const registered = await controller.register(body, req, res);
    assert.equal(registered.user.handle, body.handle.toLowerCase());
    assert.equal(registered.user.email, body.email.toLowerCase());
    assert.match(sessionCookie, /^[a-f0-9]{64}$/);
    assert.equal(await grantRegistrationDreams(client, registered.user.id), false);
    const wallet = (
      await client.query('SELECT enabled,balance_subunits FROM dream_wallets WHERE owner_id=$1', [
        registered.user.id,
      ])
    ).rows[0];
    assert.deepEqual(wallet, { enabled: true, balance_subunits: '500000' });
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM dream_ledger WHERE owner_id=$1 AND kind='starter_grant'",
          [registered.user.id],
        )
      ).rows[0].count,
      '1',
    );
    assert.equal(
      (
        await controller.login(
          { email: body.email.toUpperCase(), password: body.password },
          req,
          res,
        )
      ).user.id,
      registered.user.id,
    );
    await client.query('SAVEPOINT case_collision');
    await assert.rejects(
      controller.register(
        { ...body, email: `other-${suffix}@example.test`, handle: body.handle.toUpperCase() },
        req,
        res,
      ),
      (error) => error.code === '23505',
    );
    await client.query('ROLLBACK TO SAVEPOINT case_collision');
    await client.query('RESET ROLE');
    const policies = (
      await client.query(
        "SELECT tablename,cmd,roles::text[] AS roles FROM pg_policies WHERE schemaname=$1 AND policyname LIKE 'dream_runtime_%' ORDER BY tablename,cmd",
        [schema],
      )
    ).rows;
    assert.equal(policies.length, 10);
    assert.ok(
      policies.every((row) => row.roles.length === 1 && row.roles[0] === 'dreamwalk_runtime'),
    );
    assert.ok(
      policies.every(
        (row) =>
          row.cmd !== 'DELETE' &&
          !(['dream_quotes', 'dream_ledger'].includes(row.tablename) && row.cmd === 'UPDATE'),
      ),
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('dream_wallets','dream_quotes','dream_holds','dream_ledger') AND c.relrowsecurity",
          [schema],
        )
      ).rows[0].count,
      '4',
    );
    await client.query('SET LOCAL ROLE dreamwalk_registration_untrusted');
    assert.equal((await client.query('SELECT count(*) FROM dream_wallets')).rows[0].count, '0');
    assert.equal((await client.query('SELECT count(*) FROM dream_ledger')).rows[0].count, '0');
    await client.query('SAVEPOINT untrusted_insert');
    await assert.rejects(
      client.query('INSERT INTO dream_wallets(owner_id) VALUES($1)', [registered.user.id]),
      (error) => error.code === '42501',
    );
    await client.query('ROLLBACK TO SAVEPOINT untrusted_insert');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
