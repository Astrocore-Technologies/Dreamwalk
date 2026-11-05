/** Disposable PostgreSQL, synthetic tariffs and injected local provider only. No external calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { purgeNpcAiData } from '../../scripts/npc-ai-data-requests.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { Db } = require('../../apps/api/dist/db');
const { Auth } = require('../../apps/api/dist/auth');
const { GameService } = require('../../apps/api/dist/game/game.service');
const { PlayableService } = require('../../apps/api/dist/game/playable.service');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider');
const { KnownNpcSettlement } = require('../../apps/api/dist/game/known-npc-settlement');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
const { ProviderFailure } = require('../../apps/api/dist/ai/types');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates');
const { canonical } = require('../../apps/api/dist/ai/context');
const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
const core = require('../../packages/game-core/dist');
const database = new Db();
await test(
  'bounded optional round speech is crash-safe, finite and never legacy-implied',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 12; i++)
        ids.push(
          (
            await owner.request('/game/campaigns', {
              turnBased: true,
              playableVersionId: source.playableVersionId,
            })
          ).campaignId,
        );
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,10000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=10000000',
        [owner.user.id],
      );
      const profile = requestEstimateOwnerProfile();
      profile.text.contextBudgetTokens = 65536;
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      let calls = 0,
        speechCalls = 0,
        unknownSpeech = false,
        rejectedSpeech = false,
        silentSpeech = false,
        twoCommunications = false;
      const text = 'Я помню твой вопрос. Давай разберёмся вместе.';
      const inner = {
        id: 'round-speech-synthetic',
        version: 'v1',
        external: true,
        prepareTextRequest(purpose, context) {
          const body = JSON.stringify(canonical({ purpose, context }));
          return {
            body,
            snapshot: estimateTextRequest(body, config.text, 'round-speech-price-v1'),
          };
        },
        async generate(request) {
          calls++;
          if (request.purpose === 'speech') {
            speechCalls++;
            if (unknownSpeech) throw new ProviderFailure('SYNTHETIC_TRANSPORT_LOST', true);
          }
          return {
            proposal:
              request.purpose === 'speech'
                ? {
                    ...(silentSpeech ? { silent: true } : { text }),
                    ...(rejectedSpeech ? { actionIntent: { actions: [{ kind: 'wait' }] } } : {}),
                  }
                : twoCommunications
                  ? {
                      ...request.context.mockProposal,
                      actions: [
                        request.context.mockProposal.actions[0],
                        { ...request.context.mockProposal.actions[0], channel: 'whisper' },
                      ],
                    }
                  : request.context.mockProposal,
            requestId: `synthetic-${request.jobId}`,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              costMicros: 30,
              costEvidence: 'configured_rates',
              costVerifiedForSparks: true,
            },
          };
        },
      };
      const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(inner, authority), {
        externalApproved: true,
        creditPrice: 0,
        providerUpperMicros: config.text.upperMicros,
        providerCapMicros: config.aggregateCapMicros,
        version: 'round-speech-policy-v1',
      });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      game.dispatchAi = () => {};
      const req = { headers: { cookie: owner.cookie } },
        actor = `player-${owner.user.id}`;
      const batch = new WorldGenerationBatch(database, ai);
      const requests = async (id) =>
        (
          await db.query(
            'SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows;
      async function plannedRound(id, bounded, explicit = false, doubleSpeech = false) {
        await game.snapshot(req, id);
        const live = game.live.get(id);
        live.paused = false;
        if (doubleSpeech) {
          live.state.turnController.ruleset.maxNpcActions = 2;
          live.state.turnController.ruleset.main = 2;
        }
        const npc = live.state.entities.keeper;
        Object.assign(live.state.entities[actor], { mapId: npc.mapId, x: npc.x, y: npc.y + 1 });
        const heard = core.applyNpcSpeech(
          live.state,
          actor,
          'keeper',
          { channel: 'say', text: 'Расскажи об этом месте.' },
          { suppressReply: true },
        );
        assert.equal(heard.error, undefined);
        live.state = heard.state;
        const brain = live.state.npcBrains.keeper;
        const observation = brain.living.observations.find(
          (item) => item.actorId === actor && item.kind === 'said',
        );
        assert.ok(observation);
        brain.plan = [
          {
            kind: 'communicate',
            targetId: actor,
            channel: 'say',
            observationIds: [observation.id],
          },
        ];
        brain.cursor = 0;
        brain.planMapId = npc.mapId;
        brain.movementGeneration = npc.movementGeneration ?? 0;
        brain.nextDecisionTick = 999999;
        await game.persist(id, live, live.state, 'test.optional-speech.fixture');
        const command = {
          protocolVersion: 1,
          operationId: randomUUID(),
          type: 'turn.end',
          turnFence: core.turnFence(live.state),
          ordinaryGeneration: !explicit,
          ...(bounded ? { ordinarySpeechPolicy: 'bounded-npc-speech-v1' } : {}),
        };
        assert.equal((await game.command(req, id, command)).status, 'committed');
        if (explicit) {
          await game.scheduleRoundRequests(id, live);
          const operationId = randomUUID();
          const quoted = await batch.quote(owner.user.id, id, live.state, {
            operationId,
            autonomousSpeechPolicy: 'bounded-npc-speech-v1',
            automaticKnownCostPolicy: 'known-cost-v1',
          });
          await batch.consent(owner.user.id, id, live.state, {
            operationId,
            quoteId: quoted.quote.id,
            consent: true,
            autonomousSpeechPolicyHash: quoted.quote.autonomousSpeechPolicyHash,
            automaticKnownCostPolicyHash: quoted.quote.automaticKnownCostPolicyHash,
          });
        } else await game.admitOrdinaryRound(id);
        const accepted = (
          await db.query(
            "SELECT * FROM game_world_generation_batches WHERE campaign_id=$1 AND state='accepted'",
            [id],
          )
        ).rows[0];
        assert.ok(accepted, 'round admission persists before native dispatch');
        assert.equal(accepted.autonomous_speech_entries.length, bounded ? 1 : 0);
        assert.equal(accepted.entries.length, 1);
        assert.equal(accepted.entries[0].purpose, 'plan');
        await game.processDecisionRequests(id, live);
        const plan = (await requests(id)).find((row) => row.purpose === 'plan');
        assert.ok(plan.job_id);
        twoCommunications = doubleSpeech;
        await ai.run(plan.job_id, async () => true);
        twoCommunications = false;
        await game.processAi(id, live);
        assert.equal(
          (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [plan.job_id])).rows[0]
            .status,
          'committed',
        );
        assert.equal(live.state.npcBrains.keeper.plan[0]?.kind, 'communicate');
        const before = structuredClone(live.state.npcUtterances ?? []);
        await game.advanceTurnWorld(id, live);
        const speech = (await requests(id)).find((row) => row.purpose === 'speech');
        assert.ok(speech, 'paid plan produces one separate exact pending speech request');
        assert.equal(speech.status, 'queued');
        assert.equal(speech.job_id, null);
        assert.deepEqual(
          live.state.npcUtterances ?? [],
          before,
          'no free acknowledgement or invented speech before native result',
        );
        return { live, accepted, plan, speech, before };
      }
      await t.test(
        'one End turn covers an optional child, rollback/restart/concurrent bind never duplicate it',
        async () => {
          const id = ids[0],
            startCalls = calls,
            f = await plannedRound(id, true);
          const original = JSON.stringify([
            f.accepted.entries,
            f.accepted.autonomous_speech_entries,
            f.accepted.quote,
          ]);
          assert.equal(calls, startCalls + 1);
          assert.equal(speechCalls, 0);
          assert.ok(f.accepted.quote.optionalAutonomousSpeechSparkSubunits);
          await db.query(
            "UPDATE npc_ai_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
            [f.plan.job_id],
          );
          await ai.pruneContexts();
          assert.ok(
            (await db.query('SELECT proposal FROM npc_ai_jobs WHERE id=$1', [f.plan.job_id]))
              .rows[0].proposal,
            'unbound accepted future speech retains the original action proof beyond the normal private retention window',
          );
          await assert.rejects(
            database.tx(async (c) => {
              assert.ok(
                await batch.bindAutonomousSpeech(
                  c,
                  f.accepted,
                  structuredClone(f.speech),
                  f.live.state,
                ),
              );
              throw Error('SYNTHETIC_CRASH_BEFORE_BIND_COMMIT');
            }),
            /SYNTHETIC_CRASH_BEFORE_BIND_COMMIT/,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                [f.accepted.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            0,
          );
          const restored = new WorldGenerationBatch(database, ai);
          const bound = await Promise.all([
            restored.quotedWorldRequest(id, structuredClone(f.speech)),
            restored.quotedWorldRequest(id, structuredClone(f.speech)),
          ]);
          assert.ok(bound[0]);
          assert.equal(bound[0].quote.id, bound[1].quote.id);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                [f.accepted.id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(calls, startCalls + 1, 'binding itself is local and cannot generate/count');
          f.live.state = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])
          ).rows[0].state;
          await game.processDecisionRequests(id, f.live);
          await game.processDecisionRequests(id, f.live);
          const child = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.ok(child.job_id);
          const pendingReceipt = (await batch.status(owner.user.id, id, f.live.state))
            .speechReceipts[0];
          assert.equal(pendingReceipt.status, 'held');
          assert.equal(pendingReceipt.capturedSubunits, null);
          assert.equal(pendingReceipt.outcome, 'pending');
          const beforeDelivery = structuredClone(f.live.state);
          await ai.run(child.job_id, async () => true);
          await game.processAi(id, f.live);
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          assert.equal((f.live.state.npcUtterances ?? []).length, f.before.length + 1);
          assert.equal(f.live.state.npcUtterances.at(-1).text, text);
          assert.equal(calls, startCalls + 2);
          assert.equal(speechCalls, 1);
          const delivered = f.live.state.npcUtterances.at(-1);
          const feedRows = async () =>
            (await db.query('SELECT * FROM game_story_feed WHERE npc_job_id=$1', [child.job_id]))
              .rows;
          const feed = (await feedRows())[0];
          assert.equal((await feedRows()).length, 1);
          assert.equal(feed.turn_id, null);
          assert.equal(feed.npc_request_id, child.id);
          assert.equal(feed.entry.sourceId, delivered.id);
          assert.equal(feed.entry.text, delivered.text);
          assert.equal(feed.channel, child.context.channel);
          assert.deepEqual(feed.audience_ids, delivered.audienceIds);
          await database.tx((c) =>
            game.story.writeAutonomousReply(
              c,
              id,
              beforeDelivery,
              f.live.state,
              { id: child.job_id, npcId: child.npc_id, context: child.context },
              f.live.eventSeq,
            ),
          );
          await game.processAi(id, f.live);
          assert.equal(
            (await feedRows()).length,
            1,
            'replayed native delivery cannot duplicate the durable feed',
          );
          const receipt = (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0];
          assert.equal(receipt.id, child.job_id);
          assert.equal(receipt.status, 'settled');
          assert.equal(receipt.capturedSubunits, '60');
          assert.equal(receipt.outcome, 'delivered');
          f.live.state.npcUtterances = [];
          await game.persist(id, f.live, f.live.state, 'test.hot-utterances-pruned');
          await db.query(
            "UPDATE npc_ai_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
            [child.job_id],
          );
          await ai.pruneContexts();
          assert.equal(
            (await db.query('SELECT context_hash FROM npc_ai_jobs WHERE id=$1', [child.job_id]))
              .rows[0].context_hash,
            'retention-expired',
          );
          const reloadedFeed = await game.storyFeed(req, id);
          assert.equal(
            reloadedFeed.entries.filter((entry) => entry.id === feed.id && entry.text === text)
              .length,
            1,
            'actual SQL feed survives the hot utterance and private job-context pruning',
          );
          assert.deepEqual(
            (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0],
            receipt,
            'the immutable receipt and delivered outcome survive context pruning',
          );
          assert.deepEqual(
            (await batch.status(owner.user.id, id, f.live.state, child.job_id)).speechReceipts ??
              [],
            [],
          );
          await assert.rejects(batch.status(owner.user.id, id, f.live.state, 'not-a-uuid'));
          await assert.rejects(batch.status(randomUUID(), id, f.live.state));
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            1,
          );
          const after = (
            await db.query('SELECT * FROM game_world_generation_batches WHERE id=$1', [
              f.accepted.id,
            ])
          ).rows[0];
          assert.equal(
            JSON.stringify([after.entries, after.autonomous_speech_entries, after.quote]),
            original,
          );
          await assert.rejects(
            db.query(
              "UPDATE game_world_generation_batches SET entries=entries||'[{}]'::jsonb WHERE id=$1",
              [f.accepted.id],
            ),
            /WORLD_BATCH_CONSENT_IMMUTABLE/,
          );
          await assert.rejects(
            db.query(
              "UPDATE game_autonomous_speech_bindings SET context_digest='changed' WHERE request_id=$1",
              [child.id],
            ),
            /AUTONOMOUS_SPEECH_BINDING_IMMUTABLE/,
          );
          await assert.rejects(
            database.tx(async (c) => {
              await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
              const financialBefore = (
                await c.query(
                  'SELECT id,status,reserved_subunits,captured_subunits FROM spark_holds WHERE owner_id=$1 ORDER BY id',
                  [owner.user.id],
                )
              ).rows;
              await purgeNpcAiData(c, owner.user.id, [{ id }]);
              assert.equal(
                (
                  await c.query(
                    'SELECT count(*)::int AS n FROM game_story_feed WHERE npc_job_id=$1',
                    [child.job_id],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (
                  await c.query(
                    `SELECT count(*)::int AS n FROM game_story_feed WHERE campaign_id=$1 AND entry->>'sourceId'=$2`,
                    [id, delivered.id],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (
                  await c.query(
                    'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                    [f.accepted.id],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (
                  await c.query(
                    'SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1',
                    [id],
                  )
                ).rows[0].n,
                0,
              );
              assert.deepEqual(
                (
                  await c.query(
                    'SELECT id,status,reserved_subunits,captured_subunits FROM spark_holds WHERE owner_id=$1 ORDER BY id',
                    [owner.user.id],
                  )
                ).rows,
                financialBefore,
                'erasure does not delete financial receipt evidence',
              );
              throw Error('SYNTHETIC_ERASURE_ROLLBACK');
            }),
            /SYNTHETIC_ERASURE_ROLLBACK/,
          );
          await database.tx(async (c) => {
            await c.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
              f.accepted.id,
            ]);
            await c.query('DELETE FROM game_npc_decision_requests WHERE id=$1', [child.id]);
            assert.equal(
              (
                await c.query(
                  'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                  [f.accepted.id],
                )
              ).rows[0].n,
              0,
              'normal source erasure cascades private child linkage without weakening immutable consent',
            );
          });
        },
      );
      await t.test(
        'legacy uncovered speech skips without a new confirmation or charge and the round finishes',
        async () => {
          const id = ids[1],
            startCalls = calls,
            f = await plannedRound(id, false);
          const beforeStatus = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(beforeStatus.communicationConsentRequired, undefined);
          assert.deepEqual(
            await database.tx((c) => batch.eligible(c, owner.user.id, id, f.live.state, false)),
            [],
            'a mixed fresh batch cannot accidentally admit uncovered legacy speech',
          );
          await game.processDecisionRequests(id, f.live);
          assert.equal(await batch.quotedWorldRequest(id, f.speech), null);
          const skipped = (await requests(id)).find((row) => row.id === f.speech.id);
          assert.equal(skipped.status, 'failed');
          assert.equal(skipped.job_id, null);
          assert.equal(skipped.result_code, 'AUTONOMOUS_SPEECH_LEGACY_UNCOVERED');
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.communicationConsentRequired, undefined);
          assert.equal(status.speechSkips[0].reason, 'legacy_uncovered');
          assert.equal(calls, startCalls + 1);
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          assert.deepEqual(f.live.state.npcUtterances ?? [], f.before);
          assert.equal(calls, startCalls + 1);
        },
      );
      for (const explicit of [false, true])
        await t.test(
          `known rejected child settles once through ${explicit ? 'restart recovery' : 'ordinary finalization'} without another consent`,
          async () => {
            const id = ids[explicit ? 3 : 2],
              startCalls = calls,
              f = await plannedRound(id, true, explicit);
            await game.processDecisionRequests(id, f.live);
            const child = (await requests(id)).find((row) => row.purpose === 'speech');
            assert.ok(child.job_id);
            rejectedSpeech = true;
            await ai.run(child.job_id, async () => true);
            rejectedSpeech = false;
            await game.processAi(id, f.live);
            const job = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [child.job_id]))
              .rows[0];
            assert.equal(job.status, 'stale');
            const recovery = new KnownNpcSettlement(database, auth, authority);
            if (explicit) {
              assert.equal(
                (await db.query('SELECT status FROM spark_holds WHERE id=$1', [job.spark_hold_id]))
                  .rows[0].status,
                'pending',
              );
              await recovery.recoverPending();
            }
            const hold = (
              await db.query('SELECT * FROM spark_holds WHERE id=$1', [job.spark_hold_id])
            ).rows[0];
            assert.equal(hold.status, 'settled');
            assert.equal(hold.captured_subunits, '60');
            const receipt = (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0];
            assert.equal(receipt.status, 'settled');
            assert.equal(receipt.capturedSubunits, '60');
            assert.equal(receipt.outcome, 'failed');
            const before = (
              await db.query('SELECT count(*)::int AS n FROM spark_ledger WHERE owner_id=$1', [
                owner.user.id,
              ])
            ).rows[0].n;
            await recovery.recoverPending();
            await game.advanceTurnWorld(id, f.live);
            assert.equal(f.live.state.turnController.phase, 'player');
            assert.deepEqual(f.live.state.npcUtterances ?? [], f.before);
            assert.equal(calls, startCalls + 2);
            assert.equal(
              (
                await db.query('SELECT count(*)::int AS n FROM spark_ledger WHERE owner_id=$1', [
                  owner.user.id,
                ])
              ).rows[0].n,
              before,
            );
          },
        );
      await t.test(
        'accepted silence has a real cost receipt and stays silent after retention',
        async () => {
          const id = ids[5],
            f = await plannedRound(id, true);
          await game.processDecisionRequests(id, f.live);
          const child = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.ok(child.job_id);
          silentSpeech = true;
          await ai.run(child.job_id, async () => true);
          silentSpeech = false;
          await game.processAi(id, f.live);
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          const receipt = (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0];
          assert.equal(receipt.outcome, 'silent');
          assert.equal(receipt.capturedSubunits, '60');
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM game_story_feed WHERE npc_job_id=$1', [
                child.job_id,
              ])
            ).rows[0].n,
            0,
          );
          await db.query(
            "UPDATE npc_ai_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
            [child.job_id],
          );
          await ai.pruneContexts();
          assert.deepEqual(
            (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0],
            receipt,
          );
        },
      );
      await t.test(
        'legacy exact speech consent produces the same owner-only persisted receipt',
        async () => {
          const id = ids[6],
            f = await plannedRound(id, false);
          // Emulate the historical pre-upgrade eligibility selector only while
          // constructing already accepted exact consent. Current runtime is unchanged.
          const historical = new WorldGenerationBatch(database, ai);
          historical.eligible = async () => [f.speech];
          const operationId = randomUUID();
          const quoted = await historical.quote(owner.user.id, id, f.live.state, {
            operationId,
            automaticKnownCostPolicy: 'known-cost-v1',
          });
          await historical.consent(owner.user.id, id, f.live.state, {
            operationId,
            quoteId: quoted.quote.id,
            consent: true,
            automaticKnownCostPolicyHash: quoted.quote.automaticKnownCostPolicyHash,
          });
          await game.processDecisionRequests(id, f.live);
          const child = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.ok(child.job_id);
          await ai.run(child.job_id, async () => true);
          await game.processAi(id, f.live);
          await game.advanceTurnWorld(id, f.live);
          const receipt = (await batch.status(owner.user.id, id, f.live.state)).speechReceipts[0];
          assert.equal(receipt.id, child.job_id);
          assert.equal(receipt.outcome, 'delivered');
          assert.equal(receipt.capturedSubunits, '60');
        },
      );
      await t.test(
        'a second distinct same-NPC communicate is visibly skipped without mid-round consent or extra spending',
        async () => {
          const id = ids[7],
            startCalls = calls,
            f = await plannedRound(id, true, false, true);
          assert.equal(f.live.state.npcBrains.keeper.plan.length, 2);
          await game.processDecisionRequests(id, f.live);
          const first = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.ok(first.job_id);
          await ai.run(first.job_id, async () => true);
          await game.processAi(id, f.live);
          await game.advanceTurnWorld(id, f.live);
          const second = (await requests(id)).find(
            (row) => row.purpose === 'speech' && row.id !== first.id,
          );
          assert.ok(second, 'the second communication is durably queued');
          assert.equal(second.context.channel, 'whisper');
          assert.equal(second.context.worldPlanCommunication.cursor, 1);
          for (let i = 0; i < 2; i++) await game.processDecisionRequests(id, f.live);
          const waiting = (await requests(id)).find((row) => row.id === second.id);
          assert.equal(waiting.status, 'failed');
          assert.equal(waiting.job_id, null);
          assert.equal(waiting.result_code, 'AUTONOMOUS_SPEECH_ALLOWANCE_EXHAUSTED');
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.communicationConsentRequired, undefined);
          assert.deepEqual(status.pendingSpeechIds ?? [], []);
          assert.equal(status.speechSkips[0].id, second.id);
          assert.equal(status.speechSkips[0].reason, 'allowance_exhausted');
          assert.equal(
            calls,
            startCalls + 2,
            'the original consent only permits plan plus one speech',
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                [f.accepted.id],
              )
            ).rows[0].n,
            1,
          );
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          assert.equal(calls, startCalls + 2);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            1,
          );
          const receipts = (await batch.status(owner.user.id, id, f.live.state)).speechReceipts;
          assert.equal(receipts.length, 1);
          assert.ok(
            receipts.every((row) => row.outcome === 'delivered' && row.capturedSubunits === '60'),
          );
        },
      );
      await t.test(
        'unavailable future pricing is an unspent visible skip with no intermediate confirmation',
        async () => {
          const id = ids[8],
            startCalls = calls,
            f = await plannedRound(id, true);
          const snapshot = ai.autonomousSpeechRequestSnapshot;
          ai.autonomousSpeechRequestSnapshot = () => undefined;
          try {
            await game.processDecisionRequests(id, f.live);
          } finally {
            ai.autonomousSpeechRequestSnapshot = snapshot;
          }
          const skipped = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.equal(skipped.status, 'failed');
          assert.equal(skipped.job_id, null);
          assert.equal(skipped.result_code, 'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE');
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.communicationConsentRequired, undefined);
          assert.equal(status.speechSkips[0].reason, 'allowance_unavailable');
          assert.equal(calls, startCalls + 1);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'local native quote refusal rolls back and skips without holding money or asking again',
        async () => {
          const id = ids[9],
            startCalls = calls,
            f = await plannedRound(id, true);
          const upper = ai.policy.providerUpperMicros;
          ai.policy.providerUpperMicros = 1;
          try {
            await game.processDecisionRequests(id, f.live);
          } finally {
            ai.policy.providerUpperMicros = upper;
          }
          const skipped = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.equal(skipped.status, 'failed');
          assert.equal(skipped.job_id, null);
          assert.equal(skipped.result_code, 'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE');
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.communicationConsentRequired, undefined);
          assert.equal(status.speechSkips[0].reason, 'allowance_unavailable');
          assert.equal(calls, startCalls + 1);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_autonomous_speech_bindings WHERE batch_id=$1',
                [f.accepted.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'legacy pruned parent proof safely skips instead of leaving hidden queued speech',
        async () => {
          const id = ids[10],
            startCalls = calls,
            f = await plannedRound(id, false);
          await db.query(
            "UPDATE npc_ai_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
            [f.plan.job_id],
          );
          await ai.pruneContexts();
          assert.equal(
            (await db.query('SELECT proposal FROM npc_ai_jobs WHERE id=$1', [f.plan.job_id]))
              .rows[0].proposal,
            null,
          );
          await game.processDecisionRequests(id, f.live);
          const skipped = (await requests(id)).find((row) => row.id === f.speech.id);
          assert.equal(skipped.status, 'failed');
          assert.equal(skipped.job_id, null);
          assert.equal(skipped.result_code, 'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE');
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.communicationConsentRequired, undefined);
          assert.equal(status.speechSkips[0].reason, 'allowance_unavailable');
          assert.equal(calls, startCalls + 1);
        },
      );
      await t.test(
        'a stale-only bound child before native enqueue skips on same-fence resume without re-quoting or charging',
        async () => {
          const id = ids[11],
            startCalls = calls,
            f = await plannedRound(id, true);
          const bound = await batch.quotedWorldRequest(id, f.speech);
          assert.ok(bound?.quote.id);
          const native = (
            await db.query('SELECT * FROM npc_ai_quotes WHERE id=$1', [bound.quote.id])
          ).rows[0];
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM spark_holds WHERE id=$1', [
                native.spark_quote_id,
              ])
            ).rows[0].n,
            0,
          );
          await db.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
            f.accepted.id,
          ]);
          assert.deepEqual(core.turnFence(f.live.state), f.accepted.turn_fence);
          await game.processDecisionRequests(id, f.live);
          const skipped = (await requests(id)).find((row) => row.id === f.speech.id);
          assert.equal(skipped.status, 'failed');
          assert.equal(skipped.job_id, null);
          assert.equal(skipped.result_code, 'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE');
          await game.advanceTurnWorld(id, f.live);
          assert.equal(f.live.state.turnController.phase, 'player');
          assert.equal(
            (await batch.status(owner.user.id, id, f.live.state)).speechSkips[0].reason,
            'allowance_unavailable',
          );
          assert.equal(calls, startCalls + 1);
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM spark_holds WHERE id=$1', [
                native.spark_quote_id,
              ])
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_quotes WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'uncertain child cost blocks further admission and never retries speech after recovery',
        async () => {
          const id = ids[4],
            startCalls = calls,
            f = await plannedRound(id, true);
          await game.processDecisionRequests(id, f.live);
          const child = (await requests(id)).find((row) => row.purpose === 'speech');
          assert.ok(child.job_id);
          unknownSpeech = true;
          await ai.run(child.job_id, async () => true);
          const job = (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [child.job_id]))
            .rows[0];
          assert.equal(job.status, 'reconciling');
          for (let n = 0; n < 3; n++) await game.advanceTurnWorld(id, f.live);
          assert.equal(calls, startCalls + 2);
          assert.deepEqual(f.live.state.npcUtterances ?? [], f.before);
          const status = await batch.status(owner.user.id, id, f.live.state);
          assert.equal(status.unknown, true);
          assert.equal(status.speechReceipts[0].status, 'unknown');
          assert.equal(status.speechReceipts[0].outcome, 'pending');
          assert.equal(status.speechReceipts[0].capturedSubunits, null);
          await assert.rejects(
            batch.quote(owner.user.id, id, f.live.state, {
              operationId: randomUUID(),
              autonomousSpeechPolicy: 'bounded-npc-speech-v1',
            }),
            (error) => error.getResponse?.().code === 'LIVE_OUTCOME_UNRESOLVED',
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='speech'",
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
    } finally {
      await game?.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
