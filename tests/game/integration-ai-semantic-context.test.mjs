/** Real controller/auth/provider-job/runtime commit boundary, gated local transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client, until } from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { GameController } = require('../../apps/api/dist/game/game.controller.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const {
  updateNpcAffect,
  applyNpcSpeech,
  buildNpcDecisionContext,
} = require('../../packages/game-core/dist/index.js');
const database = new Db();
const row = async (id) => (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [id])).rows[0];
await test(
  'delayed provider plans cross the real runtime commit boundary using semantic context',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register();
      const fixtures = [];
      for (let i = 0; i < 6; i++) {
        const story = await owner.request('/studio/adventures', storyInput());
        const draft = authoredDraft();
        draft.npcBehavior = 'reactive-v1';
        draft.npcs[0].x = 4;
        draft.npcs[0].y = 2;
        draft.npcs[0].goal = 'patrol';
        draft.npcs[0].patrolTarget = { x: 4, y: 2 };
        draft.objects[1].x = 4;
        draft.objects[1].y = 2;
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
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: guest.handle,
        });
        await guest.request(`/game/campaigns/${campaignId}/accept`, {});
        fixtures.push(campaignId);
      }
      await stopApi();
      const pending = new Map();
      const provider = {
        id: `semantic-fixture-${randomUUID()}`,
        version: 'v1',
        external: false,
        generate: (request) =>
          new Promise((resolve) => pending.set(request.jobId, { request, resolve })),
      };
      const ai = new NpcAiEngine(database, provider, { timeoutMs: 10000 });
      const auth = new Auth(database),
        art = new AssetReuseService(database),
        playable = new PlayableService(database, auth, art);
      game = new GameService(database, auth, playable, ai, art);
      clearInterval(game.timer); // deterministic test clock; production queue/evaluator/persistence are unchanged
      const controller = new GameController(game);
      const req = { headers: { cookie: owner.cookie } },
        ownerActor = `player-${owner.user.id}`,
        guestActor = `player-${guest.user.id}`;
      async function prepare(id) {
        await controller.snapshot(req, id);
        const live = game.live.get(id);
        live.state.tick = 80;
        live.state.entities[ownerActor].x = 3;
        live.state.entities[ownerActor].y = 2;
        live.state.entities[guestActor].x = 3;
        live.state.entities[guestActor].y = 3;
        const brain = live.state.npcBrains.gardener;
        brain.plan = [];
        brain.cursor = 0;
        brain.nextDecisionTick = 0;
        brain.living.affect = {
          fatigue: 0,
          attention: 100,
          alertness: 0,
          mood: 'calm',
          lastUpdatedTick: 80,
        };
        await game.persist(id, live, live.state, 'test.semantic.fixture');
        return live;
      }
      async function queued(id) {
        const q = await controller.aiQuote(req, id, { npcId: 'gardener', purpose: 'plan' });
        const job = await controller.aiQueue(req, id, {
          npcId: 'gardener',
          purpose: 'plan',
          operationId: randomUUID(),
          quoteId: q.id,
          consent: true,
        });
        await until(async () => pending.has(job.id), Boolean);
        assert.equal((await row(job.id)).status, 'running');
        return job;
      }
      async function finish(id, live, job, proposal) {
        const p = pending.get(job.id);
        assert.ok(p);
        p.resolve({
          proposal: proposal ?? p.request.context.mockProposal,
          requestId: `fixture-${job.id}`,
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
        });
        await until(
          () => row(job.id),
          (r) => r.status === 'result_received',
        );
        await game.processAi(id, live);
        return row(job.id);
      }
      await t.test(
        'affect bookkeeping 80→120 advances while a real provider job is pending and commits once',
        async () => {
          const id = fixtures[0],
            live = await prepare(id),
            before = structuredClone(live.state.npcBrains.gardener.living.affect),
            job = await queued(id);
          const packed = (await row(job.id)).context;
          assert.equal(packed.affect.lastUpdatedTick, undefined);
          live.state.tick = 120;
          assert.equal(updateNpcAffect(live.state, 'gardener'), true);
          assert.equal(live.state.npcBrains.gardener.living.affect.lastUpdatedTick, 120);
          const after = { ...live.state.npcBrains.gardener.living.affect, lastUpdatedTick: 80 };
          assert.deepEqual(after, before);
          await game.persist(id, live, live.state, 'test.affect.bookkeeping');
          const result = await finish(id, live, job);
          assert.equal(result.status, 'committed');
          assert.equal(result.reservation_status, 'none');
          const stored = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
            .rows[0].state;
          assert.ok(stored.npcBrains.gardener.plan.length > 0);
          await game.processAi(id, live);
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
      const changes = [
        [
          'actual mood',
          (s) => {
            s.npcBrains.gardener.living.affect.mood = 'alarmed';
          },
        ],
        [
          'new observed knowledge',
          (s) => {
            const r = applyNpcSpeech(
              s,
              ownerActor,
              'gardener',
              { channel: 'whisper', text: 'A new private fact changes the decision.' },
              { suppressReply: true },
            );
            assert.equal(r.error, undefined);
            return r.state;
          },
        ],
        [
          'public audience',
          (s) => {
            s.entities[guestActor].mapId = 'courtyard';
            s.entities[guestActor].x = 6;
            s.entities[guestActor].y = 2;
            s.entities[guestActor].revision++;
          },
        ],
        [
          'NPC position',
          (s) => {
            s.entities.gardener.x = 5;
            s.entities.gardener.revision++;
          },
        ],
      ];
      for (let i = 0; i < changes.length; i++)
        await t.test(`${changes[i][0]} change still rejects delayed work as stale`, async () => {
          const id = fixtures[i + 1],
            live = await prepare(id);
          if (changes[i][0] === 'public audience') {
            live.state.maps.courtyard.blocked.push({ x: 5, y: 2 });
            live.state.entities[guestActor].mapId = 'garden';
            live.state.entities[guestActor].x = 2;
            live.state.entities[guestActor].y = 2;
            await game.persist(id, live, live.state, 'test.hidden.audience.fixture');
          }
          const beforeContext = buildNpcDecisionContext(live.state, 'gardener'),
            job = await queued(id);
          live.state = changes[i][1](live.state) ?? live.state;
          if (changes[i][0] === 'public audience') {
            const afterContext = buildNpcDecisionContext(live.state, 'gardener');
            assert.deepEqual(afterContext.visibleEntities, beforeContext.visibleEntities);
            assert.ok(!beforeContext.communicationPolicy.publicAudienceIds.includes(guestActor));
            assert.ok(afterContext.communicationPolicy.publicAudienceIds.includes(guestActor));
          }
          await game.persist(id, live, live.state, 'test.semantic.change');
          const result = await finish(id, live, job);
          assert.equal(result.status, 'stale');
          assert.equal(result.reservation_status, 'none');
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM game_events WHERE campaign_id=$1 AND kind='npc.ai.accepted'",
                [id],
              )
            ).rows[0].n,
            0,
          );
        });
      await t.test(
        'a provider cannot turn private whispered evidence into public communication',
        async () => {
          const id = fixtures[5],
            live = await prepare(id);
          const speech = applyNpcSpeech(
            live.state,
            ownerActor,
            'gardener',
            { channel: 'whisper', text: 'PRIVATE_WHISPER_DO_NOT_BROADCAST' },
            { suppressReply: true },
          );
          assert.equal(speech.error, undefined);
          live.state = speech.state;
          await game.persist(id, live, live.state, 'test.private.whisper');
          const job = await queued(id),
            p = pending.get(job.id),
            context = p.request.context;
          assert.ok(context.communicationPolicy.publicAudienceIds.includes(guestActor));
          const evidence = context.observations.find(
            (o) => o.text === 'PRIVATE_WHISPER_DO_NOT_BROADCAST',
          );
          assert.ok(evidence);
          assert.equal(evidence.disclosure, 'participants');
          assert.ok(!evidence.audienceIds.includes(guestActor));
          const proposal = {
            ...context.mockProposal,
            actions: [
              {
                kind: 'communicate',
                targetId: ownerActor,
                channel: 'say',
                observationIds: [evidence.id],
              },
            ],
            targetRevisions: { [ownerActor]: live.state.entities[ownerActor].revision },
          };
          const result = await finish(id, live, job, proposal);
          assert.equal(result.status, 'stale');
          const view = await controller.snapshot({ headers: { cookie: guest.cookie } }, id);
          assert.ok(!JSON.stringify(view).includes('PRIVATE_WHISPER_DO_NOT_BROADCAST'));
          assert.equal(live.state.npcBrains.gardener.plan.length, 0);
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
