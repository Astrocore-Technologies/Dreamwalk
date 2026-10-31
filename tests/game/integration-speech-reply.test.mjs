/** Exact ordinary speech trigger through real auth, PostgreSQL jobs and delayed local provider. */
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
const row = async (id) => (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [id])).rows[0];
await test(
  'ordinary speech binds its admitted question across delayed durable provider jobs',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register();
      const story = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 6; i++) {
        const { campaignId } = await owner.request('/game/campaigns', {
          playableVersionId: story.playableVersionId,
        });
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: guest.handle,
        });
        await guest.request(`/game/campaigns/${campaignId}/accept`, {});
        ids.push(campaignId);
      }
      await stopApi();
      const pending = new Map();
      const provider = {
        id: `speech-binding-${randomUUID()}`,
        version: 'v1',
        external: false,
        generate: (request) =>
          new Promise((resolve) => pending.set(request.jobId, { request, resolve })),
      };
      const ai = new NpcAiEngine(database, provider, { timeoutMs: 20000 });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      const controller = new GameController(game),
        req = { headers: { cookie: owner.cookie } };
      const actor = `player-${owner.user.id}`,
        other = `player-${guest.user.id}`;
      async function prepare(id) {
        await controller.snapshot(req, id);
        const live = game.live.get(id);
        Object.assign(live.state.entities[actor], { x: 5, y: 4 });
        Object.assign(live.state.entities[other], { mapId: 'roof', x: 2, y: 3 });
        for (const brain of Object.values(live.state.npcBrains)) {
          brain.plan = [];
          brain.cursor = 0;
          brain.nextDecisionTick = 99999;
        }
        const prior = applyNpcSpeech(
          live.state,
          actor,
          'keeper',
          { channel: 'whisper', text: 'Earlier I called our route the amber bridge.' },
          { suppressReply: true },
        );
        assert.equal(prior.error, undefined);
        live.state = prior.state;
        await game.persist(id, live, live.state, 'test.speech.fixture');
        return live;
      }
      async function queue(id, channel = 'whisper') {
        const input = 'What name did I give our route earlier?';
        const result = await controller.command(req, id, {
          protocolVersion: 1,
          operationId: randomUUID(),
          type: 'npc.speech',
          npcId: 'keeper',
          speech: { channel, text: input },
        });
        assert.equal(result.status, 'committed');
        assert.ok(result.decisionRequestId);
        await game.processDecisionRequests(id, game.live.get(id));
        const request = await until(
          async () =>
            (
              await db.query('SELECT job_id FROM game_npc_decision_requests WHERE id=$1', [
                result.decisionRequestId,
              ])
            ).rows[0],
          (r) => !!r?.job_id,
        );
        await until(async () => pending.has(request.job_id), Boolean);
        const p = pending.get(request.job_id),
          context = p.request.context;
        assert.equal(context.currentUtterance.untrustedUtterance, input);
        assert.equal(context.currentUtterance.observationId, context.replyToObservationId);
        assert.ok(
          context.claims.some(
            (c) => c.untrustedUtterance === 'Earlier I called our route the amber bridge.',
          ),
        );
        return { jobId: request.job_id, p, context };
      }
      async function finish(id, live, q) {
        q.p.resolve({
          proposal: { text: 'You called it the amber bridge.' },
          requestId: `fixture-${q.jobId}`,
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
        });
        await until(
          () => row(q.jobId),
          (r) => r.status === 'result_received',
        );
        await game.processAi(id, live);
        return row(q.jobId);
      }
      await t.test(
        'valid exact question retains earlier allowed memory and commits only once',
        async () => {
          const id = ids[0],
            live = await prepare(id),
            q = await queue(id);
          assert.equal((await finish(id, live, q)).status, 'committed');
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
          const view = await controller.snapshot({ headers: { cookie: guest.cookie } }, id);
          assert.ok(!JSON.stringify(view).includes('You called it the amber bridge.'));
        },
      );
      await t.test(
        'new public listener invalidates the delayed whole-audience response',
        async () => {
          const id = ids[5],
            live = await prepare(id),
            q = await queue(id, 'say');
          Object.assign(live.state.entities[other], { mapId: 'observatory', x: 5, y: 5 });
          await game.persist(id, live, live.state, 'test.speech.audience');
          assert.equal((await finish(id, live, q)).status, 'stale');
          assert.throws(() =>
            game.speechContext(
              live.state,
              'keeper',
              actor,
              'say',
              undefined,
              undefined,
              live.state.npcBrains.keeper.living.observations.find(
                (o) => o.text === 'Earlier I called our route the amber bridge.',
              ).id,
            ),
          );
        },
      );
      const mutations = [
        [
          'missing admitted observation',
          (m, id) => {
            m.observations = m.observations.filter((o) => o.id !== id);
          },
        ],
        [
          'changed question',
          (m, id) => {
            m.observations.find((o) => o.id === id).text = 'Different question';
          },
        ],
        [
          'foreign speaker',
          (m, id) => {
            m.observations.find((o) => o.id === id).actorId = other;
          },
        ],
        [
          'private disclosure cannot become an allowed reply',
          (m, id) => {
            m.observations.find((o) => o.id === id).disclosure = 'private';
          },
        ],
      ];
      for (let i = 0; i < mutations.length; i++)
        await t.test(mutations[i][0], async () => {
          const id = ids[i + 1],
            live = await prepare(id),
            q = await queue(id);
          mutations[i][1](live.state.npcBrains.keeper.living, q.context.replyToObservationId);
          await game.persist(id, live, live.state, 'test.speech.changed');
          assert.equal((await finish(id, live, q)).status, 'stale');
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
    } finally {
      if (game) await game.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
