process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { HttpException } = require('@nestjs/common');
const {
  OwnerSettlementsController,
} = require('../../apps/api/dist/generation/owner-settlements.controller');
function fixture() {
  const owner = randomUUID();
  const rows = [],
    calls = [];
  const read = async (kind, ...args) => {
    calls.push({ kind, args });
    const row = rows.find((r) => (r.authoring_jobs ?? r.npc_jobs)?.[0]?.jobId === args.at(-1));
    if (row.reject) throw new HttpException({}, row.reject);
    return { holdId: row.id, settlementMode: 'legacy_confirmation' };
  };
  const db = {
    query: async (sql, args) => {
      calls.push({ kind: 'sql', sql, args });
      return rows;
    },
  };
  const controller = new OwnerSettlementsController(
    db,
    { require: async () => ({ id: owner }) },
    { handle: (...args) => read('npc', ...args) },
    { handle: (...args) => read('authoring', ...args) },
  );
  const entry = (kind) => ({
    id: randomUUID(),
    status: 'pending',
    reason: 'failure_policy_pending',
    reserved_subunits: '1234',
    [kind === 'authoring' ? 'authoring_jobs' : 'npc_jobs']: [
      { kind, jobId: randomUUID(), campaignId: kind === 'npc' ? randomUUID() : null },
    ],
  });
  return { owner, rows, calls, controller, entry };
}
test('discovery is authenticated, bounded, read-only, and routes historical IDs through full owner proof', async () => {
  const f = fixture();
  f.rows.push(f.entry('authoring'), f.entry('npc'));
  const result = await f.controller.list({});
  assert.equal(result.ownerId, f.owner);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(
    result.entries.map((x) => x.state),
    ['verified', 'verified'],
  );
  assert.deepEqual(f.calls[0].args, [f.owner, null]);
  assert.match(f.calls[0].sql, /h.owner_id=\$1/);
  assert.match(f.calls[0].sql, /LIMIT 11/);
  assert.doesNotMatch(f.calls[0].sql, /UPDATE|INSERT|DELETE|FOR UPDATE/);
  assert.equal(f.calls[1].args[0], f.owner);
  assert.equal(f.calls[2].args[1], f.rows[1].npc_jobs[0].campaignId);
});
test('unknown, held, duplicate lineage, and unavailable proof never expose a confirm route', async () => {
  const f = fixture();
  const unknown = f.entry('npc');
  unknown.reason = 'unknown';
  const active = f.entry('npc');
  active.status = 'held';
  const duplicate = f.entry('authoring');
  duplicate.authoring_jobs.push(duplicate.authoring_jobs[0]);
  const invalid = f.entry('npc');
  invalid.reject = 409;
  f.rows.push(unknown, active, duplicate, invalid);
  const result = await f.controller.list({});
  assert.deepEqual(
    result.entries.map((x) => x.state),
    ['unavailable', 'active', 'unavailable', 'unavailable'],
  );
  assert.ok(result.entries.every((x) => !x.jobId && !x.quote));
  assert.equal(f.calls.filter((x) => x.kind === 'npc').length, 1);
});
test('discovery validates cursor, paginates without proving an extra page, and does not mask database errors', async () => {
  const f = fixture();
  for (let i = 0; i < 11; i++) f.rows.push(f.entry('authoring'));
  const cursor = randomUUID(),
    result = await f.controller.list({}, cursor);
  assert.equal(result.entries.length, 10);
  assert.equal(result.nextCursor, f.rows[9].id);
  assert.equal(f.calls.filter((x) => x.kind === 'authoring').length, 10);
  await assert.rejects(f.controller.list({}, 'bad'));
  f.rows.splice(1);
  f.rows[0].reject = 500;
  await assert.rejects(f.controller.list({}));
});
