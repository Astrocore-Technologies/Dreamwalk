/** Real local PostgreSQL + HTTP registration. No provider calls or production accounts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { grantRegistrationSparks } from '../apps/api/dist/generation/starter-sparks.js';

const base = process.env.TEST_API_URL || 'http://127.0.0.1:4000/api/v1';
const connectionString = process.env.DATABASE_URL;
for (const value of [base, connectionString]) {
  assert.ok(value, 'Local disposable database required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
}
const pool = new pg.Pool({ connectionString });
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
function identity() {
  const handle = `starter_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return {
    handle,
    name: handle,
    email: `${handle}@example.test`,
    password: `Test-${randomUUID()}`,
  };
}
async function register(body) {
  return fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function transaction(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
async function insertUser(c, id, account) {
  await c.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
    id,
    account.email,
    'not-a-usable-password-hash',
    account.name,
    account.handle,
  ]);
}
test('new registration receives exactly 50 real Sparks once, without changing demo money or old users', async (t) => {
  try {
    await t.test(
      'concurrent duplicate registration grants once and authenticated balance is actual',
      async () => {
        const account = identity();
        const oldRows = (
          await pool.query('SELECT id FROM users WHERE email<>$1 ORDER BY created_at LIMIT 2', [
            account.email,
          ])
        ).rows;
        const old = await pool.query(
          'SELECT * FROM spark_wallets WHERE owner_id=ANY($1::uuid[]) ORDER BY owner_id',
          [oldRows.map((r) => r.id)],
        );
        const results = await Promise.all([register(account), register(account)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const success = results.find((r) => r.status === 201);
        const user = (await success.json()).user;
        const cookie = success.headers
          .getSetCookie()
          .map((s) => s.split(';')[0])
          .join('; ');
        const response = await fetch(`${base}/sparks/wallet`, { headers: { cookie, origin } });
        assert.equal(response.status, 200);
        const wallet = await response.json();
        assert.equal(wallet.balanceSubunits, '500000');
        assert.equal(wallet.availableSubunits, '500000');
        assert.equal(wallet.heldSubunits, '0');
        assert.equal(wallet.enabled, true);
        assert.equal(wallet.purchaseAvailable, false);
        assert.equal(wallet.ledger.filter((e) => e.kind === 'starter_grant').length, 1);
        assert.equal(wallet.ledger[0].amountSubunits, '500000');
        const anonymous = await fetch(`${base}/sparks/wallet`);
        assert.equal(anonymous.status, 401);
        assert.equal((await register(account)).status, 409);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT * FROM spark_wallets WHERE owner_id=ANY($1::uuid[]) ORDER BY owner_id',
              [oldRows.map((r) => r.id)],
            )
          ).rows,
          old.rows,
        );
        assert.equal(
          (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [user.id])).rows[0]
            .balance,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM spark_ledger WHERE owner_id=$1 AND kind='starter_grant'",
              [user.id],
            )
          ).rows[0].count,
          '1',
        );
        // Concurrent internal replay after use is a no-op, never re-enables or restores spent credit.
        await pool.query(
          'UPDATE spark_wallets SET balance_subunits=123,enabled=false WHERE owner_id=$1',
          [user.id],
        );
        await Promise.all([
          transaction((c) => grantRegistrationSparks(c, user.id)),
          transaction((c) => grantRegistrationSparks(c, user.id)),
        ]);
        const replay = (
          await pool.query('SELECT enabled,balance_subunits FROM spark_wallets WHERE owner_id=$1', [
            user.id,
          ])
        ).rows[0];
        assert.deepEqual(replay, { enabled: false, balance_subunits: '123' });
        await assert.rejects(
          pool.query('UPDATE spark_ledger SET amount_subunits=500000 WHERE owner_id=$1', [user.id]),
          /immutable/,
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO spark_ledger(owner_id,event_key,kind,amount_subunits) VALUES($1,'invalid-without-hold','capture',1)",
            [user.id],
          ),
          /check constraint/,
        );
      },
    );
    await t.test(
      'registration transaction failure rolls back identity, wallet and credit together',
      async () => {
        const id = randomUUID(),
          account = identity();
        await assert.rejects(
          transaction(async (c) => {
            await insertUser(c, id, account);
            await grantRegistrationSparks(c, id);
            throw new Error('synthetic failure after grant');
          }),
          /synthetic failure/,
        );
        for (const [table, column] of [
          ['users', 'id'],
          ['spark_wallets', 'owner_id'],
          ['spark_ledger', 'owner_id'],
        ]) {
          assert.equal(
            (await pool.query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`, [id])).rows[0]
              .count,
            '0',
          );
        }
        const retry = await register(account);
        assert.equal(retry.status, 201);
      },
    );
    await t.test(
      'existing wallet without starter history cannot be converted or backfilled',
      async () => {
        const id = randomUUID();
        await transaction(async (c) => {
          await insertUser(c, id, identity());
          await c.query('INSERT INTO spark_wallets(owner_id,balance_subunits) VALUES($1,77)', [id]);
        });
        await assert.rejects(
          transaction((c) => grantRegistrationSparks(c, id)),
          /STARTER_SPARKS_EXISTING_WALLET/,
        );
        assert.deepEqual(
          (
            await pool.query(
              'SELECT enabled,balance_subunits FROM spark_wallets WHERE owner_id=$1',
              [id],
            )
          ).rows[0],
          { enabled: false, balance_subunits: '77' },
        );
      },
    );
  } finally {
    await pool.end();
  }
});
