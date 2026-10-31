/** Adversarial delayed provider receipts through real auth, durable jobs and canonical world writer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client, until } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { GameController } = require('../../apps/api/dist/game/game.controller.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { applyNpcSpeech } = require('../../packages/game-core/dist/index.js');
const database = new Db();
const jobRow = async (id) =>
  (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [id])).rows[0];
const turnRow = async (id) =>
  (await db.query('SELECT * FROM game_narrative_turns WHERE id=$1', [id])).rows[0];
await test(
  'director provider receipts cannot bypass canon, geometry, audience, authorization or atomicity',
  { timeout: 180000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const a = await client().register(),
        b = await client().register();
      const story = await a.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 13; i++) {
        const { campaignId } = await a.request('/game/campaigns', {
          playableVersionId: story.playableVersionId,
        });
        await a.request(`/game/campaigns/${campaignId}/invitations`, { username: b.handle });
        await b.request(`/game/campaigns/${campaignId}/accept`, {});
        ids.push(campaignId);
      }
      await stopApi();
      const pending = new Map();
      const provider = {
        id: `director-admission-${randomUUID()}`,
        version: 'v1',
        external: false,
        generate: (request) =>
          new Promise((resolve) => pending.set(request.jobId, { request, resolve })),
      };
      const ai = new NpcAiEngine(database, provider, { timeoutMs: 20000 });
      const auth = new Auth(database),
        art = new AssetReuseService(database),
        playable = new PlayableService(database, auth, art);
      game = new GameService(database, auth, playable, ai, art);
      clearInterval(game.timer);
      const controller = new GameController(game),
        req = { headers: { cookie: a.cookie } },
        other = { headers: { cookie: b.cookie } };
      const actor = `player-${a.user.id}`,
        otherActor = `player-${b.user.id}`;
      async function prepare(id) {
        await controller.snapshot(req, id);
        const live = game.live.get(id);
        live.state.entities[actor].x = 5;
        live.state.entities[actor].y = 4;
        live.state.entities[otherActor].x = 4;
        live.state.entities[otherActor].y = 4;
        for (const brain of Object.values(live.state.npcBrains ?? {})) {
          brain.plan = [];
          brain.cursor = 0;
          brain.nextDecisionTick = 99999;
        }
        await game.persist(id, live, live.state, 'test.director.fixture');
        return live;
      }
      function privateInventory(state) {
        const id = 'PRIVATE_INVENTORY_CANARY';
        state.entities[id] = {
          id,
          kind: 'item',
          label: 'Unshared personal possession',
          visual: 'token',
          mapId: 'observatory',
          x: 5,
          y: 4,
          revision: 0,
          ownerId: actor,
        };
        state.entities[actor].inventory ??= [];
        state.entities[actor].inventory.push(id);
        return id;
      }
      async function queue(id, user = req, waitForProvider = true) {
        const revision = game.live.get(id).state.narrativeCanon?.revision ?? 0;
        const text = 'Explore a new shared scene and meet someone who actually belongs there.';
        const quote = await controller.narrativeQuote(user, id, {
          text,
          expectedCanonRevision: revision,
        });
        const body = {
          text,
          expectedCanonRevision: revision,
          operationId: randomUUID(),
          quoteId: quote.id,
          consent: true,
        };
        const turn = await controller.narrativeSubmit(user, id, body);
        await game.processDecisionRequests(id, game.live.get(id));
        const r = await until(
          async () =>
            (await db.query('SELECT job_id FROM game_npc_decision_requests WHERE id=$1', [turn.id]))
              .rows[0],
          (v) => !!v?.job_id,
        );
        if (waitForProvider) await until(async () => pending.has(r.job_id), Boolean);
        return { turn, body, jobId: r.job_id, p: pending.get(r.job_id) };
      }
      async function receive(q, proposal = q.p.request.context.mockProposal) {
        q.p.resolve({
          proposal,
          requestId: `director-${q.jobId}`,
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
        });
        return until(
          () => jobRow(q.jobId),
          (r) => ['result_received', 'failed', 'stale', 'cancelled'].includes(r.status),
        );
      }
      async function finish(id, live, q, proposal) {
        await receive(q, proposal);
        await game.processAi(id, live);
        return turnRow(q.turn.id);
      }
      await t.test(
        'shared director context omits real private whisper and all NPC memory, while new NPC inherits none',
        async () => {
          const id = ids[0],
            live = await prepare(id);
          privateInventory(live.state);
          const r = applyNpcSpeech(live.state, actor, 'keeper', {
            channel: 'whisper',
            text: 'PRIVATE_WHISPER_CANARY_NEVER_SHARE',
          });
          assert.equal(r.error, undefined);
          live.state = r.state;
          await game.persist(id, live, live.state, 'test.private.whisper');
          const q = await queue(id),
            packed = JSON.stringify(q.p.request.context);
          assert.ok(!packed.includes('PRIVATE_WHISPER_CANARY_NEVER_SHARE'));
          assert.ok(!packed.includes('PRIVATE_INVENTORY_CANARY'));
          assert.ok(!packed.includes('ownInventory'));
          assert.ok(!packed.includes('npcBrains'));
          assert.ok(!packed.includes('observations'));
          const publicPending = await controller.narrative(other, id);
          assert.equal(publicPending.turns.length, 0);
          const done = await finish(id, live, q);
          assert.equal(done.status, 'committed');
          const npcId = done.result.npcId,
            brain = live.state.npcBrains[npcId];
          assert.ok(!JSON.stringify(brain).includes('PRIVATE_WHISPER_CANARY_NEVER_SHARE'));
          assert.deepEqual(live.state.entities[npcId].inventory, []);
          const view = await controller.narrative(other, id);
          assert.equal(view.turns[0].status, 'committed');
          assert.ok(!JSON.stringify(view).includes('PRIVATE_WHISPER_CANARY_NEVER_SHARE'));
        },
      );
      const invalid = [
        [
          'protected existing identity',
          (p, s) => {
            p.newNpc.name = s.entities.keeper.label;
          },
        ],
        [
          'blocked generated NPC geometry',
          (p) => {
            p.newNpc.spawn = { x: 0, y: 0 };
          },
        ],
        [
          'invented private knowledge reference',
          (p) => {
            p.newNpc.knownEntityIds = ['nonexistent-secret'];
          },
        ],
        [
          'unsupported inventory minting',
          (p) => {
            p.actions = [{ kind: 'spawn_item', targetId: 'free-treasure' }];
          },
        ],
        [
          'unlawful action rolls back already proposed scene and NPC',
          (p) => {
            p.actions = [{ kind: 'pick_up', targetId: 'journal' }];
          },
        ],
      ];
      for (let i = 0; i < invalid.length; i++)
        await t.test(`${invalid[i][0]} is denied atomically`, async () => {
          const id = ids[i + 1],
            live = await prepare(id),
            before = structuredClone(live.state),
            q = await queue(id);
          const p = structuredClone(q.p.request.context.mockProposal);
          invalid[i][1](p, live.state);
          await finish(id, live, q, p);
          const j = await jobRow(q.jobId);
          assert.ok(['stale', 'failed'].includes(j.status), j.status);
          assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
          assert.deepEqual(Object.keys(live.state.maps), Object.keys(before.maps));
          assert.ok(!Object.values(live.state.entities).some((e) => e.supportingNpc?.generated));
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_narrative_media WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
        });
      await t.test(
        'concurrent participant receipts at one revision allow exactly one canon/world commit',
        async () => {
          const id = ids[6],
            live = await prepare(id),
            one = await queue(id),
            two = await queue(id, other, false);
          await receive(one);
          await until(async () => !ai.inFlight.has(id), Boolean);
          game.dispatchAi(id);
          await until(async () => pending.has(two.jobId), Boolean);
          two.p = pending.get(two.jobId);
          await receive(two);
          await game.processAi(id, live);
          const rows = (
            await db.query('SELECT status FROM game_narrative_turns WHERE campaign_id=$1', [id])
          ).rows;
          assert.equal(rows.filter((r) => r.status === 'committed').length, 1);
          assert.equal(rows.filter((r) => r.status === 'stale').length, 1);
          assert.equal(live.state.narrativeCanon.revision, 1);
          assert.equal(live.state.narrativeCanon.turns.length, 1);
          await game.processAi(id, live);
          assert.equal(live.state.narrativeCanon.turns.length, 1);
        },
      );
      await t.test(
        'last-player disconnect holds completed provider output until actual authorized resume',
        async () => {
          const id = ids[7],
            live = await prepare(id),
            q = await queue(id);
          await game.disconnected(id, actor);
          await game.disconnected(id, otherActor);
          assert.equal(live.paused, true);
          await receive(q);
          await game.advance(id);
          assert.equal((await turnRow(q.turn.id)).status, 'pending');
          assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
          await controller.snapshot(req, id);
          await game.processAi(id, live);
          assert.equal((await turnRow(q.turn.id)).status, 'committed');
          assert.equal(live.state.narrativeCanon.revision, 1);
        },
      );
      await t.test('revoked participant cannot admit a delayed provider result', async () => {
        const id = ids[8],
          live = await prepare(id),
          q = await queue(id, other);
        await controller.revoke(req, id, b.user.id);
        await receive(q);
        await game.processAi(id, live);
        assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
        assert.ok(!Object.values(live.state.entities).some((e) => e.supportingNpc?.generated));
        assert.ok(['stale', 'cancelled', 'failed'].includes((await jobRow(q.jobId)).status));
      });
      await t.test(
        'confirmed canon cap is enforced at delayed admission, not only at quoting',
        async () => {
          const id = ids[9],
            live = await prepare(id),
            q = await queue(id);
          live.state.narrativeConstraints = { ...live.state.narrativeConstraints, maxTurns: 1 };
          live.state.narrativeCanon = {
            revision: 1,
            turns: [
              {
                id: randomUUID(),
                actorId: actor,
                requestHash: 'fixture',
                tick: live.state.tick,
                narration: 'A prior committed turn',
                evidenceIds: [],
              },
            ],
          };
          await game.persist(id, live, live.state, 'test.existing.canon');
          await finish(id, live, q);
          assert.equal((await jobRow(q.jobId)).status, 'stale');
          assert.equal(live.state.narrativeCanon.turns.length, 1);
        },
      );
      await t.test(
        'a provider cannot exceed a currently quoted scene cap even with a matching semantic hash',
        async () => {
          const id = ids[10],
            live = await prepare(id);
          live.state.narrativeConstraints = {
            ...live.state.narrativeConstraints,
            maxScenes: Object.keys(live.state.maps).length,
          };
          await game.persist(id, live, live.state, 'test.scene.cap');
          const q = await queue(id),
            proposal = structuredClone(q.p.request.context.mockProposal);
          proposal.newScene = {
            name: 'Forbidden overflow room',
            description: 'A bounded fixture',
            template: 'room',
            connection: {
              fromMapId: 'observatory',
              ...q.p.request.context.availableConnections[0],
            },
          };
          await finish(id, live, q, proposal);
          assert.equal((await jobRow(q.jobId)).status, 'stale');
          assert.equal(Object.keys(live.state.maps).length, 2);
          assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
        },
      );
      await t.test(
        'SQL failure during turn commit rolls back job, canon and world together; same receipt retries once',
        async () => {
          const id = ids[11],
            live = await prepare(id),
            q = await queue(id);
          await receive(q);
          const before = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
            .rows[0].state;
          await db.query(
            `CREATE FUNCTION qa_fail_narrative_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.campaign_id='${id}'::uuid AND NEW.status='committed' THEN RAISE EXCEPTION 'QA_NARRATIVE_COMMIT_FAILURE'; END IF; RETURN NEW; END $$`,
          );
          await db.query(
            'CREATE TRIGGER qa_fail_narrative_commit BEFORE UPDATE ON game_narrative_turns FOR EACH ROW EXECUTE FUNCTION qa_fail_narrative_commit()',
          );
          try {
            await assert.rejects(() => game.processAi(id, live), /QA_NARRATIVE_COMMIT_FAILURE/);
          } finally {
            await db.query('DROP TRIGGER qa_fail_narrative_commit ON game_narrative_turns');
            await db.query('DROP FUNCTION qa_fail_narrative_commit()');
          }
          assert.deepEqual(
            (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state,
            before,
          );
          assert.equal((await jobRow(q.jobId)).status, 'result_received');
          assert.equal((await turnRow(q.turn.id)).status, 'pending');
          assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
          await game.processAi(id, live);
          await game.processAi(id, live);
          assert.equal((await turnRow(q.turn.id)).status, 'committed');
          assert.equal(live.state.narrativeCanon.turns.length, 1);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM game_events WHERE campaign_id=$1 AND kind='npc.ai.accepted'",
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'private inventory remains server-only but ownership changes still invalidate delayed narration',
        async () => {
          const id = ids[12],
            live = await prepare(id),
            item = privateInventory(live.state);
          await game.persist(id, live, live.state, 'test.private.inventory');
          const q = await queue(id);
          assert.ok(!JSON.stringify(q.p.request.context).includes(item));
          live.state.entities[actor].inventory = live.state.entities[actor].inventory.filter(
            (v) => v !== item,
          );
          live.state.entities[otherActor].inventory ??= [];
          live.state.entities[otherActor].inventory.push(item);
          live.state.entities[item].ownerId = otherActor;
          await game.persist(id, live, live.state, 'test.private.inventory.changed');
          await finish(id, live, q);
          assert.equal((await jobRow(q.jobId)).status, 'stale');
          assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
        },
      );
    } finally {
      if (game) await game.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
