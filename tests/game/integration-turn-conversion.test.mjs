/** Isolated PostgreSQL conversion/default-launch acceptance; never uses the user preview or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { db, startApi, stopApi, client, snapshot, actor, path } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const g = require('../../packages/game-core/dist');
const { convertSavedCampaignToTurns } = require('../../apps/api/dist/game/turn-conversion.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
async function transaction(work) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
const read = async (id) =>
  (await db.query('SELECT * FROM game_campaigns WHERE id=$1', [id])).rows[0];

await test(
  'authored launches default to turns and explicit conversion atomically preserves saved progress',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        outsider = await client().register();
      const story = await owner.request('/studio/adventures', {
        title: 'Synthetic conversion fixture',
      });
      const draft = g.createAuthoredDraft('courtyard');
      draft.npcBehavior = 'reactive-v1';
      delete draft.turnRules;
      await owner.request(
        '/studio/adventures/' + story.id + '/playable-draft',
        { expectedRevision: 0, draft },
        'PUT',
      );
      const version = await owner.request('/studio/adventures/' + story.id + '/playable-versions', {
        expectedRevision: 1,
      });
      let legacyId, ownerActor, input, before, hold, scope;
      await t.test(
        'older authored clients omitting turnBased get a frozen player phase',
        async () => {
          const fresh = await owner.request('/game/campaigns', {
            playableVersionId: version.versionId,
          });
          const first = await snapshot(owner, fresh.campaignId);
          assert.equal(first.projection.turn.phase, 'player');
          assert.equal(first.projection.turn.ownTurn, true);
          const saved = (await read(fresh.campaignId)).state;
          await delay(350);
          await snapshot(owner, fresh.campaignId);
          const after = (await read(fresh.campaignId)).state;
          assert.equal(after.tick, saved.tick);
          assert.deepEqual(
            Object.values(after.entities)
              .filter((e) => e.kind === 'npc')
              .map((e) => [e.id, e.x, e.y]),
            Object.values(saved.entities)
              .filter((e) => e.kind === 'npc')
              .map((e) => [e.id, e.x, e.y]),
          );
          legacyId = (
            await owner.request('/game/campaigns', {
              playableVersionId: version.versionId,
              turnBased: false,
            })
          ).campaignId;
          assert.equal((await read(legacyId)).state.turnController, undefined);
          await stopApi();
        },
      );
      await t.test(
        'fixture stores existing inventory, private canon, log and an unrelated held image budget',
        async () => {
          const row = await read(legacyId);
          const state = structuredClone(row.state);
          ownerActor = 'player-' + owner.user.id;
          const item = Object.values(state.entities).find((e) => e.kind === 'item');
          item.ownerId = ownerActor;
          state.narrativePremise = {
            title: 'Fixture',
            summary: 'Already played',
            world: 'PRIVATE_CONVERSION_FIXTURE',
            genre: 'mystery',
          };
          state.revision += 7;
          await transaction(async (c) => {
            await c.query('UPDATE game_campaigns SET state=$2,revision=1,event_seq=1 WHERE id=$1', [
              legacyId,
              JSON.stringify(state),
            ]);
            await c.query(
              'UPDATE game_snapshots SET state=$2,checksum=$3,sequence=1 WHERE campaign_id=$1',
              [legacyId, JSON.stringify(state), digest(state)],
            );
            await c.query(
              "INSERT INTO game_events(campaign_id,sequence,kind,payload) VALUES($1,1,'fixture.progress',$2)",
              [legacyId, JSON.stringify({ state })],
            );
            await c.query('INSERT INTO game_outbox(campaign_id,sequence) VALUES($1,1)', [legacyId]);
            await c.query(
              "INSERT INTO game_party_chat(id,campaign_id,sender_user_id,sender_actor_id,operation_id,text) VALUES($1,$2,$3,$4,$5,'SAVED_PARTY_LOG')",
              [randomUUID(), legacyId, owner.user.id, ownerActor, randomUUID()],
            );
            scope = 'conversion-fixture-' + randomUUID();
            hold = randomUUID();
            await c.query(
              'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros,blocked) VALUES($1,true,1000000,1000000,1000000,true)',
              [scope],
            );
            await c.query(
              "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'image',$4,66900,'held')",
              [hold, scope, owner.user.id, randomUUID()],
            );
          });
          before = await read(legacyId);
          input = {
            campaignId: legacyId,
            ownerHandle: owner.handle,
            expectedRevision: 1,
            operationId: randomUUID(),
          };
        },
      );
      await t.test(
        'ownership, stale revision, unpaused runtime and pending work block conversion',
        async () => {
          for (const [change, code] of [
            [{ ownerHandle: outsider.handle }, 'TURN_CONVERSION_OWNER_REQUIRED'],
            [{ expectedRevision: 0 }, 'STALE_STATE'],
          ]) {
            await assert.rejects(
              transaction((c) => convertSavedCampaignToTurns(c, { ...input, ...change })),
              (error) => error.code === code,
            );
          }
          await db.query(
            "UPDATE game_campaigns SET runtime_clock=jsonb_set(runtime_clock,'{paused}','false') WHERE id=$1",
            [legacyId],
          );
          await assert.rejects(
            transaction((c) => convertSavedCampaignToTurns(c, input)),
            (error) => error.code === 'TURN_CONVERSION_PAUSE_REQUIRED',
          );
          await db.query(
            "UPDATE game_campaigns SET runtime_clock=jsonb_set(runtime_clock,'{paused}','true') WHERE id=$1",
            [legacyId],
          );
          const pending = randomUUID();
          await db.query(
            "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context) VALUES($1,$2,'keeper','plan',$3,'{}')",
            [pending, legacyId, randomUUID()],
          );
          await assert.rejects(
            transaction((c) => convertSavedCampaignToTurns(c, input)),
            (error) => error.code === 'TURN_CONVERSION_PENDING_WORK',
          );
          await db.query('DELETE FROM game_npc_decision_requests WHERE id=$1', [pending]);
          assert.equal((await read(legacyId)).state.turnController, undefined);
        },
      );
      await t.test(
        'rollback covers state, snapshot, event, outbox and receipt together',
        async () => {
          await assert.rejects(
            transaction(async (c) => {
              await convertSavedCampaignToTurns(c, input);
              throw new Error('SYNTHETIC_ROLLBACK');
            }),
            /SYNTHETIC_ROLLBACK/,
          );
          const row = await read(legacyId);
          assert.deepEqual(row.state, before.state);
          assert.equal(Number(row.revision), 1);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM game_events WHERE campaign_id=$1 AND kind='turn.converted'",
                [legacyId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_operations WHERE campaign_id=$1 AND operation_id=$2',
                [legacyId, input.operationId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await db.query('SELECT checksum FROM game_snapshots WHERE campaign_id=$1', [legacyId]))
              .rows[0].checksum,
            digest(before.state),
          );
        },
      );
      await t.test(
        'concurrent duplicate conversion is one append and preserves money, log, source and state',
        async () => {
          const [a, b] = await Promise.all([
            transaction((c) => convertSavedCampaignToTurns(c, input)),
            transaction((c) => convertSavedCampaignToTurns(c, input)),
          ]);
          assert.deepEqual(a, b);
          assert.equal(a.status, 'converted');
          assert.equal(a.revision, 2);
          assert.equal(a.sequence, 2);
          const row = await read(legacyId),
            after = row.state;
          assert.equal(row.source_version_id, before.source_version_id);
          assert.equal(row.playable_version, before.playable_version);
          assert.equal(after.tick, before.state.tick);
          assert.deepEqual(after.narrativePremise, before.state.narrativePremise);
          assert.deepEqual(after.maps, before.state.maps);
          assert.deepEqual(after.assetManifest, before.state.assetManifest);
          const owned = Object.values(before.state.entities).find(
            (e) => e.kind === 'item' && e.ownerId === ownerActor,
          );
          assert.equal(after.entities[owned.id].ownerId, ownerActor);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM game_events WHERE campaign_id=$1 AND kind='turn.converted'",
                [legacyId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                'SELECT payload FROM game_events WHERE campaign_id=$1 AND sequence=1',
                [legacyId],
              )
            ).rows[0].payload.state.narrativePremise.world,
            'PRIVATE_CONVERSION_FIXTURE',
          );
          assert.equal(
            (await db.query('SELECT text FROM game_party_chat WHERE campaign_id=$1', [legacyId]))
              .rows[0].text,
            'SAVED_PARTY_LOG',
          );
          const reservation = (
            await db.query(
              'SELECT status,upper_micros,actual_micros FROM generation_budget_reservations WHERE id=$1',
              [hold],
            )
          ).rows[0];
          assert.deepEqual(reservation, {
            status: 'held',
            upper_micros: '66900',
            actual_micros: null,
          });
          assert.equal(
            (await db.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [scope]))
              .rows[0].blocked,
            true,
          );
          const saved = (
            await db.query(
              'SELECT sequence,checksum,state FROM game_snapshots WHERE campaign_id=$1',
              [legacyId],
            )
          ).rows[0];
          assert.equal(Number(saved.sequence), 2);
          assert.equal(saved.checksum, digest(after));
          assert.deepEqual(saved.state, after);
        },
      );
      await t.test(
        'reconnect gets EndTurn resources, immediate free walking and no idle NPC progression',
        async () => {
          await startApi();
          const snap = await snapshot(owner, legacyId),
            p = snap.projection,
            a = actor(snap);
          assert.equal(p.turn.phase, 'player');
          assert.equal(p.turn.ownTurn, true);
          const response = await owner.request(path(legacyId, 'move'), {
            operationId: randomUUID(),
            turnFence: {
              roundId: p.turn.roundId,
              phaseEpoch: p.turn.phaseEpoch,
              rulesetVersion: 1,
            },
            connectionEpoch: snap.connectionEpoch,
            inputSeq: (a.lastInputSeq ?? 0) + 1,
            movementGeneration: a.movementGeneration ?? 0,
            target: { x: a.x + 1, y: a.y },
          });
          assert.equal(response.status, 'committed');
          assert.equal(actor(response).x, a.x + 1);
          assert.equal(response.projection.turn.resources.movement, p.turn.resources.movement);
          const saved = await read(legacyId);
          await delay(350);
          await snapshot(owner, legacyId);
          assert.equal((await read(legacyId)).state.tick, saved.state.tick);
          assert.deepEqual(
            (await read(legacyId)).state.entities.keeper,
            saved.state.entities.keeper,
          );
          await transaction((c) => convertSavedCampaignToTurns(c, input));
          assert.equal(
            (await snapshot(owner, legacyId)).projection.turn.resources.movement,
            p.turn.resources.movement,
          );
          await stopApi();
          await startApi();
          assert.equal(
            (await snapshot(owner, legacyId)).projection.turn.resources.movement,
            p.turn.resources.movement,
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
