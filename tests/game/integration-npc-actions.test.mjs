import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, client, startApi, stopApi, snapshot, command, until } from './support-runtime.mjs';
const require = createRequire(import.meta.url),
  g = require('../../packages/game-core/dist');
const { digest } = require('../../apps/api/dist/ai/context');
const { GameService } = require('../../apps/api/dist/game/game.service');
const fence = (p) => ({
  roundId: p.turn.roundId,
  phaseEpoch: p.turn.phaseEpoch,
  rulesetVersion: 1,
});
await test(
  'public NPC action intent and unaddressed NPC obligation execute on End turn, persist partial paths and restore after restart',
  { timeout: 90000 },
  async () => {
    try {
      await startApi();
      const owner = await client().register();
      const adventure = await owner.request('/studio/adventures', {
        title: 'NPC world actions regression',
      });
      const draft = g.createCompleteObservatoryDraft();
      draft.turnRules = g.turnRulesSchema.parse({ movement: 2 });
      const saved = await owner.request(
        `/studio/adventures/${adventure.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const version = await owner.request(`/studio/adventures/${adventure.id}/playable-versions`, {
        expectedRevision: saved.revision,
      });
      const campaign = await owner.request('/game/campaigns', {
        playableVersionId: version.versionId,
      });
      const id = campaign.campaignId ?? campaign.id,
        actor = (await snapshot(owner, id)).projection.actorId;
      await stopApi();
      const orphanId = randomUUID(),
        consentId = randomUUID(),
        protectedId = randomUUID(),
        batchId = randomUUID();
      for (const [requestId, status] of [
        [orphanId, 'scheduled'],
        [consentId, 'queued'],
        [protectedId, 'scheduled'],
      ])
        await db.query(
          "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,status,result_code) VALUES($1,$2,'keeper','plan',$4,'{}',$3,'GENERATION_QUOTE_STALE')",
          [requestId, id, status, `orphan:${requestId}`],
        );
      const recovery = Object.create(GameService.prototype);
      recovery.db = { query: async (sql, values) => (await db.query(sql, values)).rows };
      await db.query(
        "INSERT INTO game_world_generation_batches(id,campaign_id,owner_id,operation_id,state,state_hash,request_hash,turn_fence,entries,quote,expires_at) VALUES($1,$2,$3,$4,'accepted','fixture','fixture','{}',$5,'{}',now()+interval '5 minutes')",
        [batchId, id, owner.user.id, randomUUID(), JSON.stringify([{ requestId: protectedId }])],
      );
      await recovery.reconcileWorldOrphans(id);
      assert.equal(
        (await db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [orphanId]))
          .rows[0].status,
        'failed',
      );
      assert.equal(
        (await db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [consentId]))
          .rows[0].status,
        'queued',
        'unpaid consent waiting is preserved',
      );
      assert.equal(
        (await db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [protectedId]))
          .rows[0].status,
        'scheduled',
        'accepted consent evidence prevents automatic cleanup',
      );
      await db.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
        batchId,
      ]);
      await db.query("UPDATE game_npc_decision_requests SET status='cancelled' WHERE id=$1", [
        protectedId,
      ]);
      await db.query("UPDATE game_npc_decision_requests SET status='cancelled' WHERE id=$1", [
        consentId,
      ]);
      let s = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
      Object.assign(s.entities[actor], { x: 5, y: 4 });
      const speech = { channel: 'say', text: 'Подойдите посмотрите сами.' },
        identity = { turnId: randomUUID(), segmentIndex: 0 };
      s = g.applyNpcSpeech(s, actor, 'keeper', speech, { identity, suppressReply: true }).state;
      const marker = g.admittedNpcSpeechObservationId(s, actor, 'keeper', speech, identity);
      const context = g.buildNpcPublicSpeechContext(
        s,
        'keeper',
        [actor, 'keeper'],
        [marker],
        [],
        undefined,
        'ru',
        actor,
      );
      const decided = g.commitNpcPublicUtterance(s, 'keeper', {
        text: 'Я подойду и посмотрю.',
        channel: 'say',
        replyLocale: 'ru',
        recipientId: actor,
        observationIds: [marker],
        replyToObservationId: marker,
        contextHash: g.npcContextFingerprint(context),
        actionIntent: {
          sourceObservationId: marker,
          actions: [{ kind: 'move_to', target: { x: 3, y: 6 } }],
        },
      });
      assert.equal(decided.error, undefined);
      s = decided.state;
      s.entities.guard = { ...s.entities.keeper, id: 'guard', x: 8, y: 4 };
      s.npcBrains.guard = structuredClone(s.npcBrains.keeper);
      s.npcBrains.guard.plan = [];
      s.npcBrains.guard.cursor = 0;
      s.npcBrains.guard.living.obligations = [
        {
          id: 'existing-promise',
          toActorId: actor,
          createdTick: 0,
          dueTick: 200,
          status: 'accepted',
          evidenceIds: [],
          promisedAction: { kind: 'inspect', targetId: 'key' },
          conditions: [],
        },
      ];
      const transaction = await db.connect();
      try {
        await transaction.query('BEGIN');
        await transaction.query('UPDATE game_campaigns SET state=$2,revision=$3 WHERE id=$1', [
          id,
          JSON.stringify(s),
          s.revision,
        ]);
        await transaction.query(
          'UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1',
          [id, JSON.stringify(s), digest(s)],
        );
        await transaction.query('COMMIT');
      } catch (error) {
        await transaction.query('ROLLBACK');
        throw error;
      } finally {
        transaction.release();
      }
      await startApi();
      const p = (await snapshot(owner, id)).projection;
      assert.equal(p.entities.find((e) => e.id === 'keeper').x, 6);
      const end = {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'turn.end',
        turnFence: fence(p),
      };
      await command(owner, id, end);
      await command(owner, id, end);
      await until(
        () => snapshot(owner, id),
        (v) => v.projection.turn.roundNumber === 2 && v.projection.turn.phase === 'player',
        15000,
      );
      const after = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0]
        .state;
      assert.notDeepEqual(
        { x: after.entities.keeper.x, y: after.entities.keeper.y },
        { x: 6, y: 4 },
      );
      assert.notDeepEqual({ x: after.entities.guard.x, y: after.entities.guard.y }, { x: 8, y: 4 });
      assert.equal(after.npcBrains.keeper.cursor, 0, 'a bounded prefix keeps the remaining path');
      assert.equal(after.npcBrains.keeper.living.companionship, undefined);
      assert.equal(
        after.npcUtterances.length,
        s.npcUtterances.length,
        'unaddressed NPC is not forced to speak',
      );
      assert.equal(g.footprintOverlaps(after.entities.keeper, after.entities[actor]), false);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM game_npc_decision_requests WHERE campaign_id=$1 AND status IN ('queued','scheduled')",
            [id],
          )
        ).rows[0].n,
        0,
      );
      await stopApi();
      await startApi();
      await snapshot(owner, id);
      const restored = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
        .rows[0].state;
      assert.deepEqual(restored.npcBrains.keeper.plan, after.npcBrains.keeper.plan);
      assert.equal(restored.npcBrains.keeper.cursor, after.npcBrains.keeper.cursor);
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
