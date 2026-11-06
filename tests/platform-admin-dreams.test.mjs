/** Actual admin Dreams grants on disposable loopback services; never production/paid calls. */
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
      name: 'Dreams test',
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
test('Dreams issuance is authorized, atomic, idempotent and currency-isolated', async (t) => {
  try {
    const admin = await session(),
      otherAdmin = await session(),
      member = await session();
    await pool.query("UPDATE users SET role='admin' WHERE id=ANY($1::uuid[])", [
      [admin.user.id, otherAdmin.user.id],
    ]);
    const grant = {
      userId: member.user.id,
      amount: 7,
      reason: 'Explicit synthetic grant',
      idempotencyKey: randomUUID(),
    };
    const before = await member.request('GET', '/currencies/wallet');
    const demo = await member.request('GET', '/wallet');
    await t.test(
      'role, positive whole units, reason, strict payload and recipient are validated',
      async () => {
        await member.request('POST', '/admin/dreams', grant, 403);
        for (const amount of [0, -1, 0.1, 922337203685478, Number.MAX_SAFE_INTEGER])
          await admin.request('POST', '/admin/dreams', { ...grant, amount }, 400);
        await admin.request('POST', '/admin/dreams', { ...grant, reason: '  ' }, 400);
        await admin.request('POST', '/admin/dreams', { ...grant, currency: 'sparks' }, 400);
        await admin.request('POST', '/admin/dreams', { ...grant, userId: randomUUID() }, 404);
        assert.deepEqual(await member.request('GET', '/currencies/wallet'), before);
      },
    );
    await t.test(
      'concurrent retry commits one ledger and audit; changed actor/payload conflicts',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 3 }, () => admin.request('POST', '/admin/dreams', grant, 201)),
        );
        for (const r of results) {
          assert.equal(r.dreams.ownerId, member.user.id);
          assert.equal(
            r.dreams.balanceSubunits,
            (BigInt(before.dreams.balanceSubunits) + 70000n).toString(),
          );
          assert.equal(r.dreams.ledger[0].kind, 'admin_credit');
        }
        const counts = (
          await pool.query(
            `SELECT
        (SELECT count(*) FROM dream_ledger WHERE event_key=$1)::int AS ledger,
        (SELECT count(*) FROM audit WHERE action='dreams.credit' AND details->>'idempotencyKey'=$2)::int AS audit`,
            [`dream-admin-credit:v1:${grant.idempotencyKey}`, grant.idempotencyKey],
          )
        ).rows[0];
        assert.deepEqual(counts, { ledger: 1, audit: 1 });
        for (const patch of [{ amount: 8 }, { reason: 'Other reason' }, { userId: admin.user.id }])
          await admin.request('POST', '/admin/dreams', { ...grant, ...patch }, 409);
        await otherAdmin.request('POST', '/admin/dreams', grant, 409);
        const after = await member.request('GET', '/currencies/wallet');
        assert.deepEqual(after.sparks, before.sparks);
        assert.deepEqual(await member.request('GET', '/wallet'), demo);
        // The same raw key is independent for the existing Sparks endpoint.
        await admin.request('POST', '/admin/credits', grant, 201);
        assert.deepEqual((await member.request('GET', '/currencies/wallet')).dreams, after.dreams);
      },
    );
    await t.test(
      'held Dreams are preserved and balance overflow fails without mutation',
      async () => {
        await pool.query('UPDATE dream_wallets SET held_subunits=12345 WHERE owner_id=$1', [
          member.user.id,
        ]);
        const r = await admin.request(
          'POST',
          '/admin/dreams',
          { ...grant, idempotencyKey: randomUUID() },
          201,
        );
        assert.equal(r.dreams.heldSubunits, '12345');
        assert.equal(BigInt(r.dreams.balanceSubunits) - BigInt(r.dreams.availableSubunits), 12345n);
        await pool.query(
          'UPDATE dream_wallets SET balance_subunits=9223372036854775800 WHERE owner_id=$1',
          [member.user.id],
        );
        const saved = await member.request('GET', '/currencies/wallet');
        await admin.request(
          'POST',
          '/admin/dreams',
          { ...grant, amount: 1, idempotencyKey: randomUUID() },
          409,
        );
        assert.deepEqual(await member.request('GET', '/currencies/wallet'), saved);
      },
    );
    await t.test(
      'pending welcome gift, deleted and missing recipients cannot be funded',
      async () => {
        const pending = await session();
        await pool.query(
          'UPDATE users SET starter_dreams_eligible=true,email_verified=false WHERE id=$1',
          [pending.user.id],
        );
        const saved = await pending.request('GET', '/currencies/wallet');
        const result = await admin.request(
          'POST',
          '/admin/dreams',
          { ...grant, userId: pending.user.id, idempotencyKey: randomUUID() },
          409,
        );
        assert.equal(result.code, 'DREAMS_RECIPIENT_VERIFICATION_REQUIRED');
        assert.deepEqual(await pending.request('GET', '/currencies/wallet'), saved);
        await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [pending.user.id]);
        await admin.request(
          'POST',
          '/admin/dreams',
          { ...grant, userId: pending.user.id, idempotencyKey: randomUUID() },
          404,
        );
      },
    );
    await t.test(
      'audit failure rolls back missing wallet, activation and ledger together',
      async () => {
        const id = randomUUID(),
          handle = `old_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        await pool.query(
          "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'unused','Legacy',$3)",
          [id, `${handle}@example.test`, handle],
        );
        await pool.query(
          `CREATE FUNCTION test_reject_dreams_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='dreams.credit' AND NEW.target_id='${id}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
        );
        await pool.query(
          'CREATE TRIGGER test_reject_dreams_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION test_reject_dreams_audit()',
        );
        const body = { ...grant, userId: id, idempotencyKey: randomUUID() };
        try {
          await admin.request('POST', '/admin/dreams', body, 500);
          assert.equal(
            (await pool.query('SELECT count(*) FROM dream_wallets WHERE owner_id=$1', [id])).rows[0]
              .count,
            '0',
          );
          assert.equal(
            (await pool.query('SELECT count(*) FROM dream_ledger WHERE owner_id=$1', [id])).rows[0]
              .count,
            '0',
          );
        } finally {
          await pool.query('DROP TRIGGER test_reject_dreams_audit ON audit');
          await pool.query('DROP FUNCTION test_reject_dreams_audit()');
        }
        const r = await admin.request('POST', '/admin/dreams', body, 201);
        assert.equal(r.dreams.balanceSubunits, '70000');
        assert.equal(
          (await pool.query('SELECT enabled FROM dream_wallets WHERE owner_id=$1', [id])).rows[0]
            .enabled,
          true,
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM spark_wallets WHERE owner_id=$1', [id])).rows[0]
            .count,
          '0',
        );
        await assert.rejects(
          pool.query('UPDATE dream_ledger SET amount_subunits=80000 WHERE owner_id=$1', [id]),
          /immutable/,
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO dream_ledger(owner_id,event_key,kind,amount_subunits) VALUES($1,$2,'admin_credit',10000)",
            [id, randomUUID()],
          ),
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO dream_ledger(owner_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,'admin_credit',10000,$3)",
            [id, randomUUID(), JSON.stringify(['actorId', 'reason', 'amount', 'idempotencyKey'])],
          ),
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO dream_ledger(owner_id,event_key,kind,amount_subunits) VALUES($1,$2,'capture',10000)",
            [id, randomUUID()],
          ),
        );
      },
    );
  } finally {
    await pool.end();
  }
});
