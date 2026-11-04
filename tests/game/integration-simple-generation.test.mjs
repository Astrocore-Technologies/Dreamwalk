/** Free composer and exact world consent against disposable PostgreSQL and an injected local provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { canonical } = require('../../apps/api/dist/ai/context.js');
const { endPlayerTurn, turnFence } = require('../../packages/game-core/dist');
const database = new Db();
const code = (expected) => (error) => error.getResponse?.().code === expected;
await test(
  'free composer defers paid generation to exact world consent',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 17; i++) {
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
      await database.tx((c) => activateReleaseDeployment(c, config));
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
        text: target ? 'Hello' : '*Кивает и поправляет плащ*',
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
      async function enterWorld(id, live, prepare = true) {
        const next = endPlayerTurn(live.state, actorId, turnFence(live.state));
        assert.equal(next.error, undefined);
        await game.persist(id, live, next.state, 'test.end-turn');
        if (prepare) await game.scheduleRoundRequests(id, live);
      }
      async function quoteWorld(id, live) {
        return game.worldGeneration.quote(owner.user.id, id, live.state, {
          operationId: randomUUID(),
        });
      }
      const consentWorld = (id, live, q) =>
        game.worldGeneration.consent(owner.user.id, id, live.state, {
          operationId: q.operationId,
          quoteId: q.quote.id,
          consent: true,
        });
      async function drain(id, live) {
        const seen = new Set();
        for (;;) {
          await game.processDecisionRequests(id, live);
          const jobs = (
            await db.query(
              "SELECT id FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('queued','reserved') ORDER BY created_at,id",
              [id],
            )
          ).rows;
          if (!jobs.length) break;
          for (const job of jobs) {
            assert.ok(!seen.has(job.id), 'Every admitted job advances exactly once');
            seen.add(job.id);
            await ai.run(job.id, async () => true);
            await game.processAi(id, live);
          }
        }
        return seen.size;
      }
      async function world(id, live) {
        await enterWorld(id, live);
        const q = await quoteWorld(id, live);
        await consentWorld(id, live, q);
        await drain(id, live);
      }
      await t.test(
        'free composer quote and cancelled world quote spend nothing; edited drafts cannot replay',
        async () => {
          const id = ids[0],
            live = await setup(id),
            body = input(live);
          const before = structuredClone(live.state),
            funds = await wallet();
          const q = await game.storyQuote(req, id, body);
          assert.equal(q.quote.external, false);
          assert.equal(q.quote.credits, 0);
          assert.equal(q.quote.requiresConsent, false);
          assert.deepEqual(live.state, before);
          assert.deepEqual(await requests(id), []);
          await assert.rejects(
            submit(id, { ...body, text: 'Different' }, q),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.deepEqual(live.state, before);
          await submit(id, body, q);
          await enterWorld(id, live);
          const frozen = structuredClone(live.state),
            pending = await requests(id);
          const paid = await quoteWorld(id, live);
          assert.equal(paid.quote.chargeUnit, 'sparks');
          assert.equal(paid.quote.demo, false);
          assert.ok(paid.quote.estimatedTotalMicros > 0);
          assert.ok(paid.quote.providerReserveMicros >= paid.quote.estimatedTotalMicros);
          await game.processDecisionRequests(id, live);
          assert.deepEqual(live.state, frozen);
          assert.ok((await requests(id)).every((r) => !r.job_id));
          assert.equal((await requests(id)).length, pending.length);
          assert.deepEqual(await wallet(), funds);
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'double submit and double world consent bind exactly the frozen native requests',
        async () => {
          const id = ids[1],
            live = await setup(id),
            body = input(live);
          const q = await game.storyQuote(req, id, body),
            funds = await wallet(),
            beforeCalls = calls;
          const [a, b] = await Promise.all([submit(id, body, q), submit(id, body, q)]);
          assert.equal(a.id, b.id);
          assert.equal(live.state.turnController.phase, 'player');
          assert.equal(calls, beforeCalls);
          assert.deepEqual(await wallet(), funds);
          await enterWorld(id, live);
          const pending = await requests(id);
          assert.ok(pending.some((r) => r.purpose === 'plan'));
          assert.ok(pending.some((r) => r.purpose === 'speech'));
          const paid = await quoteWorld(id, live);
          const batch = (
            await db.query('SELECT entries FROM game_world_generation_batches WHERE id=$1', [
              paid.quote.id,
            ])
          ).rows[0];
          assert.equal(batch.entries.length, pending.length);
          await Promise.all([consentWorld(id, live, paid), consentWorld(id, live, paid)]);
          assert.deepEqual(await wallet(), funds);
          await drain(id, live);
          const completed = await requests(id);
          for (const entry of batch.entries) {
            const request = completed.find((r) => r.id === entry.requestId);
            assert.ok(request.job_id, request.result_code);
            const job = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [request.job_id]))
              .rows[0];
            assert.equal(job.quote_id, entry.quote.id);
            assert.deepEqual(job.context, pending.find((r) => r.id === entry.requestId).context);
            assert.equal(job.status, 'committed');
          }
          assert.equal(calls - beforeCalls, batch.entries.length);
          assert.equal((await wallet()).held_subunits, '0');
          await consentWorld(id, live, paid);
          await drain(id, live);
          assert.equal(calls - beforeCalls, batch.entries.length);
        },
      );
      for (const [index, change] of [
        [2, 'phase'],
        [4, 'semantic'],
        [6, 'expired'],
      ]) {
        await t.test(
          `${change} drift rejects world consent without repricing or spending`,
          async () => {
            const id = ids[index],
              live = await setup(id),
              body = input(live);
            const q = await game.storyQuote(req, id, body);
            await submit(id, body, q);
            await enterWorld(id, live);
            const paid = await quoteWorld(id, live),
              funds = await wallet(),
              beforeCalls = calls;
            if (change === 'phase') live.state.turnController.phaseEpoch++;
            else if (change === 'semantic')
              live.state.npcBrains.keeper.living.personality.publicSpeechStyle =
                'dramatically changed';
            else
              await db.query(
                "UPDATE game_world_generation_batches SET expires_at=now()-interval '1 second' WHERE id=$1",
                [paid.quote.id],
              );
            await assert.rejects(consentWorld(id, live, paid), code('GENERATION_QUOTE_STALE'));
            assert.ok((await requests(id)).every((r) => !r.job_id));
            assert.deepEqual(await wallet(), funds);
            assert.equal(calls, beforeCalls);
          },
        );
      }
      await t.test('revoked membership denies unpaid world consent and dispatch', async () => {
        const id = ids[5],
          live = await setup(id),
          body = input(live);
        const q = await game.storyQuote(req, id, body);
        await submit(id, body, q);
        await enterWorld(id, live);
        const paid = await quoteWorld(id, live),
          funds = await wallet(),
          beforeCalls = calls;
        await db.query(
          "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
          [id, owner.user.id],
        );
        await assert.rejects(consentWorld(id, live, paid), code('FORBIDDEN'));
        await game.processDecisionRequests(id, live);
        assert.ok((await requests(id)).every((r) => !r.job_id));
        assert.deepEqual(await wallet(), funds);
        assert.equal(calls, beforeCalls);
      });
      await t.test(
        'already pending legacy speech and director recover in place without another message',
        async () => {
          for (const [id, target] of [
            [ids[7], true],
            [ids[8], false],
          ]) {
            const live = await setup(id);
            if (!target) {
              // A pre-upgrade director-only request had no local NPC response.
              // Keep that original recovery fixture distinct from new area emotes.
              Object.assign(live.state.entities.keeper, { x: 19, y: 19 });
              await game.persist(id, live, live.state, 'test.legacy-director-alone');
            }
            const body = input(live, target);
            const q = await game.storyQuote(req, id, body);
            await submit(id, body, q);
            // Reproduce a persisted pre-upgrade unpaid turn, not the new composer policy.
            await db.query(
              "UPDATE game_story_turns SET context=context-'generationPolicy' WHERE id=$1",
              [q.turnId],
            );
            await db.query(
              "UPDATE game_npc_decision_requests SET context=context-'generationPolicy' WHERE campaign_id=$1",
              [id],
            );
            const funds = await wallet(),
              beforeCalls = calls;
            await enterWorld(id, live, false);
            await game.processDecisionRequests(id, live);
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
            assert.equal(
              request.status,
              'scheduled',
              JSON.stringify({
                target,
                purpose: request.purpose,
                code: request.result_code,
                requestCount: (await requests(id)).length,
              }),
            );
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
        'full runtime context drift cannot spend an accepted aggregate quote',
        async () => {
          const id = ids[9],
            live = await setup(id),
            body = input(live);
          const q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          await enterWorld(id, live);
          const paid = await quoteWorld(id, live),
            funds = await wallet(),
            beforeCalls = calls;
          await consentWorld(id, live, paid);
          await db.query(
            `UPDATE game_npc_decision_requests SET context=context||'{"latePrivateMetadata":true}'::jsonb WHERE campaign_id=$1`,
            [id],
          );
          await game.processDecisionRequests(id, live);
          assert.ok((await requests(id)).every((r) => !r.job_id));
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
        'native admission lock rejects late full-context drift with unchanged semantic hash',
        async () => {
          const id = ids[16],
            live = await setup(id),
            body = input(live);
          const q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          await enterWorld(id, live);
          const paid = await quoteWorld(id, live),
            funds = await wallet(),
            beforeCalls = calls;
          await consentWorld(id, live, paid);
          const originalQueue = ai.queue.bind(ai);
          let attempts = 0;
          ai.queue = async (request) => {
            attempts++;
            assert.ok(request.expectedRuntimeContextDigest);
            await db.query(
              `UPDATE game_npc_decision_requests SET context=context||'{"latePrivateMetadata":true}'::jsonb WHERE id=$1`,
              [request.runtimeRequestId],
            );
            return originalQueue(request);
          };
          try {
            await game.processDecisionRequests(id, live);
          } finally {
            ai.queue = originalQueue;
          }
          assert.ok(attempts > 0, 'The race reaches native financial admission');
          assert.ok((await requests(id)).every((r) => !r.job_id));
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
        'director application evidence precedes durable admission and survives a crash',
        async () => {
          const id = ids[3],
            live = await setup(id),
            body = input(live, false);
          const q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          await enterWorld(id, live);
          const paid = await quoteWorld(id, live);
          await consentWorld(id, live, paid);
          const originalQueue = ai.queue.bind(ai);
          let crashed = false;
          ai.queue = async (request) => {
            if (request.scope.purpose !== 'story_turn') return originalQueue(request);
            const saved = (
              await db.query('SELECT context FROM game_story_turns WHERE id=$1', [q.turnId])
            ).rows[0].context;
            assert.equal(
              saved.turnBasedDeferredDirector,
              true,
              'Application evidence must precede financial admission',
            );
            assert.equal(saved.contextHash, request.context.contextHash);
            const admitted = await originalQueue(request);
            if (!crashed) {
              crashed = true;
              throw new Error('SYNTHETIC_CRASH_AFTER_DURABLE_ADMISSION');
            }
            return admitted;
          };
          try {
            await drain(id, live);
          } finally {
            ai.queue = originalQueue;
          }
          assert.equal(crashed, true);
          const director = (await requests(id)).find((r) => r.purpose === 'story_turn');
          assert.ok(director.job_id, director.result_code);
          game.live.delete(id);
          await game.snapshot(req, id);
          const reloaded = game.live.get(id);
          await drain(id, reloaded);
          const job = (
            await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [director.job_id])
          ).rows[0];
          assert.equal(job.status, 'committed');
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test(
        'accepted world work survives restart without another quote or consent',
        async () => {
          const id = ids[10],
            live = await setup(id),
            body = input(live, false);
          const q = await game.storyQuote(req, id, body);
          await submit(id, body, q);
          await enterWorld(id, live);
          const paid = await quoteWorld(id, live),
            beforeCalls = calls;
          await consentWorld(id, live, paid);
          await game.processDecisionRequests(id, live);
          const admitted = (await requests(id)).filter((r) => r.job_id);
          assert.equal(admitted.length, 1, 'Native jobs are serialized');
          assert.equal(calls, beforeCalls);
          game.live.delete(id);
          await game.snapshot(req, id);
          const reloaded = game.live.get(id);
          assert.equal(reloaded.aiPending, true);
          await drain(id, reloaded);
          const completed = await requests(id);
          assert.ok(
            completed.every((r) => r.job_id),
            JSON.stringify(completed.map((r) => r.result_code)),
          );
          assert.equal(calls - beforeCalls, completed.length);
          assert.equal((await wallet()).held_subunits, '0');
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
            assert.ok(request.job_id, request.result_code);
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
              BigInt((await requests(id)).filter((r) => r.job_id).length) * 60n, // Each bounded synthetic request costs 30 provider micros at the version-2 debit rate.
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
        assert.ok(request.job_id, request.result_code);
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
          const deferred = (await requests(id)).find((r) => r.purpose === 'story_turn');
          assert.ok(deferred);
          assert.equal(deferred.job_id, null);
          const stored = (
            await db.query('SELECT context FROM game_story_turns WHERE id=$1', [q.turnId])
          ).rows[0].context;
          assert.equal(stored.untrustedRoleplay[0].verified, false);
          assert.equal(stored.untrustedRoleplay[0].text, 'Кивает и поправляет плащ');
          await world(id, live);
          const prepared = (await requests(id)).find((r) => r.id === deferred.id);
          assert.ok(prepared.job_id, prepared.result_code);
          assert.deepEqual(prepared.context.untrustedRoleplay, stored.untrustedRoleplay);
          const job = (
            await db.query('SELECT status,context FROM npc_ai_jobs WHERE id=$1', [prepared.job_id])
          ).rows[0];
          assert.equal(job.status, 'committed');
          assert.deepEqual(job.context.untrustedRoleplay, stored.untrustedRoleplay);
          const after = physical(live.state);
          assert.deepEqual(
            Object.fromEntries(Object.keys(before).map((id) => [id, after[id]])),
            before,
            'Director canon may expand, but RP does not mutate existing physical entities',
          );
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
