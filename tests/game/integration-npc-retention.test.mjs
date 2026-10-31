/** Real disposable-PG retention/erasure acceptance. Never touches preview or external providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import { storyInput } from './support-authored.mjs';
import { db, startApi, stopApi, client, path } from './support-runtime.mjs';
import { purgeGameData, exportGameData } from '../../scripts/game-data-requests.mjs';
const require = createRequire(import.meta.url);
const {
  pruneNpcMemory,
  protectedNpcEvidence,
} = require('../../apps/api/dist/game/npc-retention.js');
const {
  recordNpcMetric,
  npcTelemetrySnapshot,
} = require('../../apps/api/dist/game/npc-telemetry.js');
const policy = { unreferencedEpisodesPerNpc: 2, privateHistoryEvents: 10, batchLimit: 2 };
async function transaction(run) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await run(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
await test(
  'NPC retention protects evidence, bounds cold memory and erases anonymous replay speech atomically',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register();
      const story = await owner.request('/studio/adventures', storyInput());
      const draft = createAuthoredDraft('observatory');
      draft.npcBehavior = 'reactive-v1';
      await owner.request(
        `/studio/adventures/${story.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const { versionId } = await owner.request(
        `/studio/adventures/${story.id}/playable-versions`,
        { expectedRevision: 1 },
      );
      const { campaignId } = await owner.request('/game/campaigns', {
        playableVersionId: versionId,
      });
      const invite = await owner.request(`/studio/adventures/${story.id}/invitations`, {
        handle: guest.handle,
      });
      await guest.request(`/invitations/${invite.id}/respond`, { decision: 'accept' });
      await owner.request(path(campaignId, 'invitations'), { username: guest.handle });
      await guest.request(path(campaignId, 'accept'), {});
      await stopApi(); // No active writer races with this isolated policy fixture.
      const row = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0];
      const state = structuredClone(row.state),
        guestActor = `player-${guest.user.id}`,
        ownerActor = `player-${owner.user.id}`;
      const observation = (id) => ({
        id,
        rootId: `root-${id}`,
        eventId: `event-${id}`,
        kind: 'said',
        tick: 1,
        mapId: state.entities.keeper.mapId,
        channel: 'heard',
        confidence: 'reported',
        depth: 0,
        disclosure: 'participants',
        audienceIds: [ownerActor],
        actorId: guestActor,
        text: `evidence ${id}`,
      });
      const protectedIds = [
        'live',
        'belief',
        'summary',
        'speech',
        'job',
        'request',
        'scheduled',
        ...Array.from({ length: 6 }, (_, i) => `promise-${i}`),
      ];
      state.npcBrains.keeper.living = {
        ...state.npcBrains.keeper.living,
        observations: [observation('live')],
        beliefs: [{ evidenceIds: ['belief'] }],
        summary: { observationIds: ['summary'] },
        obligations: Array.from({ length: 6 }, (_, i) => ({
          id: `obligation-${i}`,
          status: 'accepted',
          toActorId: ownerActor,
          itemId: 'key',
          evidenceIds: [`promise-${i}`],
        })),
        relationships: {},
        causes: [],
        goal: { kind: 'patrol', evidenceIds: [] },
        biography: 'cold-1 is a word, not evidence',
      };
      state.npcUtterances = [
        {
          id: 'live-speech',
          speakerId: 'keeper',
          text: 'Current safe speech',
          sourceObservationIds: ['speech'],
          audienceIds: [ownerActor],
          speakerKnownToIds: [ownerActor],
          mapId: state.entities.keeper.mapId,
          tick: 1,
        },
      ];
      await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
        campaignId,
        JSON.stringify(state),
      ]);
      const jobId = randomUUID();
      await db.query(
        `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at) VALUES($1,$2,'keeper',$3,'retention-test','system','plan','retention-context',$4,'mock-retention','v1','v1','queued',now()+interval '1 hour')`,
        [jobId, campaignId, randomUUID(), JSON.stringify({ evidenceIds: ['job'] })],
      );
      for (const [status, evidence, linked] of [
        ['queued', 'request', null],
        ['scheduled', 'scheduled', jobId],
      ])
        await db.query(
          `INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,status,job_id) VALUES($1,$2,'keeper','plan',$3,$4,$5,$6)`,
          [
            randomUUID(),
            campaignId,
            randomUUID(),
            JSON.stringify({ sourceObservationIds: [evidence] }),
            status,
            linked,
          ],
        );
      async function insertEpisode(npc, id, tick) {
        await db.query(
          'INSERT INTO game_npc_episodes(campaign_id,npc_id,observation_id,root_id,event_id,actor_id,observed_tick,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            campaignId,
            npc,
            id,
            `root-${id}`,
            `event-${id}`,
            guestActor,
            tick,
            JSON.stringify(observation(id)),
          ],
        );
      }
      for (const id of protectedIds) await insertEpisode('keeper', id, 0);
      for (let i = 1; i <= 8; i++) await insertEpisode('keeper', `cold-${i}`, i);
      for (let i = 1; i <= 3; i++) await insertEpisode('helper', `helper-cold-${i}`, i);
      await t.test(
        'explicit evidence walker ignores prose and telemetry rejects invalid amounts',
        () => {
          const ids = protectedNpcEvidence({
            observations: [observation('a')],
            evidenceIds: ['b'],
            nested: { observationId: 'c', sourceObservationIds: ['d'] },
            text: 'do not protect e',
            arbitraryIds: ['e'],
          });
          assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd']);
          const before = npcTelemetrySnapshot();
          for (const invalid of [-1, NaN, Infinity]) recordNpcMetric('retentionRuns', invalid);
          assert.equal(npcTelemetrySnapshot().retentionRuns, before.retentionRuns);
          recordNpcMetric('retentionRuns', 2);
          assert.equal(npcTelemetrySnapshot().retentionRuns, before.retentionRuns + 2);
          assert.equal(npcTelemetrySnapshot().scope, 'current-process');
          assert.ok(!JSON.stringify(npcTelemetrySnapshot()).includes(guest.user.id));
        },
      );
      await t.test(
        'tiny batched cap retains live, pending, summary and all six commitment dependencies',
        async () => {
          let removed = 0;
          for (let i = 0; i < 10; i++) {
            const result = await transaction((c) =>
              pruneNpcMemory(c, campaignId, state, 0, policy),
            );
            assert.ok(result.episodes <= 2);
            removed += result.episodes;
            if (!result.episodes) break;
          }
          assert.equal(removed, 7);
          const rows = (
            await db.query(
              'SELECT npc_id,observation_id FROM game_npc_episodes WHERE campaign_id=$1',
              [campaignId],
            )
          ).rows;
          assert.deepEqual(
            rows
              .filter((r) => r.npc_id === 'keeper')
              .map((r) => r.observation_id)
              .sort(),
            [...protectedIds, 'cold-7', 'cold-8'].sort(),
          );
          assert.deepEqual(
            rows
              .filter((r) => r.npc_id === 'helper')
              .map((r) => r.observation_id)
              .sort(),
            ['helper-cold-2', 'helper-cold-3'],
          );
          assert.equal(
            (await transaction((c) => pruneNpcMemory(c, campaignId, state, 0, policy))).episodes,
            0,
          );
          await assert.rejects(
            transaction((c) =>
              pruneNpcMemory(c, campaignId, state, 0, { ...policy, batchLimit: 0 }),
            ),
            /INVALID_NPC_RETENTION_POLICY/,
          );
        },
      );
      const secret = 'ERASABLE_ANONYMOUS_RETENTION_SPEECH';
      const oldState = structuredClone(state);
      oldState.npcUtterances = [
        {
          id: 'expired-secret',
          speakerId: guestActor,
          text: secret,
          tick: 2,
          mapId: state.entities.keeper.mapId,
          audienceIds: [ownerActor],
          speakerKnownToIds: [],
          sourceObservationIds: ['cold-1'],
        },
      ];
      const paraphrase = 'DERIVED_PARAPHRASE_WITHOUT_PLAYER_IDENTIFIER';
      const replyState = structuredClone(state);
      replyState.npcBrains.keeper.living.observations = [];
      replyState.npcUtterances = [
        {
          id: 'derived-reply',
          speakerId: 'keeper',
          text: paraphrase,
          tick: 3,
          mapId: state.entities.keeper.mapId,
          audienceIds: [ownerActor],
          speakerKnownToIds: [ownerActor],
          sourceObservationIds: ['live'],
        },
      ];
      // The originating observation has left hot state/archive before the later reply snapshot.
      state.npcBrains.keeper.living.observations = [];
      await db.query('DELETE FROM game_npc_episodes WHERE campaign_id=$1 AND observation_id=$2', [
        campaignId,
        'live',
      ]);
      await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
        campaignId,
        JSON.stringify(state),
      ]);
      const derivedObservation = {
        ...observation('derived-observation'),
        rootId: 'derived-reply',
        eventId: 'event-derived-reply',
        actorId: 'keeper',
        text: paraphrase,
      };
      await db.query(
        'INSERT INTO game_npc_episodes(campaign_id,npc_id,observation_id,root_id,event_id,actor_id,observed_tick,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          campaignId,
          'helper',
          'derived-observation',
          'derived-reply',
          'event-derived-reply',
          'keeper',
          1000,
          JSON.stringify(derivedObservation),
        ],
      );
      await db.query('DELETE FROM game_outbox WHERE campaign_id=$1', [campaignId]);
      await db.query('DELETE FROM game_events WHERE campaign_id=$1', [campaignId]);
      for (const sequence of [10, 20, 30])
        await db.query(
          'INSERT INTO game_events(campaign_id,sequence,kind,payload) VALUES($1,$2,$3,$4)',
          [
            campaignId,
            sequence,
            'test.retention',
            JSON.stringify({
              state: sequence === 10 ? oldState : sequence === 20 ? replyState : state,
              outcome: { doorOpened: true, sequence },
            }),
          ],
        );
      const operationId = randomUUID();
      await db.query(
        'INSERT INTO game_operations(campaign_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [
          campaignId,
          ownerActor,
          operationId,
          'immutable-operation-hash',
          JSON.stringify({
            status: 'committed',
            operationId,
            projection: {
              actorId: ownerActor,
              npcUtterances: [
                { id: 'expired-secret', text: secret, tick: 2 },
                { id: 'derived-reply', text: paraphrase, tick: 3 },
                { id: 'unrelated-current', text: 'Safe cached response', tick: 30 },
              ],
              inventory: [{ id: 'preserved-key' }],
            },
          }),
        ],
      );
      const history = async (pool = db) =>
        (
          await pool.query('SELECT payload FROM game_events WHERE campaign_id=$1 AND sequence=10', [
            campaignId,
          ])
        ).rows[0].payload;
      const replay = async (pool = db) =>
        (
          await pool.query(
            'SELECT result FROM game_operations WHERE campaign_id=$1 AND operation_id=$2',
            [campaignId, operationId],
          )
        ).rows[0].result;
      await t.test(
        'history and anonymous replay redaction commit atomically, preserve outcomes and roll back together',
        async () => {
          const c = await db.connect();
          try {
            await c.query('BEGIN');
            const result = await pruneNpcMemory(c, campaignId, state, 40, policy);
            assert.equal(result.historicalStates, 2);
            assert.equal(result.replayConversations, 1);
            assert.equal((await history(c)).state.npcBrains, undefined);
            assert.ok(!JSON.stringify(await replay(c)).includes(secret));
            assert.ok((await history()).state.npcBrains);
            assert.ok(JSON.stringify(await replay()).includes(secret));
            await c.query('ROLLBACK');
          } finally {
            c.release();
          }
          assert.ok((await history()).state.npcBrains);
          assert.ok(JSON.stringify(await replay()).includes(secret));
          await transaction((c) => pruneNpcMemory(c, campaignId, state, 40, policy));
          const compacted = await history();
          assert.equal(compacted.npcMemoryCompacted, true);
          assert.equal(compacted.state.npcBrains, undefined);
          assert.equal(compacted.state.npcUtterances, undefined);
          assert.ok(
            compacted.state.npcProvenance.observations.some(
              (entry) => entry.id === 'live' && entry.actorId === guestActor,
            ),
          );
          assert.ok(
            (
              await db.query(
                'SELECT payload FROM game_events WHERE campaign_id=$1 AND sequence=20',
                [campaignId],
              )
            ).rows[0].payload.state.npcProvenance.utterances.some(
              (entry) =>
                entry.id === 'derived-reply' && entry.sourceObservationIds.includes('live'),
            ),
          );
          const provenance = JSON.stringify(compacted.state.npcProvenance);
          assert.ok(!provenance.includes(secret));
          assert.ok(!provenance.includes(paraphrase));
          assert.ok(!provenance.includes('evidence live'));
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS count FROM game_npc_episodes WHERE campaign_id=$1 AND observation_id=$2',
                [campaignId, 'derived-observation'],
              )
            ).rows[0].count,
            1,
          );

          assert.deepEqual(compacted.state.entities, oldState.entities);
          assert.deepEqual(compacted.outcome, { doorOpened: true, sequence: 10 });
          assert.ok(
            (
              await db.query(
                'SELECT payload FROM game_events WHERE campaign_id=$1 AND sequence=30',
                [campaignId],
              )
            ).rows[0].payload.state.npcBrains,
          );
          const cached = await replay();
          assert.equal(cached.status, 'committed');
          assert.equal(cached.operationId, operationId);
          assert.deepEqual(cached.projection.inventory, [{ id: 'preserved-key' }]);
          assert.deepEqual(
            cached.projection.npcUtterances.map((u) => u.id),
            ['unrelated-current'],
          );
          const repeat = await transaction((c) => pruneNpcMemory(c, campaignId, state, 40, policy));
          assert.equal(repeat.historicalStates, 0);
          assert.equal(repeat.replayConversations, 0);
        },
      );
      await t.test(
        'erasure after compaction cannot resurrect anonymous speech and keeps owner outcomes',
        async () => {
          await transaction(async (c) => {
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await purgeGameData(c, guest.user.id);
          });
          const events = (
            await db.query('SELECT payload FROM game_events WHERE campaign_id=$1', [campaignId])
          ).rows;
          const operations = (
            await db.query('SELECT result FROM game_operations WHERE campaign_id=$1', [campaignId])
          ).rows;
          const episodes = (
            await db.query('SELECT payload FROM game_npc_episodes WHERE campaign_id=$1', [
              campaignId,
            ])
          ).rows;
          assert.ok(!JSON.stringify({ events, operations, episodes }).includes(paraphrase));
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS count FROM game_npc_episodes WHERE campaign_id=$1 AND observation_id=$2',
                [campaignId, 'derived-observation'],
              )
            ).rows[0].count,
            0,
          );
          assert.ok(!JSON.stringify({ events, operations }).includes(secret));
          assert.ok(
            events.find((e) => e.payload.outcome?.sequence === 10)?.payload.outcome.doorOpened,
          );
          const exported = await exportGameData(db, owner.user.id);
          assert.ok(!JSON.stringify(exported).includes(secret));
          assert.equal((await replay()).status, 'committed');
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
