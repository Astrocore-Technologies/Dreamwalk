/** Persisted turn-fence checks before any provider call; synthetic local transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const database = {
  query: async (sql, values = []) => (await db.query(sql, values)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const value = await work(c);
      await c.query('COMMIT');
      return value;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  },
};
await test(
  'provider queue and dispatch require persisted current world round/phase fences',
  { timeout: 30000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register();
      const { campaignId } = await owner.request('/game/campaigns', {
        template: 'observatory-v1',
        turnBased: true,
      });
      await stopApi();
      let state = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0].state;
      let calls = 0;
      const provider = {
        id: `turn-fence-${randomUUID()}`,
        version: 'fixture-v1',
        external: false,
        generate: async (request) => {
          calls++;
          return {
            proposal: request.context.mockProposal,
            requestId: randomUUID(),
            usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          };
        },
      };
      const engine = new NpcAiEngine(database, provider, {
        creditPrice: 0,
        providerUpperMicros: 0,
        providerCapMicros: 0,
      });
      const scope = {
        campaignId,
        npcId: 'keeper',
        origin: 'user',
        purpose: 'plan',
        requesterUserId: owner.user.id,
      };
      const context = () => ({
        contextHash: `fixture-${randomUUID()}`,
        turnFence: {
          roundId: state.turnController.roundId,
          phaseEpoch: state.turnController.phaseEpoch,
          rulesetVersion: 1,
        },
        mockProposal: { actions: [{ kind: 'wait' }] },
      });
      await t.test(
        'player-phase queue fails before a budget hold or job can be created',
        async () => {
          await assert.rejects(
            engine.queue({ scope, operationId: randomUUID(), context: context() }),
            (error) => error?.getResponse?.().code === 'TURN_PHASE_STALE',
          );
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1', [
                campaignId,
              ])
            ).rows[0].n,
            0,
          );
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'a phase change after durable reservation prevents dispatch and retains an idempotent stale receipt',
        async () => {
          state.turnController.phase = 'world';
          state.turnController.activeActorId = null;
          state.turnController.phaseEpoch++;
          await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
            campaignId,
            JSON.stringify(state),
          ]);
          const request = { scope, operationId: randomUUID(), context: context() };
          const job = await engine.queue(request);
          state.turnController.phaseEpoch++;
          await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
            campaignId,
            JSON.stringify(state),
          ]);
          await engine.runNext(campaignId, async () => true);
          const row = (
            await db.query(
              'SELECT status,provider_request_id,provider_actual_micros FROM npc_ai_jobs WHERE id=$1',
              [job.id],
            )
          ).rows[0];
          assert.equal(row.status, 'stale');
          assert.equal(row.provider_request_id, null);
          assert.equal(calls, 0);
          assert.equal((await engine.queue(request)).id, job.id);
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
