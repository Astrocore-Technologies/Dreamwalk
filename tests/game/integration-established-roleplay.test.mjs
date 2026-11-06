/** Disposable PostgreSQL, real authenticated API service/HTTP bootstrap and actual
 * OpenAiNpcProvider with injected transport. No external provider or production. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider.js');
const {
  endPlayerTurn,
  turnFence,
  buildNarrativeContext,
} = require('../../packages/game-core/dist');
const database = new Db();
const sha = (body) => createHash('sha256').update(body).digest('hex');

await test(
  'established RP persists atomically through consent, native dispatch, reload and replay',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const reader = await client().registerLegacyFixture();
      const outsider = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const scenarios = ['public', 'private', 'other_player', 'hidden', 'legacy'];
      const ids = [];
      for (const scenario of scenarios) {
        const { campaignId } = await owner.request('/game/campaigns', {
          turnBased: true,
          playableVersionId: source.playableVersionId,
        });
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: reader.handle,
        });
        await reader.request(`/game/campaigns/${campaignId}/accept`, {});
        ids.push({ id: campaignId, scenario });
      }
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=1000000',
        [owner.user.id],
      );
      const profile = requestEstimateOwnerProfile();
      profile.text.maxOutputTokens = 4096;
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      const actorId = `player-${owner.user.id}`,
        readerId = `player-${reader.user.id}`;
      const dispatches = [];
      const provider = new OpenAiNpcProvider(
        {
          ...config.text,
          enabled: true,
          apiKey: 'synthetic-only',
          version: 'established-rp-pg-v1',
          maxModelInputTokens: config.text.contextTokens,
          maxResponseBytes: 128000,
        },
        async (url, init) => {
          // Native preflight token counting is part of the same frozen-body proof.
          if (String(url).includes('input_tokens'))
            return new Response(JSON.stringify({ input_tokens: 100 }));
          const body = JSON.parse(init.body);
          const { context } = JSON.parse(body.input);
          assert.equal(context.mode, 'director');
          assert.ok(context.establishedRoleplay);
          const text = context.segments[0].text;
          const effects = [{ kind: 'door_state', targetId: 'door', open: true, locked: false }];
          if (text.includes('other_player'))
            effects.push({
              kind: 'actor_state',
              targetId: readerId,
              lifeState: 'dead',
              vitality: 0,
            });
          if (text.includes('hidden'))
            effects.push({
              kind: 'door_state',
              targetId: 'concealed-door',
              open: true,
              locked: false,
            });
          const description = text.includes('private')
            ? 'PRIVATE_ESTABLISHED_CANARY: дверь открылась.'
            : 'Дверь открылась.';
          const answer = {
            status: 'ready',
            code: null,
            travelIntent: null,
            steps: context.segments.map((segment) => ({
              segmentIndex: segment.index,
              action: null,
              reply: null,
              replyNpcId: null,
              replyContextHash: null,
              narrativeImpact: null,
              sceneEncounter: null,
              establishedEvents:
                segment.kind === 'attempt' ? [{ description, entityIds: ['door'], effects }] : null,
            })),
            narrative: {
              narration: description,
              newScene: null,
              newNpc: null,
              newItem: null,
              evidenceIds: [],
            },
          };
          dispatches.push({ turnId: context.turnId, body: init.body, context });
          return new Response(
            JSON.stringify({
              id: `synthetic-${context.turnId}`,
              status: 'completed',
              service_tier: 'default',
              usage: { input_tokens: 100, output_tokens: 50 },
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(answer) }],
                },
              ],
            }),
          );
        },
      );
      const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(provider, authority), {
        externalApproved: true,
        creditPrice: 0,
        providerUpperMicros: config.text.upperMicros,
        providerCapMicros: config.aggregateCapMicros,
        version: 'established-rp-pg-v1',
      });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      game.dispatchAi = () => {};
      const req = { headers: { cookie: owner.cookie } },
        third = { headers: { cookie: reader.cookie } },
        foreign = { headers: { cookie: outsider.cookie } };
      const savedTurn = async (id) =>
        (await db.query('SELECT * FROM game_story_turns WHERE id=$1', [id])).rows[0];
      const feed = async (id) =>
        (await db.query('SELECT * FROM game_story_feed WHERE turn_id=$1 ORDER BY ordinal', [id]))
          .rows;
      const requests = async (id) =>
        (await db.query('SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1', [id]))
          .rows;
      async function reload(id) {
        game.live.delete(id);
        await game.snapshot(req, id, false);
        return game.live.get(id);
      }
      for (const { id, scenario } of ids)
        await t.test(scenario, async () => {
          let live = await reload(id);
          Object.assign(live.state.entities[actorId], { x: 5, y: 4, inventory: [] });
          Object.assign(live.state.entities.keeper, { x: 6, y: 4 });
          Object.assign(live.state.entities[readerId], { x: 5, y: 3 });
          Object.assign(live.state.entities.door, { x: 5, y: 5, open: false, locked: true });
          live.state.entities['concealed-door'] = {
            id: 'concealed-door',
            kind: 'door',
            mapId: 'roof',
            x: 5,
            y: 5,
            revision: 1,
            open: false,
            locked: true,
          };
          for (const brain of Object.values(live.state.npcBrains)) {
            brain.plan = [];
            brain.cursor = 0;
            brain.nextDecisionTick = 999999;
          }
          if (scenario === 'legacy') {
            live.state.narrativeConstraints = {
              ...live.state.narrativeConstraints,
              maxTurns: 1,
              maxScenes: 1,
              maxSupportingNpcs: 1,
            };
            live.state.narrativeCanon = {
              revision: 1025,
              turns: Array.from({ length: 1025 }, (_, index) => ({
                id: randomUUID(),
                actorId,
                requestHash: `legacy-${index}`,
                tick: 0,
                narration: `Prior ordinary event ${index}.`,
                evidenceIds: [],
              })),
            };
          }
          await game.persist(id, live, live.state, 'test.established-rp.fixture');
          const revision = live.state.narrativeCanon?.revision ?? 0,
            beforeCalls = dispatches.length;
          const body = {
            operationId: randomUUID(),
            text: `*Намертво закрытая дверь открылась. ${scenario}*`,
            channel: scenario === 'private' ? 'whisper' : 'say',
            ...(scenario === 'private' ? { targetNpcId: 'keeper' } : {}),
            replyLocale: 'ru',
            expectedCanonRevision: revision,
            turnFence: turnFence(live.state),
          };
          const quote = await game.storyQuote(req, id, body);
          assert.equal(quote.status, 'quoted');
          const submission = {
            ...body,
            turnId: quote.turnId,
            quoteId: quote.quote.id,
            consent: true,
            confirmedActionHash: quote.confirmationHash,
          };
          const posted = await game.storySubmit(req, id, submission);
          assert.equal(posted.status, 'committed');
          assert.equal(live.state.entities.door.open, false);
          assert.equal(dispatches.length, beforeCalls);
          assert.equal((await requests(id)).length, 1);
          live = await reload(id);
          while (live.state.turnController.phase === 'player') {
            const ended = endPlayerTurn(
              live.state,
              live.state.turnController.activeActorId,
              turnFence(live.state),
            );
            assert.equal(ended.error, undefined);
            await game.persist(id, live, ended.state, 'test.established-rp.end-turn');
          }
          await game.story.prepareWorldRequests(id, live);
          const prepared = (await requests(id))[0];
          assert.ok(prepared.context.establishedRoleplay);
          assert.equal(
            JSON.stringify(prepared.context.establishedRoleplay).includes('concealed-door'),
            false,
          );
          const batch = await game.worldGeneration.quote(owner.user.id, id, live.state, {
            operationId: randomUUID(),
          });
          const consent = {
            operationId: batch.operationId,
            quoteId: batch.quote.id,
            consent: true,
          };
          await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
          live = await reload(id);
          await game.processDecisionRequests(id, live);
          const scheduled = (await requests(id))[0];
          assert.equal(scheduled.status, 'scheduled', scheduled.result_code);
          // Turn transitions legitimately invalidate prior movement generations.
          // Snapshot the peer immediately before the RP job, preserving every field.
          const otherPlayer = structuredClone(live.state.entities[readerId]);
          await ai.run(scheduled.job_id, async () => true);
          const received = (
            await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [scheduled.job_id])
          ).rows[0];
          assert.equal(received.status, 'result_received', received.failure_code);
          assert.equal(dispatches.length, beforeCalls + 1);
          assert.equal(received.request_snapshot.bodySha256, sha(dispatches.at(-1).body));
          live = await reload(id);
          await game.processAi(id, live);
          const persisted = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
            .rows[0].state;
          const completed = await savedTurn(posted.id),
            entries = await feed(posted.id);
          const forbidden = ['hidden', 'other_player'].includes(scenario);
          if (forbidden) {
            assert.notEqual(completed.result_code, null);
            assert.equal(persisted.entities.door.open, false);
            assert.equal(persisted.narrativeCanon?.revision ?? 0, revision);
            assert.equal(
              entries.some((row) => row.entry.kind === 'narration'),
              false,
            );
            assert.equal(
              entries.some((row) => row.entry.code === 'ACTION_SUCCEEDED'),
              false,
            );
          } else {
            assert.equal(completed.status, 'committed', completed.result_code);
            assert.equal(completed.result_code, null);
            assert.equal(persisted.entities.door.open, true);
            assert.equal(persisted.entities.door.locked, false);
            assert.equal(persisted.narrativeCanon.revision, revision + 1);
            const canon = persisted.narrativeCanon.turns.filter((turn) => turn.id === posted.id);
            assert.equal(canon.length, 1);
            assert.equal(canon[0].establishedEvents.length, 1);
            assert.ok(canon[0].storyProposalHash);
            assert.equal(entries.filter((row) => row.entry.kind === 'narration').length, 1);
            assert.equal(entries.filter((row) => row.entry.kind === 'outcome').length, 1);
            if (scenario === 'private') {
              assert.equal(
                JSON.stringify(await game.storyFeed(third, id)).includes(
                  'PRIVATE_ESTABLISHED_CANARY',
                ),
                false,
              );
              assert.equal(
                JSON.stringify(buildNarrativeContext(persisted, readerId, 'Continue')).includes(
                  'PRIVATE_ESTABLISHED_CANARY',
                ),
                false,
              );
              assert.equal(
                (await game.snapshot(third, id, false)).projection.entities.find(
                  (entity) => entity.id === 'door',
                ).open,
                true,
              );
            }
            live = await reload(id);
            await game.processAi(id, live);
            await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
            assert.equal((await game.storySubmit(req, id, submission)).status, 'committed');
            assert.equal((await feed(posted.id)).length, entries.length);
            assert.equal(
              live.state.narrativeCanon.turns.filter((turn) => turn.id === posted.id).length,
              1,
            );
          }
          assert.deepEqual(persisted.entities[readerId], otherPlayer);
          assert.equal(persisted.entities['concealed-door'].open, false);
          await assert.rejects(() => game.storyFeed(foreign, id));
          assert.equal(
            dispatches.length,
            beforeCalls + 1,
            'No repair, continuation or replay dispatch',
          );
        });
    } finally {
      await game?.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
