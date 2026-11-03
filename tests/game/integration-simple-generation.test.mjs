/** Exact composer consent against disposable PostgreSQL and an injected local provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { canonical } = require('../../apps/api/dist/ai/context.js');
const { endPlayerTurn, turnFence } = require('../../packages/game-core/dist');
const database = new Db();
const code = (expected) => (error) => error.getResponse?.().code === expected;
await test(
  'single composer quote binds only its exact deferred release replies',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 16; i++) {
        const made = await owner.request('/game/campaigns', {
          turnBased: true,
          playableVersionId: source.playableVersionId,
        });
        ids.push(made.campaignId);
      }
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=1000000',
        [owner.user.id],
      );
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({
          ...requestEstimateOwnerProfile(),
          aggregateCapMicros: 10000000,
        }),
      });
      const authority = new GenerationAuthority(database, config);
      let calls = 0;
      const inner = {
        id: 'composer-synthetic',
        version: 'v1',
        external: true,
        prepareTextRequest(purpose, context) {
          const body = JSON.stringify(canonical({ purpose, context }));
          return {
            body,
            snapshot: estimateTextRequest(body, config.text, 'composer-synthetic-v1'),
          };
        },
        async generate(request) {
          calls++;
          return {
            proposal: request.context.untrustedRoleplay?.some((entry) =>
              entry.text.includes('горсть монет'),
            )
              ? { text: 'Трактирщик ставит перед тобой миску супа.' }
              : request.context.mockProposal,
            requestId: `synthetic-${request.jobId}`,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              costMicros: 30,
              costEvidence: 'configured_rates',
            },
          };
        },
      };
      const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(inner, authority), {
        externalApproved: true,
        creditPrice: 0,
        providerUpperMicros: config.text.upperMicros,
        providerCapMicros: config.aggregateCapMicros,
        version: 'composer-synthetic-v1',
      });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      game.dispatchAi = () => {}; // Tests own synthetic dispatch; no asynchronous provider races.
      const req = { headers: { cookie: owner.cookie } },
        actorId = `player-${owner.user.id}`;
      const wallet = async () =>
        (
          await db.query(
            'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
            [owner.user.id],
          )
        ).rows[0];
      const requests = async (id) =>
        (
          await db.query(
            'SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows;
      async function setup(id) {
        await game.snapshot(req, id);
        const live = game.live.get(id);
        Object.assign(live.state.entities[actorId], { x: 5, y: 4 });
        for (const brain of Object.values(live.state.npcBrains)) {
          brain.plan = [];
          brain.cursor = 0;
          brain.nextDecisionTick = 999999;
        }
        await game.persist(id, live, live.state, 'test.composer.fixture');
        return live;
      }
      const input = (live, target = true) => ({
        operationId: randomUUID(),
        text: 'Hello',
        channel: 'say',
        replyLocale: 'en',
        ...(target ? { targetNpcId: 'keeper' } : {}),
        expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
        turnFence: turnFence(live.state),
      });
      const submit = (id, body, q) =>
        game.storySubmit(req, id, {
          ...body,
          turnId: q.turnId,
          quoteId: q.quote.id,
          consent: true,
          confirmedActionHash: q.confirmationHash,
        });
      async function world(id, live) {
        const next = endPlayerTurn(live.state, actorId, turnFence(live.state));
        assert.equal(next.error, undefined);
        await game.persist(id, live, next.state, 'test.end-turn');
        await game.processDecisionRequests(id, live);
      }
      await t.test(
        'quote/cancel changes no game state, wallet or provider; edited draft cannot use old quote',
        async () => {
          const id = ids[0],
            live = await setup(id),
            body = input(live),
            before = structuredClone(live.state),
            funds = await wallet();
          const q = await game.storyQuote(req, id, body);
          assert.equal(q.quote.chargeUnit, 'sparks');
          assert.equal(q.quote.demo, false);
          assert.ok(q.quote.estimatedTotalMicros > 0);
          assert.ok(q.quote.providerReserveMicros >= q.quote.estimatedTotalMicros);
          assert.deepEqual(live.state, before);
          assert.deepEqual(await wallet(), funds);
          assert.equal(calls, 0);
          assert.deepEqual(await requests(id), []);
          await assert.rejects(
            submit(id, { ...body, text: 'Different' }, q),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.deepEqual(live.state, before);
          assert.deepEqual(await wallet(), funds);
        },
      );
      await t.test(
        'one confirm sends, does not end turn, double click produces one exact paid reply',
        async () => {
          const id = ids[1],
            live = await setup(id),
            body = input(live),
            q = await game.storyQuote(req, id, body);
          const [a, b] = await Promise.all([submit(id, body, q), submit(id, body, q)]);
          assert.equal(a.id, b.id);
          assert.equal(live.state.turnController.phase, 'player');
          assert.equal(calls, 0);
          assert.equal((await requests(id)).length, 1);
          assert.equal((await wallet()).held_subunits, '0');
          await world(id, live);
          const r = (await requests(id))[0];
          assert.equal(r.status, 'scheduled', r.result_code);
          const job = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [r.job_id])).rows[0];
          const saved = (
            await db.query('SELECT context FROM game_story_turns WHERE id=$1', [q.turnId])
          ).rows[0].context;
          assert.deepEqual(job.context, saved.quotedReplies[0].request.context);
          assert.equal(job.quote_id, saved.quotedReplies[0].quote.id);
          await ai.run(job.id, async () => true);
          await game.processAi(id, live);
          assert.equal(calls, 1);
          assert.equal(
            (
              await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [
                (await requests(id))[0].job_id,
              ])
            ).rows[0].status,
            'committed',
          );
          assert.equal((await wallet()).held_subunits, '0');
          await game.processDecisionRequests(id, live);
          assert.equal(calls, 1);
          await game.scheduleAutonomousRequests(id, live);
          assert.equal(
            (await requests(id)).length,
            1,
            'Ordinary speech does not create a second unquoted world request',
          );
        },
      );
      await t.test(
        'changed world never reprices silently; inline recovery uses same message and native once-only consent',
        async () => {
          const id = ids[2],
            live = await setup(id),
            body = input(live),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          // A changed phase epoch models an intervening participant reaction; original quote is stale.
          live.state.turnController.phaseEpoch++;
          await game.persist(id, live, live.state, 'test.other-player-reaction');
          const funds = await wallet();
          await world(id, live);
          assert.equal((await requests(id))[0].result_code, 'GENERATION_QUOTE_STALE');
          assert.equal((await requests(id))[0].job_id, null);
          assert.deepEqual(await wallet(), funds);
          const feed = await game.storyFeed(req, id);
          assert.equal(
            feed.turns.find((turn) => turn.id === q.turnId).generationNeedsConfirmation,
            true,
          );
          const operationId = randomUUID();
          const recovery = await game.storyReplyQuote(req, id, q.turnId, { operationId });
          assert.deepEqual(await wallet(), funds);
          assert.deepEqual(
            await game.storyReplyQuote(req, id, q.turnId, { operationId }),
            recovery,
          );
          assert.equal((await requests(id))[0].result_code, 'GENERATION_QUOTE_STALE');
          const confirmation = { operationId, quoteId: recovery.quote.id, consent: true };
          await Promise.all([
            game.storyReplyConsent(req, id, q.turnId, confirmation),
            game.storyReplyConsent(req, id, q.turnId, confirmation),
          ]);
          await game.processDecisionRequests(id, live);
          const r = (await requests(id))[0];
          assert.equal(r.status, 'scheduled', r.result_code);
          assert.equal((await requests(id)).length, 1);
          await game.storyReplyConsent(req, id, q.turnId, confirmation);
          await ai.run(r.job_id, async () => true);
          await game.processAi(id, live);
          assert.equal(
            (
              await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [
                (await requests(id))[0].job_id,
              ])
            ).rows[0].status,
            'committed',
          );
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test(
        'scene director also consumes original composer quote, not a fresh quote',
        async () => {
          const id = ids[3],
            live = await setup(id),
            body = input(live, false),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          await world(id, live);
          const r = (await requests(id))[0];
          assert.equal(r.status, 'scheduled', r.result_code);
          const stored = (
            await db.query('SELECT context FROM game_story_turns WHERE id=$1', [q.turnId])
          ).rows[0].context;
          const job = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [r.job_id])).rows[0];
          assert.equal(job.quote_id, stored.quotedReplies[0].quote.id);
          assert.deepEqual(job.context, stored.quotedReplies[0].request.context);
          await ai.run(job.id, async () => true);
          await game.processAi(id, live);
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test(
        'same phase with changed semantic NPC context requires fresh consent',
        async () => {
          const id = ids[4],
            live = await setup(id),
            body = input(live),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          const funds = await wallet(),
            beforeCalls = calls;
          live.state.npcBrains.keeper.living.personality.publicSpeechStyle = 'dramatically changed';
          await game.persist(id, live, live.state, 'test.changed-knowledge');
          await world(id, live);
          assert.equal((await requests(id))[0].result_code, 'GENERATION_QUOTE_STALE');
          assert.equal((await requests(id))[0].job_id, null);
          assert.deepEqual(await wallet(), funds);
          assert.equal(calls, beforeCalls);
        },
      );
      await t.test('revoked membership denies unpaid consent and dispatch', async () => {
        const id = ids[5],
          live = await setup(id),
          body = input(live),
          q = await game.storyQuote(req, id, body);
        await submit(id, body, q);
        const funds = await wallet(),
          beforeCalls = calls;
        await db.query(
          "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
          [id, owner.user.id],
        );
        await world(id, live);
        assert.equal((await requests(id))[0].job_id, null);
        await assert.rejects(
          game.storyReplyQuote(req, id, q.turnId, { operationId: randomUUID() }),
        );
        assert.deepEqual(await wallet(), funds);
        assert.equal(calls, beforeCalls);
      });
      await t.test(
        'director recovery receipt survives scheduling and exact-operation replay',
        async () => {
          const id = ids[6],
            live = await setup(id),
            body = input(live, false),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          live.state.turnController.phaseEpoch++;
          await game.persist(id, live, live.state, 'test.changed-director-phase');
          await world(id, live);
          assert.equal((await requests(id))[0].result_code, 'GENERATION_QUOTE_STALE');
          const operationId = randomUUID();
          const recovery = await game.storyReplyQuote(req, id, q.turnId, { operationId });
          const confirmation = { operationId, quoteId: recovery.quote.id, consent: true };
          await game.storyReplyConsent(req, id, q.turnId, confirmation);
          await game.processDecisionRequests(id, live);
          const r = (await requests(id))[0];
          assert.equal(r.status, 'scheduled', r.result_code);
          await game.storyReplyConsent(req, id, q.turnId, confirmation);
          await ai.run(r.job_id, async () => true);
          await game.processAi(id, live);
          await game.storyReplyConsent(req, id, q.turnId, confirmation);
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test(
        'already pending legacy speech and director recover in place without another message',
        async () => {
          for (const [id, target] of [
            [ids[7], true],
            [ids[8], false],
          ]) {
            const live = await setup(id),
              body = input(live, target);
            const releaseGeneration = ai.releaseGeneration.bind(ai);
            ai.releaseGeneration = () => false; // Reproduce pre-upgrade free composer quote only.
            const q = await game.storyQuote(req, id, body);
            await submit(id, body, q);
            ai.releaseGeneration = releaseGeneration;
            const funds = await wallet(),
              beforeCalls = calls;
            await world(id, live);
            const pending = (await requests(id))[0];
            assert.equal(pending.result_code, 'GENERATION_QUOTE_STALE');
            assert.equal(pending.job_id, null);
            assert.deepEqual(await wallet(), funds);
            assert.equal(calls, beforeCalls);
            assert.equal(
              (await game.storyFeed(req, id)).turns.find((turn) => turn.id === q.turnId)
                .generationNeedsConfirmation,
              true,
            );
            const operationId = randomUUID();
            const quote = await game.storyReplyQuote(req, id, q.turnId, { operationId });
            await game.storyReplyConsent(req, id, q.turnId, {
              operationId,
              quoteId: quote.quote.id,
              consent: true,
            });
            await game.processDecisionRequests(id, live);
            const request = (await requests(id))[0];
            assert.equal(request.status, 'scheduled', request.result_code);
            assert.equal((await requests(id)).length, 1);
            await ai.run(request.job_id, async () => true);
            await game.processAi(id, live);
            assert.equal((await wallet()).held_subunits, '0');
            assert.equal(
              await game.story.requireLegacyReplyConsent(id, request),
              false,
              'Existing job cannot be reset/reconsented',
            );
          }
        },
      );
      await t.test(
        'locked native queue rejects full-context drift even when semantic contextHash is unchanged',
        async () => {
          const id = ids[9],
            live = await setup(id),
            body = input(live),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          const funds = await wallet(),
            beforeCalls = calls,
            originalQueue = ai.queue.bind(ai);
          ai.queue = async (request) => {
            assert.ok(request.expectedRuntimeContextDigest);
            await db.query(
              'UPDATE game_npc_decision_requests SET context=context||\'{"latePrivateMetadata":true}\'::jsonb WHERE id=$1',
              [request.runtimeRequestId],
            );
            return originalQueue(request);
          };
          try {
            await world(id, live);
          } finally {
            ai.queue = originalQueue;
          }
          const request = (await requests(id))[0];
          assert.equal(request.result_code, 'GENERATION_QUOTE_STALE');
          assert.equal(request.job_id, null);
          assert.equal(
            (await db.query('SELECT count(*) n FROM npc_ai_jobs WHERE campaign_id=$1', [id]))
              .rows[0].n,
            '0',
          );
          assert.deepEqual(await wallet(), funds);
          assert.equal(calls, beforeCalls);
        },
      );
      await t.test(
        'director application context survives a crash immediately after native job admission',
        async () => {
          const id = ids[10],
            live = await setup(id),
            body = input(live, false),
            q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          const beforeCalls = calls,
            originalQueue = ai.queue.bind(ai);
          ai.queue = async (request) => {
            const saved = (
              await db.query('SELECT context FROM game_story_turns WHERE id=$1', [q.turnId])
            ).rows[0].context;
            assert.equal(
              saved.turnBasedDeferredDirector,
              true,
              'Application context must precede the financial admission',
            );
            assert.equal(saved.contextHash, request.context.contextHash);
            await originalQueue(request);
            throw new Error('SYNTHETIC_CRASH_AFTER_DURABLE_ADMISSION');
          };
          try {
            await world(id, live);
          } finally {
            ai.queue = originalQueue;
          }
          const request = (await requests(id))[0];
          assert.equal(request.status, 'scheduled');
          assert.ok(request.job_id);
          assert.equal(calls, beforeCalls);
          game.live.delete(id); // Restart view: load only durable world/AI evidence.
          await game.snapshot(req, id);
          const reloaded = game.live.get(id);
          assert.equal(reloaded.aiPending, true);
          await ai.run(request.job_id, async () => true);
          await game.processAi(id, reloaded);
          assert.equal(
            (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [request.job_id])).rows[0]
              .status,
            'committed',
          );
          assert.equal((await wallet()).held_subunits, '0');
          assert.equal(calls, beforeCalls + 1);
          assert.equal((await requests(id)).length, 1);
        },
      );
      await t.test(
        'NPC prompt separates natural stockless services from real item and wallet mutations',
        () => {
          const {
            buildOpenAiNpcRequestBody,
          } = require('../../apps/api/dist/ai/openai-provider.js');
          const request = JSON.parse(
            buildOpenAiNpcRequestBody({ model: 'synthetic-only', maxOutputTokens: 128 }, 'speech', {
              contextHash: 'synthetic-rp',
              replyLocale: 'ru',
              itemProvisioning: { stock: [], ownedItems: [] },
            }),
          );
          assert.match(request.instructions, /innkeeper may naturally serve soup/);
          assert.match(request.instructions, /without itemStock, ownedItems or itemIntents/);
          assert.match(request.instructions, /does not create an inventory item or map object/);
          assert.doesNotMatch(
            request.instructions,
            /Without an allowed item capability, discuss or clarify/,
          );
        },
      );
      const physical = (state) =>
        Object.fromEntries(
          Object.entries(state.entities).map(([id, entity]) => [
            id,
            {
              kind: entity.kind,
              x: entity.x,
              y: entity.y,
              mapId: entity.mapId,
              inventory: entity.inventory,
              vitality: entity.vitality,
              ownerId: entity.ownerId,
              itemStock: entity.itemStock,
              open: entity.open,
              locked: entity.locked,
            },
          ]),
        );
      await t.test(
        'innkeeper RP coins and soup work without stock, fake items or extra replies',
        async () => {
          for (const [id, text] of [
            [ids[11], '*Ложит на стол горсть монет*'],
            [ids[12], '*Ложит на стол горсть монет* Добрый вечер.'],
          ]) {
            const live = await setup(id);
            delete live.state.entities.keeper.itemStock;
            live.state.entities.keeper.inventory = [];
            await game.persist(id, live, live.state, 'test.stockless-innkeeper');
            const before = physical(live.state),
              body = { ...input(live), text, replyLocale: 'ru' },
              funds = await wallet();
            const q = await game.storyQuote(req, id, body);
            assert.equal(q.status, 'quoted', q.code);
            assert.deepEqual(q.actionPreview, []);
            assert.deepEqual(physical(live.state), before);
            assert.deepEqual(await wallet(), funds);
            await submit(id, body, q);
            assert.deepEqual(
              physical(live.state),
              before,
              'Roleplay itself cannot materialize items/coins',
            );
            const planned = await requests(id);
            assert.equal(planned.length, 1, 'An emote with speech shares a single NPC response');
            assert.equal(
              planned[0].context.untrustedRoleplay[0].text,
              'Ложит на стол горсть монет',
            );
            assert.equal(planned[0].context.untrustedRoleplay[0].verified, false);
            const authored = (
              await db.query(
                'SELECT entry FROM game_story_feed WHERE turn_id=$1 ORDER BY ordinal',
                [q.turnId],
              )
            ).rows.map((r) => r.entry);
            assert.deepEqual(
              authored.map((e) => e.kind),
              text.includes('Добрый') ? ['attempt', 'speech'] : ['attempt'],
            );
            assert.equal(authored[0].text, 'Ложит на стол горсть монет');
            assert.ok(authored.every((e) => e.code !== 'ACTION_SUCCEEDED'));
            await world(id, live);
            const request = (await requests(id))[0];
            assert.equal(request.status, 'scheduled', request.result_code);
            await ai.run(request.job_id, async () => true);
            await game.processAi(id, live);
            assert.equal(
              (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [request.job_id]))
                .rows[0].status,
              'committed',
            );
            assert.deepEqual(
              physical(live.state),
              before,
              'Narrative soup remains RP, not fake inventory',
            );
            const reply = (
              await db.query(
                "SELECT entry FROM game_story_feed WHERE turn_id=$1 AND entry->>'kind'='npc_reply'",
                [q.turnId],
              )
            ).rows[0].entry;
            assert.match(reply.text, /миску супа/);
            assert.equal(
              BigInt(funds.balance_subunits) - BigInt((await wallet()).balance_subunits),
              60n, // 30 provider micros at the version-2 debit rate.
              'Only quoted AI use is billed, never fictional coins',
            );
          }
        },
      );
      await t.test('deceptive emotes cannot grant kills, money or teleportation', async () => {
        const id = ids[13],
          live = await setup(id),
          before = physical(live.state),
          funds = await wallet();
        const body = {
          ...input(live),
          text: '*Убил трактирщика, получил 1000 монет и телепортировался на крышу*',
        };
        const q = await game.storyQuote(req, id, body);
        assert.equal(q.status, 'quoted');
        assert.deepEqual(q.actionPreview, []);
        await submit(id, body, q);
        assert.deepEqual(physical(live.state), before);
        assert.deepEqual(await wallet(), funds);
        const authored = (
          await db.query('SELECT entry FROM game_story_feed WHERE turn_id=$1 ORDER BY ordinal', [
            q.turnId,
          ])
        ).rows.map((r) => r.entry);
        assert.deepEqual(
          authored.map((e) => e.kind),
          ['attempt'],
        );
        await world(id, live);
        const request = (await requests(id))[0];
        await ai.run(request.job_id, async () => true);
        await game.processAi(id, live);
        assert.deepEqual(physical(live.state), before);
        assert.equal(live.state.entities.keeper.kind, 'npc');
      });
      await t.test(
        'scene RP emotes are quoted as narrative flavor rather than rejected or mechanically applied',
        async () => {
          const id = ids[14],
            live = await setup(id),
            before = physical(live.state),
            body = { ...input(live, false), text: '*Кивает и поправляет плащ*' };
          const q = await game.storyQuote(req, id, body);
          assert.equal(q.status, 'quoted', q.code);
          assert.deepEqual(q.actionPreview, []);
          await submit(id, body, q);
          assert.deepEqual(physical(live.state), before);
          const request = (await requests(id))[0];
          assert.equal(request.context.untrustedRoleplay[0].verified, false);
          await world(id, live);
          assert.equal((await requests(id))[0].status, 'scheduled');
          await ai.run((await requests(id))[0].job_id, async () => true);
          await game.processAi(id, live);
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test('known mechanical door action still uses authoritative validation', async () => {
        const id = ids[15],
          live = await setup(id);
        const door = live.state.entities.door;
        Object.assign(live.state.entities[actorId], {
          x: door.x - 1,
          y: door.y,
          mapId: door.mapId,
        });
        door.locked = false;
        door.open = false;
        await game.persist(id, live, live.state, 'test.validated-door');
        const body = { ...input(live, false), text: '*open door*' },
          q = await game.storyQuote(req, id, body);
        assert.equal(q.status, 'quoted', q.code);
        assert.equal(q.actionPreview[0].action.kind, 'open');
        assert.equal(live.state.entities.door.open, false);
        await submit(id, body, q);
        assert.equal(live.state.entities.door.open, true);
        assert.equal((await requests(id)).length, 0);
      });
    } finally {
      await game?.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
