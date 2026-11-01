import { cleanupManualLiveFixture } from './manual-live-fixture-cleanup.mjs';
import { purgeManualLiveData } from '../../scripts/manual-live-data-requests.mjs';
/** Disposable PostgreSQL, injected providers only: this suite never loads credentials or OpenAI transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');
const { ManualLiveProvider } = require('../../apps/api/dist/live-test/provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { ProviderFailure } = require('../../apps/api/dist/ai/types.js');
const { LIVE_TEXT } = require('../../apps/api/dist/live-test/config.js');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget.js');
const database = {
  query: async (sql, values = []) => (await db.query(sql, values)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const v = await work(c);
      await c.query('COMMIT');
      return v;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
await test(
  'finite manual session shares text/image cap and enforces phase, owner, idempotency and unknown stop',
  { timeout: 30000 },
  async (t) => {
    const owner = randomUUID(),
      other = randomUUID(),
      sessionId = randomUUID(),
      campaignId = randomUUID();
    for (const id of [owner, other])
      await db.query(
        'INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)',
        [id, `${id}@example.test`, 'synthetic-no-login', 'Synthetic', `test_${id}`],
      );
    const configuration = {
      enabled: true,
      sessionId,
      ownerId: owner,
      expiresAt: new Date(Date.now() + 3600000),
    };
    const live = new LiveTestService(database, configuration);
    const fence = { roundId: 'fixture-round', phaseEpoch: 2, rulesetVersion: 1 };
    const state = {
      turnController: {
        phase: 'player',
        roundId: fence.roundId,
        phaseEpoch: fence.phaseEpoch,
        ruleset: { version: 1 },
      },
    };
    await db.query(
      "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
      [campaignId, owner, JSON.stringify(state)],
    );
    await db.query(
      "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
      [campaignId, owner],
    );
    const requests = [];
    for (let i = 0; i < 12; i++) {
      const id = randomUUID(),
        context = {
          contextHash: `fixture-${i}`,
          turnFence: fence,
          mockProposal: { actions: [{ kind: 'wait' }] },
        };
      await db.query(
        "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,status) VALUES($1,$2,$3,'plan',$4,$5,'queued')",
        [id, campaignId, `npc_${i}`, id, JSON.stringify(context)],
      );
      requests.push({ id, context, npcId: `npc_${i}` });
    }
    const input = () => ({
      sessionId,
      operationId: randomUUID(),
      turnFence: fence,
      consent: true,
    });
    await t.test('only configured owner claims the immutable expiring grant', async () => {
      await assert.rejects(live.claim(other, { consent: true }), /FORBIDDEN/);
      const status = await live.claim(owner, { consent: true });
      assert.equal(status.capMicros, 1000000);
      assert.equal(status.imagesEnabled, false);
      assert.equal(status.usedMicros, 0);
      assert.equal((await live.claim(owner, { consent: true })).sessionId, sessionId);
      const changed = new LiveTestService(database, {
        ...configuration,
        expiresAt: new Date(configuration.expiresAt.getTime() + 1000),
      });
      await assert.rejects(changed.claim(owner, { consent: true }), /LIVE_GRANT_IMMUTABLE/);
    });
    await t.test('player phase and stale world fences cannot reserve or dispatch', async () => {
      await assert.rejects(
        live.consent(owner, campaignId, requests[0].id, input()),
        /LIVE_WORLD_PHASE_REQUIRED/,
      );
      state.turnController.phase = 'world';
      await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
        campaignId,
        JSON.stringify(state),
      ]);
      await assert.rejects(
        live.consent(owner, campaignId, requests[0].id, {
          ...input(),
          turnFence: { ...fence, phaseEpoch: 99 },
        }),
        /TURN_PHASE_STALE/,
      );
      assert.equal((await live.status(owner)).heldMicros, 0);
    });
    await t.test('concurrent text and image reservations use one serialized $1 limit', async () => {
      const policy = await database.tx((c) => live.authorizeImage(c, owner, sessionId));
      const image = await database.tx((c) =>
        reserveGenerationSpend(
          c,
          { ...policy, verifiedUpperMicros: 500000 },
          owner,
          'image',
          'fixture-image',
          500000,
        ),
      );
      const results = await Promise.allSettled([
        live.consent(owner, campaignId, requests[0].id, input()),
        live.consent(owner, campaignId, requests[1].id, input()),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      assert.equal((await live.status(owner)).usedMicros, 500000 + LIVE_TEXT.upperMicros);
      await database.tx((c) => settleGenerationSpend(c, image, 0));
      const permit = results.find((r) => r.status === 'fulfilled').value;
      await live.complete(permit.id, 0, 'SYNTHETIC_UNDISPATCHED');
    });
    await t.test(
      'approved estimate-risk profile serializes text and images across the stored shared scope',
      async () => {
        const exclusive = new LiveTestService(database, {
          ...configuration,
          estimateRiskApproved: true,
        });
        await exclusive.claim(owner, { consent: true });
        const results = await Promise.allSettled([
          live.consent(owner, campaignId, requests[6].id, input()),
          live.consent(owner, campaignId, requests[7].id, input()),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
        const policy = await database.tx((c) => live.authorizeImage(c, owner, sessionId));
        await assert.rejects(
          database.tx((c) =>
            reserveGenerationSpend(
              c,
              { ...policy, verifiedUpperMicros: 500000 },
              owner,
              'image',
              'exclusive-image',
              100000,
            ),
          ),
          /GENERATION_OUTSTANDING/,
        );
        const permit = results.find((r) => r.status === 'fulfilled').value;
        await live.complete(permit.id, 0, 'SYNTHETIC_UNDISPATCHED');
      },
    );
    let calls = 0,
      mode = 'success';
    const inner = {
      id: 'synthetic-manual-provider',
      version: 'synthetic-v1',
      external: true,
      generate: async (r) => {
        calls++;
        if (mode === '403') throw new ProviderFailure('PROVIDER_HTTP_403', true, 'synthetic-403');
        return {
          requestId: `fixture-${calls}`,
          proposal: r.context.mockProposal,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 5000,
            costEvidence: 'configured_rates',
          },
        };
      },
    };
    const provider = new ManualLiveProvider(inner, live);
    const ai = new NpcAiEngine(database, provider, {
      externalApproved: true,
      providerUpperMicros: LIVE_TEXT.upperMicros,
      providerCapMicros: 1000000,
      timeoutMs: 1000,
    });
    async function queue(r) {
      return ai.queue({
        scope: { campaignId, npcId: r.npcId, origin: 'system', purpose: 'plan' },
        operationId: r.id,
        context: r.context,
        runtimeRequestId: r.id,
      });
    }
    await t.test(
      'idle prepared job makes zero calls; exact manual consent permits one dispatch',
      async () => {
        const r = requests[2],
          job = await queue(r);
        await ai.run(job.id, async () => true);
        assert.equal(calls, 0);
        const consent = input();
        const first = await live.consent(owner, campaignId, r.id, consent);
        const replay = await live.consent(owner, campaignId, r.id, consent);
        assert.equal(first.id, replay.id);
        await ai.run(job.id, async () => true);
        await ai.run(job.id, async () => true);
        assert.equal(calls, 1);
        const status = await live.status(owner);
        assert.equal(status.usedMicros, 5000);
        assert.equal(status.heldMicros, 0);
      },
    );
    await t.test(
      'stale phase cancels unsent authorization and releases its shared reservation',
      async () => {
        const r = requests[3],
          job = await queue(r);
        await live.consent(owner, campaignId, r.id, input());
        state.turnController.phaseEpoch++;
        await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
          campaignId,
          JSON.stringify(state),
        ]);
        await ai.run(job.id, async () => true);
        assert.equal(calls, 1);
        assert.equal((await live.status(owner)).heldMicros, 0);
        state.turnController.phaseEpoch = fence.phaseEpoch;
        await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
          campaignId,
          JSON.stringify(state),
        ]);
      },
    );
    await t.test(
      'only unqueued authorized NPC reservations can be refunded after a known failure',
      async () => {
        const unsent = requests[8];
        const permit = await live.consent(owner, campaignId, unsent.id, input());
        assert.equal(
          await database.tx((c) =>
            live.rejectUndispatchedRequest(c, unsent.id, 'CONTEXT_BUDGET_EXCEEDED'),
          ),
          true,
        );
        assert.equal((await live.status(owner)).heldMicros, 0);
        assert.equal(
          (await db.query('SELECT state FROM live_test_text_permits WHERE id=$1', [permit.id]))
            .rows[0].state,
          'cancelled',
        );
        const linked = requests[9],
          job = await queue(linked);
        await live.consent(owner, campaignId, linked.id, input());
        assert.equal(
          await database.tx((c) =>
            live.rejectUndispatchedRequest(c, linked.id, 'QUEUE_UNAVAILABLE'),
          ),
          false,
        );
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        await database.tx((c) => ai.finalize(c, job.id, 'cancelled'));
        assert.equal((await live.status(owner)).heldMicros, 0);
        assert.equal(calls, 1);
        await db.query(
          "UPDATE game_npc_decision_requests SET context=jsonb_set(context,'{budgetExceeded}','true') WHERE id=$1",
          [requests[10].id],
        );
        await assert.rejects(
          live.consent(owner, campaignId, requests[10].id, input()),
          /CONTEXT_BUDGET_EXCEEDED/,
        );
        assert.equal((await live.status(owner)).heldMicros, 0);
      },
    );
    await t.test(
      '403 preserves unknown full reserve, stops whole session and never retries',
      async () => {
        const r = requests[4],
          job = await queue(r);
        await live.consent(owner, campaignId, r.id, input());
        mode = '403';
        await ai.run(job.id, async () => true);
        await ai.run(job.id, async () => true);
        assert.equal(calls, 2);
        const status = await live.status(owner);
        assert.equal(status.state, 'stopped');
        assert.equal(status.stopCode, 'PROVIDER_HTTP_403');
        assert.equal(status.heldMicros, LIVE_TEXT.upperMicros);
        assert.equal(
          await database.tx((c) => live.rejectUndispatchedRequest(c, r.id, 'LATE_QUEUE_FAILURE')),
          false,
        );
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        await assert.rejects(
          live.consent(owner, campaignId, requests[5].id, input()),
          /LIVE_SESSION_STOPPED/,
        );
        assert.equal((await live.claim(owner, { consent: true })).state, 'stopped');
        const receipt = (
          await db.query('SELECT * FROM live_test_text_permits WHERE request_id=$1', [r.id])
        ).rows[0];
        assert.equal(receipt.state, 'unknown');
        await database.tx((c) => purgeManualLiveData(c, owner, [{ id: campaignId }]));
        await db.query('DELETE FROM game_npc_decision_requests WHERE campaign_id=$1', [campaignId]);
        const erased = (
          await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [receipt.id])
        ).rows[0];
        assert.equal(erased.request_id, null);
        assert.equal(erased.context_hash, 'erased');
        assert.equal(erased.state, 'unknown');
        assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
        const lateActual = LIVE_TEXT.upperMicros + 123;
        await ai.reconcile(job.id, randomUUID(), lateActual);
        const reconciled = await live.status(owner);
        assert.equal(reconciled.usedMicros, 5000 + lateActual);
        assert.equal(reconciled.heldMicros, 0);
        assert.equal(reconciled.state, 'stopped');
        await live.complete(
          receipt.id,
          lateActual,
          'PROVIDER_RESULT',
          'late-receipt-must-remain-private',
        );
        const lateErased = (
          await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [receipt.id])
        ).rows[0];
        assert.equal(lateErased.provider_request_id, null);
        assert.equal(lateErased.result_code, 'DATA_ERASED');
      },
    );
    await cleanupManualLiveFixture(db, sessionId, owner, LIVE_TEXT.scopeId);
    await db.end();
  },
);
