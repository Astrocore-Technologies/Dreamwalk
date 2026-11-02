/** Real isolated PG queue/dispatch fences; the synthetic transport must never run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
test(
  'changed presentation fences reserved speech, narrative and story before transport',
  { timeout: 90000 },
  async () => {
    const database = new Db();
    try {
      await startApi();
      const user = await client().registerLegacyFixture();
      const source = await user.request('/adventures/old-observatory?view=published');
      const { campaignId } = await user.request('/game/campaigns', {
        playableVersionId: source.playableVersionId,
        turnBased: false,
      });
      await stopApi();
      let calls = 0;
      const engine = new NpcAiEngine(database, {
        id: `no-dispatch-${randomUUID()}`,
        version: 'v1',
        external: false,
        generate: async () => {
          calls++;
          throw new Error('must not dispatch');
        },
      });
      const actor = `player-${user.user.id}`;
      for (const stage of ['reserved', 'claimed'])
        for (const purpose of ['speech', 'narrative', 'story_turn']) {
          // Legacy unset preferences must also be fenced on the first saved revision.
          await db.query(
            "UPDATE game_campaigns SET state=state-'narrativePreferences' WHERE id=$1",
            [campaignId],
          );
          const scope = {
            campaignId,
            npcId: purpose === 'speech' ? 'keeper' : actor,
            subjectKind: purpose === 'speech' ? 'npc' : 'player',
            origin: 'user',
            requesterUserId: user.user.id,
            purpose,
          };
          const context = {
            contextHash: randomUUID(),
            ...(purpose === 'speech' ? { recipientId: actor } : { actorId: actor }),
            mockProposal: {},
          };
          const quote = await engine.quote(scope, context, user.user.id);
          const job = await engine.queue({
            scope,
            operationId: randomUUID(),
            context,
            quoteId: quote.id,
            consent: true,
          });
          const preferences = {
            [actor]: {
              revision: 1,
              settings: { detail: 'concise', formOfAddress: 'they', dialogueFormat: 'quoted' },
            },
          };
          const change = () =>
            db.query(
              "UPDATE game_campaigns SET state=jsonb_set(state,'{narrativePreferences}',$2::jsonb) WHERE id=$1",
              [campaignId, JSON.stringify(preferences)],
            );
          if (stage === 'reserved') await change();
          let activeChecks = 0;
          await engine.run(job.id, async () => {
            activeChecks++;
            if (stage === 'claimed' && activeChecks === 2) await change();
            return true;
          });
          assert.equal(activeChecks, stage === 'reserved' ? 1 : 2);
          const saved = (
            await db.query('SELECT status,reservation_status FROM npc_ai_jobs WHERE id=$1', [
              job.id,
            ])
          ).rows[0];
          assert.equal(saved.status, 'stale', purpose);
          assert.notEqual(saved.reservation_status, 'held', purpose);
          assert.equal(calls, 0, purpose);
        }
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
