/** Durable private-authoring spending tests. Injected providers only; no key file or OpenAI transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from './support-runtime.mjs';
import {
  lockManualLiveData,
  purgeManualLiveData,
} from '../../scripts/manual-live-data-requests.mjs';
import { cleanupManualLiveFixture } from './manual-live-fixture-cleanup.mjs';
const require = createRequire(import.meta.url);
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');
const { LIVE_TEXT } = require('../../apps/api/dist/live-test/config.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const { reserveGenerationSpend } = require('../../apps/api/dist/image-generation/budget.js');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const database = {
  query: async (sql, v = []) => (await db.query(sql, v)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const value = await work(c);
      await c.query('COMMIT');
      return value;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
// A broken barrier must fail and release the held transaction, not strand suite cleanup.
async function bounded(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitForBlockedRival(blockerPid) {
  const deadline = Date.now() + 5000;
  do {
    const rows = (
      await db.query(
        'SELECT pid,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid)) ORDER BY pid',
        [blockerPid],
      )
    ).rows;
    if (rows.length) {
      assert.equal(rows.length, 1, 'Only the competing request is blocked in this isolated test');
      assert.notEqual(rows[0].pid, blockerPid);
      assert.equal(rows[0].wait_event_type, 'Lock');
      return rows[0].pid;
    }
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail('The competing request did not reach the held database lock');
}
await test(
  'private authoring uses one durable manual grant without world or NPC fences',
  { timeout: 30000 },
  async (t) => {
    const owner = randomUUID(),
      sessionId = randomUUID(),
      projectId = randomUUID();
    await db.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
      owner,
      `${owner}@example.test`,
      'synthetic-no-login',
      'Author',
      `a_${owner}`,
    ]);
    const sourceHash = digest('synthetic-source'),
      readsetHash = digest('synthetic-readset');
    await db.query(
      "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
      [
        projectId,
        owner,
        JSON.stringify({ name: 'Private fixture', description: 'Synthetic private description' }),
        sourceHash,
      ],
    );
    const live = new LiveTestService(database, {
      enabled: true,
      sessionId,
      ownerId: owner,
      expiresAt: new Date(Date.now() + 3600000),
    });
    await live.claim(owner, { consent: true });
    t.after(async () => {
      await cleanupManualLiveFixture(db, sessionId, owner, LIVE_TEXT.scopeId);
    });
    let calls = 0,
      commits = 0,
      mode = 'success',
      pending = null,
      started = null;
    const definition = {
      version: 'synthetic-layout-v1',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      instructions: 'Return one synthetic layout.',
      validateProposal: (p) => {
        if (!p || typeof p.title !== 'string') throw new Error('invalid');
        return { title: p.title };
      },
    };
    const result = (cost = 5000, proposal = { title: 'Validated private proposal' }) => ({
      proposal,
      requestId: `synthetic-request-${calls}`,
      usage: { inputTokens: 10, outputTokens: 10, costMicros: cost, costEvidence: 'reported' },
    });
    const provider = {
      version: 'synthetic-authoring-v1',
      generate: async () => {
        calls++;
        if (mode === 'deferred') {
          started.resolve();
          return pending.promise;
        }
        if (mode === 'invalid') return result(1000, { unsupported: true });
        return result();
      },
    };
    const engine = new AuthoringTextEngine(database, live, provider, definition, 2000);
    const guard = async (c, b) => {
      const row = (
        await c.query(
          'SELECT * FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [b.projectId, owner],
        )
      ).rows[0];
      if (
        !row ||
        row.revision !== b.projectRevision ||
        row.source_hash !== b.sourceHash ||
        b.readsetHash !== readsetHash
      )
        throw new Error('STALE_PROJECT');
    };
    const commit = async (_c, _binding, p) => {
      commits++;
      return { proposalId: randomUUID(), title: p.title };
    };
    const binding = async () => ({
      sessionId,
      projectId,
      projectRevision: (
        await db.query('SELECT revision FROM visual_authoring_projects WHERE id=$1', [projectId])
      ).rows[0].revision,
      sourceHash,
      readsetHash,
    });
    const quote = async () =>
      engine.quote(
        owner,
        {
          ...(await binding()),
          operationId: randomUUID(),
          context: {
            brief: { name: 'Private fixture', description: 'Synthetic private description' },
          },
        },
        guard,
      );
    const enqueue = async () => {
      const q = await quote();
      return engine.enqueue(
        owner,
        { quoteId: q.id, operationId: randomUUID(), consent: true },
        guard,
      );
    };
    await t.test(
      'quote is free, explicit enqueue is idempotent and shared text/image reservations exclude one another',
      async () => {
        const q = await quote();
        assert.equal(calls, 0);
        assert.equal((await live.status(owner)).heldMicros, 0);
        const op = randomUUID();
        await assert.rejects(
          engine.enqueue(owner, { quoteId: q.id, operationId: op, consent: false }, guard),
        );
        const [job, concurrentReplay] = await Promise.all([
          engine.enqueue(owner, { quoteId: q.id, operationId: op, consent: true }, guard),
          engine.enqueue(owner, { quoteId: q.id, operationId: op, consent: true }, guard),
        ]);
        assert.equal(job.id, concurrentReplay.id);
        assert.equal(
          (await engine.enqueue(owner, { quoteId: q.id, operationId: op, consent: true }, guard))
            .id,
          job.id,
        );
        const policy = await database.tx((c) => live.authorizeText(c, owner, sessionId));
        for (const kind of ['text', 'image'])
          await assert.rejects(
            database.tx((c) =>
              reserveGenerationSpend(c, policy, owner, kind, `concurrent-${kind}`, 100000),
            ),
            /GENERATION_OUTSTANDING_REQUEST/,
          );
        await engine.cancel(owner, job.id);
        assert.equal((await live.status(owner)).heldMicros, 0);
        assert.equal(calls, 0);
      },
    );
    await t.test('image-owner lock precedes session/project locks', async () => {
      const held = deferred(),
        release = deferred();
      const image = database.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `art-owner:${owner}`,
        ]);
        await c.query('SELECT id FROM visual_authoring_projects WHERE id=$1 FOR UPDATE', [
          projectId,
        ]);
        held.resolve();
        await release.promise;
        await live.authorizeText(c, owner, sessionId);
      });
      await held.promise;
      const planner = quote();
      await delay(20);
      release.resolve();
      await Promise.all([image, planner]);
      assert.equal(calls, 0);
    });
    await t.test('concurrent retries preserve the first dispatched paid request', async () => {
      const job = await enqueue();
      mode = 'deferred';
      pending = deferred();
      started = deferred();
      const inside = deferred(),
        release = deferred();
      let blockerPid, first, rival;
      try {
        first = engine.run(
          owner,
          job.id,
          async (c, b) => {
            blockerPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            inside.resolve();
            await release.promise;
            await guard(c, b);
          },
          commit,
        );
        await bounded(inside.promise, 'first request entered its locked fence');
        rival = engine.run(
          owner,
          job.id,
          async () => {
            throw new Error('new stale project');
          },
          commit,
        );
        // Observe actual PostgreSQL contention, not the spelling/count of job reads.
        await bounded(waitForBlockedRival(blockerPid), 'rival waiting on first request');
        release.resolve();
        await bounded(started.promise, 'single provider dispatch');
        await bounded(rival, 'rival rechecks the stored dispatched job');
        assert.equal((await engine.get(owner, job.id)).status, 'dispatched');
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        pending.resolve(result());
        const done = await bounded(first, 'first request committed');
        assert.equal(done.status, 'committed');
        assert.equal(commits, 1);
        assert.equal(calls, 1);
        await engine.run(owner, job.id, guard, commit);
        assert.equal(calls, 1);
      } finally {
        release.resolve();
        pending.resolve(result());
        await bounded(Promise.allSettled([first, rival].filter(Boolean)), 'race cleanup', 7000);
      }
    });
    await t.test('editing after quote prevents a reservation or provider call', async () => {
      mode = 'success';
      const q = await quote();
      await db.query('UPDATE visual_authoring_projects SET revision=revision+1 WHERE id=$1', [
        projectId,
      ]);
      await assert.rejects(
        engine.enqueue(owner, { quoteId: q.id, operationId: randomUUID(), consent: true }, guard),
        /STALE_PROJECT/,
      );
      assert.equal(calls, 1);
      assert.equal((await live.status(owner)).heldMicros, 0);
    });
    await t.test(
      'editing during provider work discards the proposal but retains known cost',
      async () => {
        const job = await enqueue();
        mode = 'deferred';
        pending = deferred();
        started = deferred();
        const running = engine.run(owner, job.id, guard, commit);
        await started.promise;
        await db.query('UPDATE visual_authoring_projects SET revision=revision+1 WHERE id=$1', [
          projectId,
        ]);
        pending.resolve(result(3000));
        const done = await running;
        assert.equal(done.status, 'stale');
        assert.equal(done.result, null);
        assert.equal(commits, 1);
        assert.equal((await live.status(owner)).usedMicros, 8000);
      },
    );
    await t.test(
      'invalid model layout is a paid failure without automatic fallback or retry',
      async () => {
        mode = 'invalid';
        const job = await enqueue();
        const done = await engine.run(owner, job.id, guard, commit);
        assert.equal(done.status, 'failed');
        assert.equal(done.errorCode, 'AUTHORING_PROPOSAL_INVALID');
        assert.equal(commits, 1);
        assert.equal((await live.status(owner)).usedMicros, 9000);
      },
    );
    await t.test(
      'cancel during dispatch retains the hold until its known result, and never commits',
      async () => {
        const job = await enqueue();
        mode = 'deferred';
        pending = deferred();
        started = deferred();
        const running = engine.run(owner, job.id, guard, commit);
        await started.promise;
        await engine.cancel(owner, job.id);
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        pending.resolve(result(2000));
        const done = await running;
        assert.equal(done.status, 'cancelled');
        assert.equal(done.result, null);
        assert.equal(commits, 1);
        assert.equal((await live.status(owner)).usedMicros, 11000);
      },
    );
    await t.test(
      'restart admits a stored paid proposal without another provider call',
      async () => {
        const job = await enqueue();
        const callsBefore = calls;
        await database.tx(async (c) => {
          const row = (
            await c.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [job.id])
          ).rows[0];
          await live.settleLiveSpend(c, sessionId, row.reservation_id, 1000, 'AUTHORING_RESULT');
          await c.query(
            "UPDATE live_authoring_text_jobs SET status='generated',proposal=$2,actual_micros=1000,dispatched_at=now()-interval '61 seconds',deadline_at=now()-interval '1 second',completed_at=now()-interval '2 seconds' WHERE id=$1",
            [job.id, JSON.stringify({ title: 'Persisted validated private proposal' })],
          );
        });
        const restarted = new AuthoringTextEngine(database, live, provider, definition, 2000);
        const restored = await restarted.run(owner, job.id, guard, commit);
        assert.equal(restored.status, 'committed');
        assert.equal(calls, callsBefore);
        assert.equal((await live.status(owner)).usedMicros, 12000);
        assert.equal(commits, 2);
      },
    );
    await t.test(
      'timeout and erasure keep unknown costs; late full usage cannot restore private content',
      async () => {
        const job = await enqueue();
        mode = 'deferred';
        pending = deferred();
        started = deferred();
        const bounded = new AuthoringTextEngine(database, live, provider, definition, 50);
        const running = bounded.run(owner, job.id, guard, commit);
        await started.promise;
        const unknown = await running;
        assert.equal(unknown.status, 'unknown');
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        await assert.rejects(quote(), /LIVE_SESSION_STOPPED/);
        const erasureLocked = deferred(),
          releaseErasure = deferred();
        const erasing = database.tx(async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `art-owner:${owner}`,
          ]);
          await lockManualLiveData(c, owner);
          await purgeManualLiveData(c, owner, []);
          erasureLocked.resolve();
          await releaseErasure.promise;
          await c.query('DELETE FROM visual_authoring_projects WHERE id=$1', [projectId]);
        });
        await erasureLocked.promise;
        const late = LIVE_TEXT.upperMicros + 123;
        pending.resolve(result(late));
        await delay(20);
        releaseErasure.resolve();
        await erasing;
        for (let i = 0; i < 40; i++) {
          const row = (
            await db.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [job.id])
          ).rows[0];
          if (Number(row.actual_micros) === late) break;
          await delay(10);
        }
        const row = (await db.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [job.id]))
          .rows[0];
        assert.equal(Number(row.actual_micros), late);
        assert.equal(row.context_hash, 'erased');
        assert.equal(row.provider_request_id, null);
        assert.equal(row.proposal, null);
        assert.equal(row.result, null);
        assert.equal(row.error_code, 'DATA_ERASED');
        assert.equal((await live.status(owner)).usedMicros, 12000 + late);
        assert.equal((await live.status(owner)).state, 'stopped');
        assert.equal(commits, 2);
      },
    );
  },
);
await test('erasing a foreign campaign participant preserves the budget owner private authoring', async (t) => {
  const owner = randomUUID(),
    foreign = randomUUID(),
    sessionId = randomUUID(),
    projectId = randomUUID(),
    campaignId = randomUUID();
  for (const id of [owner, foreign])
    await db.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
      id,
      `${id}@example.test`,
      'synthetic-only',
      'Synthetic',
      `p_${id}`,
    ]);
  const sourceHash = digest('private-owner-source'),
    readsetHash = digest('private-owner-readset');
  await db.query(
    "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
    [
      projectId,
      owner,
      JSON.stringify({ description: 'Unrelated owner private brief' }),
      sourceHash,
    ],
  );
  const live = new LiveTestService(database, {
    enabled: true,
    sessionId,
    ownerId: owner,
    expiresAt: new Date(Date.now() + 3600000),
  });
  await live.claim(owner, { consent: true });
  t.after(() => cleanupManualLiveFixture(db, sessionId, owner, LIVE_TEXT.scopeId));
  const definition = {
    version: 'private-fixture-v1',
    schema: {},
    instructions: 'Synthetic',
    validateProposal: (p) => p,
  };
  const engine = new AuthoringTextEngine(
    database,
    live,
    {
      version: 'private-fixture-v1',
      generate: async () => ({
        proposal: { title: 'Owner private result' },
        requestId: 'private-fixture-request',
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, costEvidence: 'reported' },
      }),
    },
    definition,
  );
  const binding = { sessionId, projectId, projectRevision: 1, sourceHash, readsetHash };
  const guard = async (c, b) => {
    if (
      !(
        await c.query(
          'SELECT id FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [b.projectId, owner],
        )
      ).rowCount
    )
      throw new Error('stale');
  };
  const quote = await engine.quote(
    owner,
    { ...binding, operationId: randomUUID(), context: { privateBrief: 'Owner private context' } },
    guard,
  );
  const job = await engine.enqueue(
    owner,
    { quoteId: quote.id, operationId: randomUUID(), consent: true },
    guard,
  );
  await engine.run(owner, job.id, guard, async () => ({
    proposalId: randomUUID(),
    privateResult: 'Owner private proposal',
  }));
  await db.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic','{}')",
    [campaignId, owner],
  );
  await db.query(
    "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'foreign-player','accepted')",
    [campaignId, foreign],
  );
  const requestId = randomUUID(),
    reservationId = randomUUID();
  await db.query(
    "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,'fixture-npc','speech',$4,$3,'{}')",
    [requestId, campaignId, foreign, requestId],
  );
  await db.query(
    "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,'text',$4,0,0,'settled')",
    [reservationId, LIVE_TEXT.scopeId, owner, `foreign-fixture-${requestId}`],
  );
  await db.query(
    "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state) VALUES($1,$2,$3,$4,$5,'foreign-private','foreign-round',1,$6,'settled')",
    [randomUUID(), sessionId, campaignId, requestId, randomUUID(), reservationId],
  );
  const before = (
    await db.query(
      'SELECT context,context_hash,proposal,result FROM live_authoring_text_jobs WHERE id=$1',
      [job.id],
    )
  ).rows[0];
  await database.tx((c) => purgeManualLiveData(c, foreign, [{ id: campaignId }]));
  const after = (
    await db.query(
      'SELECT context,context_hash,proposal,result FROM live_authoring_text_jobs WHERE id=$1',
      [job.id],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  assert.deepEqual(
    (await db.query('SELECT context FROM live_authoring_text_quotes WHERE id=$1', [quote.id]))
      .rows[0].context,
    { privateBrief: 'Owner private context' },
  );
  assert.equal((await live.status(owner)).state, 'stopped');
});

await db.end();
