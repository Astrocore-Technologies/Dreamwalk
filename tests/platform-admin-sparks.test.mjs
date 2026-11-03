/** Actual admin Sparks mutations on disposable loopback services; never production/paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const base = process.env.TEST_API_URL;
const connectionString = process.env.DATABASE_URL;
for (const value of [base, connectionString])
  assert.ok(value && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
const pool = new pg.Pool({ connectionString });
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
async function session() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: `a_${suffix}`,
      name: 'Sparks test',
      email: `${suffix}@example.test`,
      password: `Test-${randomUUID()}`,
    }),
  });
  assert.equal(response.status, 201);
  const { user } = await response.json();
  const cookie = response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  return {
    user,
    async request(method, path, body, status = 200) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await r.json();
      assert.equal(r.status, status, JSON.stringify(data));
      return data;
    },
  };
}
test('real Sparks admin adjustments preserve holds, audit, replay and legacy separation', async (t) => {
  try {
    const admin = await session(),
      member = await session();
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.user.id]);
    const grant = {
      userId: member.user.id,
      amount: 100,
      reason: 'Explicit test credit',
      idempotencyKey: randomUUID(),
    };
    const before = await member.request('GET', '/sparks/wallet');
    const demo = await member.request('GET', '/wallet');
    const dreams = (await member.request('GET', '/currencies/wallet')).dreams;
    assert.equal(before.balanceSubunits, '0');
    assert.equal(dreams.balanceSubunits, '500000');
    await t.test('authorization and bounded exact whole-Spark input', async () => {
      await member.request('POST', '/admin/credits', grant, 403);
      for (const amount of [0, 0.1, 922337203685478, Number.MAX_SAFE_INTEGER])
        await admin.request('POST', '/admin/credits', { ...grant, amount }, 400);
      await admin.request('POST', '/admin/credits', { ...grant, userId: randomUUID() }, 404);
      assert.deepEqual(await member.request('GET', '/sparks/wallet'), before);
    });
    await t.test(
      'unverified Dreams recipient retains the existing admin funding safeguard',
      async () => {
        const pending = await session();
        await pool.query(
          'UPDATE users SET starter_sparks_eligible=false,starter_dreams_eligible=true,email_verified=false WHERE id=$1',
          [pending.user.id],
        );
        const before = await pending.request('GET', '/sparks/wallet');
        const result = await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, userId: pending.user.id, idempotencyKey: randomUUID() },
          409,
        );
        assert.equal(result.code, 'SPARKS_RECIPIENT_VERIFICATION_REQUIRED');
        assert.deepEqual(await pending.request('GET', '/sparks/wallet'), before);
      },
    );
    await t.test(
      'parallel identical retries create exactly one ledger and audit entry',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 3 }, () => admin.request('POST', '/admin/credits', grant, 201)),
        );
        for (const r of results) {
          assert.equal(r.ownerId, member.user.id);
          assert.equal(r.balanceSubunits, (BigInt(before.balanceSubunits) + 1000000n).toString());
          assert.equal(r.enabled, true);
        }
        assert.equal(
          (
            await pool.query('SELECT count(*) FROM spark_ledger WHERE event_key=$1', [
              `admin-adjust:v1:${grant.idempotencyKey}`,
            ])
          ).rows[0].count,
          '1',
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM audit WHERE action='sparks.adjust' AND details->>'idempotencyKey'=$1",
              [grant.idempotencyKey],
            )
          ).rows[0].count,
          '1',
        );
        assert.deepEqual(await member.request('GET', '/wallet'), demo);
        assert.deepEqual((await member.request('GET', '/currencies/wallet')).dreams, dreams);
        await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, reason: 'Different reason' },
          409,
        );
        await admin.request('POST', '/admin/credits', { ...grant, userId: admin.user.id }, 409);
      },
    );
    await t.test('fractional held subunits cannot be deducted and failure is atomic', async () => {
      await pool.query(
        'UPDATE spark_wallets SET held_subunits=balance_subunits-5000 WHERE owner_id=$1',
        [member.user.id],
      );
      const held = await member.request('GET', '/sparks/wallet');
      await admin.request(
        'POST',
        '/admin/credits',
        { ...grant, amount: -1, idempotencyKey: randomUUID() },
        409,
      );
      assert.deepEqual(await member.request('GET', '/sparks/wallet'), held);
      await pool.query('UPDATE spark_wallets SET held_subunits=0 WHERE owner_id=$1', [
        member.user.id,
      ]);
    });
    await t.test('audit failure rolls back ledger, wallet and activation together', async () => {
      const id = member.user.id;
      const saved = await member.request('GET', '/sparks/wallet');
      await pool.query(
        `CREATE FUNCTION test_reject_sparks_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sparks.adjust' AND NEW.target_id='${id}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        'CREATE TRIGGER test_reject_sparks_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION test_reject_sparks_audit()',
      );
      try {
        await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, idempotencyKey: randomUUID() },
          500,
        );
        assert.deepEqual(await member.request('GET', '/sparks/wallet'), saved);
      } finally {
        await pool.query('DROP TRIGGER test_reject_sparks_audit ON audit');
        await pool.query('DROP FUNCTION test_reject_sparks_audit()');
      }
    });
    await t.test(
      'explicit adjustment creates a missing wallet without converting legacy funds',
      async () => {
        const id = randomUUID(),
          handle = `old_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        await pool.query(
          "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'unused','Legacy',$3)",
          [id, `${handle}@example.test`, handle],
        );
        await pool.query('INSERT INTO wallets(user_id,balance) VALUES($1,12345)', [id]);
        await pool.query(
          'UPDATE users SET starter_sparks_eligible=true,email_verification_required=true WHERE id=$1',
          [id],
        );
        await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, userId: id, amount: 7, idempotencyKey: randomUUID() },
          409,
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM spark_wallets WHERE owner_id=$1', [id])).rows[0]
            .count,
          '0',
        );
        await pool.query(
          'UPDATE users SET starter_sparks_eligible=false,email_verification_required=false WHERE id=$1',
          [id],
        );
        await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, userId: id, amount: -1, idempotencyKey: randomUUID() },
          409,
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM spark_wallets WHERE owner_id=$1', [id])).rows[0]
            .count,
          '0',
        );
        const r = await admin.request(
          'POST',
          '/admin/credits',
          { ...grant, userId: id, amount: 7, idempotencyKey: randomUUID() },
          201,
        );
        assert.equal(r.balanceSubunits, '70000');
        assert.equal(r.enabled, true);
        assert.equal(r.ledger.length, 1);
        assert.equal(r.ledger[0].kind, 'admin_credit');
        assert.equal(
          (await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [id])).rows[0].balance,
          12345,
        );
      },
    );
  } finally {
    await pool.end();
  }
});
