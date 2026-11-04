/** Private semantic turns through real PostgreSQL and an injected, network-free provider. */
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
const { extendContextHistory } = require('../../apps/api/dist/game/context-history.js');
const {
  buildNarrativeContext,
  buildStoryTurnContext,
  endPlayerTurn,
  npcReplyObservation,
  npcSpeechListenerIds,
  turnFence,
} = require('../../packages/game-core/dist');
const database = new Db();

await test(
  'private mixed posts retain one director, durable impact and restricted speech through world batches',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const reader = await client().registerLegacyFixture();
      const outsider = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (const effect of ['harm', 'blocked', 'death']) {
        const { campaignId } = await owner.request('/game/campaigns', {
          turnBased: true,
          playableVersionId: source.playableVersionId,
        });
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: reader.handle,
        });
        await reader.request(`/game/campaigns/${campaignId}/accept`, {});
        ids.push({ id: campaignId, effect });
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
      const actorId = `player-${owner.user.id}`;
      const readerId = `player-${reader.user.id}`;
      const audienceIds = [actorId, 'keeper'].sort();
      const harmVoice = (context) => {
        const variant = context.sceneSpeakerImpactVariants.find(
          (entry) =>
            entry.afterImpact.segmentIndex === 0 &&
            entry.afterImpact.targetId === 'keeper' &&
            entry.afterImpact.effect === 'harm',
        );
        assert.ok(variant, 'The prepared body includes the exact post-harm safe voice');
        const base = [...context.sceneSpeakers, ...context.sceneSpeakerImpactBases].find(
          (entry) => entry.speechHash === variant.baseSpeechHash,
        );
        assert.ok(base, 'The conditional voice is bound to an authorized pre-impact base');
        assert.equal(base.npcId, 'keeper');
        assert.equal(variant.changes.segmentIndex ?? base.segmentIndex, 1);
        assert.equal(typeof variant.changes.speechHash, 'string');
        assert.notEqual(variant.changes.speechHash, base.speechHash);
        return { ...base, ...variant.changes };
      };
      let calls = 0;
      const provider = {
        id: 'private-story-synthetic',
        version: 'v1',
        // Exercise ordinary release admission/accounting, but never call a real API.
        external: true,
        prepareTextRequest(purpose, context) {
          const body = JSON.stringify(canonical({ purpose, context }));
          return {
            body,
            snapshot: estimateTextRequest(body, config.text, 'private-story-synthetic-v1'),
          };
        },
        async generate(request) {
          calls++;
          assert.equal(request.purpose, 'story_turn');
          const context = request.context;
          assert.equal(context.mode, 'director');
          assert.equal(context.channel, 'whisper');
          const areaWhisper = context.targetNpcId === null;
          assert.equal(context.targetNpcId, areaWhisper ? null : 'keeper');
          assert.equal(context.npcRepliesHandled, areaWhisper);
          assert.deepEqual(context.outputAudienceIds, areaWhisper ? [actorId] : audienceIds);
          if (areaWhisper) assert.deepEqual(context.sceneSpeakers, []);
          assert.deepEqual(
            context.segments.map((segment) => segment.kind),
            ['attempt', 'speech'],
          );
          const effect = areaWhisper
            ? 'death'
            : context.segments[0].text.includes('PRIVATE_STORY_HARM')
              ? 'harm'
              : 'blocked';
          const steps = [
            {
              segmentIndex: 0,
              action: null,
              reply: null,
              narrativeImpact: { targetId: 'keeper', effect },
            },
            { segmentIndex: 1, action: null, reply: null },
          ];
          if (effect !== 'death') {
            const voice =
              effect === 'harm'
                ? harmVoice(context)
                : context.sceneSpeakers.find(
                    (entry) => entry.npcId === 'keeper' && entry.segmentIndex === 1,
                  );
            assert.ok(voice, 'A conscious target supplies its own restricted voice context');
            assert.equal(voice.npcId, 'keeper');
            assert.equal(voice.segmentIndex, 1);
            assert.deepEqual([...voice.audienceIds].sort(), audienceIds);
            steps[1] = {
              ...steps[1],
              reply: { text: 'PRIVATE_STORY_REPLY: I am still here.' },
              replyNpcId: 'keeper',
              replyContextHash: voice.speechHash,
            };
          }
          return {
            proposal: {
              turnId: context.turnId,
              contextHash: context.contextHash,
              status: 'ready',
              code: null,
              steps,
              narrative: {
                narration: `PRIVATE_STORY_NARRATION_${effect}: ${effect === 'death' ? 'The keeper dies before the following words.' : effect === 'harm' ? 'The keeper is injured.' : 'The keeper avoids the contact.'}`,
                newScene: null,
                newNpc: null,
                evidenceIds: [],
              },
            },
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
      const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(provider, authority), {
        externalApproved: true,
        creditPrice: 0,
        providerUpperMicros: config.text.upperMicros,
        providerCapMicros: config.aggregateCapMicros,
        version: 'private-story-synthetic-v1',
      });
      const auth = new Auth(database);
      const art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      game.dispatchAi = () => {}; // Explicit dispatch makes reload/finalize boundaries deterministic.
      const req = { headers: { cookie: owner.cookie } };
      const third = { headers: { cookie: reader.cookie } };
      const foreign = { headers: { cookie: outsider.cookie } };
      const historyReader = {
        contextWindow: () => ({ effectiveContextTokens: 4096 }),
        packContext: (context) => context,
      };
      const requests = async (id) =>
        (await db.query('SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1', [id]))
          .rows;
      const savedTurn = async (turnId) =>
        (await db.query('SELECT * FROM game_story_turns WHERE id=$1', [turnId])).rows[0];
      const savedFeed = async (turnId) =>
        (
          await db.query('SELECT * FROM game_story_feed WHERE turn_id=$1 ORDER BY ordinal', [
            turnId,
          ])
        ).rows;
      async function reload(id) {
        game.live.delete(id);
        await game.snapshot(req, id, false);
        return game.live.get(id);
      }

      for (const { id, effect } of ids.filter((entry) => entry.effect !== 'death')) {
        await t.test(
          `${effect}: private mixed turn survives preparation, finalize and replay`,
          async () => {
            await game.snapshot(req, id);
            let live = game.live.get(id);
            Object.assign(live.state.entities[actorId], { x: 5, y: 4 });
            Object.assign(live.state.entities.keeper, { x: 6, y: 4 });
            // A nearby campaign member can see the consequence, but is not in the whisper scope.
            Object.assign(live.state.entities[readerId], { x: 5, y: 3 });
            for (const brain of Object.values(live.state.npcBrains)) {
              brain.plan = [];
              brain.cursor = 0;
              brain.nextDecisionTick = 999999;
            }
            if (effect === 'harm')
              live.state.npcBrains.keeper.living.personality.characterization = {
                version: 1,
                motives: [{ kind: 'care', priority: 3 }],
                reactions: [],
                publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
                dialogueExamples: [],
              };
            await game.persist(id, live, live.state, 'test.private-story.fixture');
            assert.equal(live.state.turnController.activeActorId, actorId);
            const vitality = live.state.entities.keeper.vitality;
            const canonRevision = live.state.narrativeCanon?.revision ?? 0;
            const beforeCalls = calls;
            const words = `PRIVATE_STORY_WORDS_${effect}: Are you there?`;
            const body = {
              operationId: randomUUID(),
              text: `*I strike toward the keeper with PRIVATE_STORY_${effect.toUpperCase()}* ${words}`,
              channel: 'whisper',
              targetNpcId: 'keeper',
              replyLocale: 'en',
              expectedCanonRevision: canonRevision,
              turnFence: turnFence(live.state),
            };
            const quoted = await game.storyQuote(req, id, body);
            assert.equal(quoted.status, 'quoted');
            assert.equal(quoted.mode, 'director');
            assert.equal(quoted.quote.provider, 'local-turn-resolver');
            assert.deepEqual(quoted.actionPreview, []);
            const submission = {
              ...body,
              turnId: quoted.turnId,
              quoteId: quoted.quote.id,
              consent: true,
              confirmedActionHash: quoted.confirmationHash,
            };
            const posted = await game.storySubmit(req, id, submission);
            assert.equal(posted.status, 'committed');
            assert.equal((await game.storySubmit(req, id, submission)).id, posted.id);
            assert.equal(calls, beforeCalls);
            assert.equal(live.state.entities.keeper.vitality, vitality);
            assert.equal(live.state.narrativeCanon?.revision ?? 0, canonRevision);
            assert.deepEqual(
              (await requests(id)).map((row) => row.purpose),
              ['story_turn'],
            );
            assert.deepEqual(
              (await savedFeed(posted.id)).map((row) => row.entry.kind),
              ['attempt', 'speech'],
            );
            assert.equal(
              (live.state.npcUtterances ?? []).filter((u) => u.text === words).length,
              0,
            );
            assert.equal(
              JSON.stringify(await game.storyFeed(third, id)).includes('PRIVATE_STORY_'),
              false,
            );
            await assert.rejects(() => game.storyFeed(foreign, id));

            // The deferred director is reconstructed from the persisted local post, not closure state.
            live = await reload(id);
            assert.equal((await savedTurn(posted.id)).context.npcRepliesHandled, false);
            const playerCount = live.state.turnController.actorOrder.length;
            for (
              let remaining = playerCount;
              remaining > 0 && live.state.turnController.phase === 'player';
              remaining--
            ) {
              const next = endPlayerTurn(
                live.state,
                live.state.turnController.activeActorId,
                turnFence(live.state),
              );
              assert.equal(next.error, undefined);
              await game.persist(id, live, next.state, 'test.private-story.end-turn');
            }
            assert.equal(live.state.turnController.phase, 'world');
            await game.story.prepareWorldRequests(id, live);
            const prepared = (await requests(id))[0];
            assert.equal(prepared.id, posted.id);
            assert.equal(prepared.context.worldPrepared, true);
            assert.equal(prepared.context.generationPolicy, 'world-batch-v1');
            assert.equal(prepared.context.worldInput.channel, 'whisper');
            assert.equal(prepared.context.worldInput.targetNpcId, 'keeper');
            assert.deepEqual(prepared.context.outputAudienceIds, audienceIds);
            if (effect === 'harm')
              assert.deepEqual([...harmVoice(prepared.context).audienceIds].sort(), audienceIds);
            assert.equal(
              (await savedTurn(posted.id)).context.contextHash,
              prepared.context.contextHash,
            );
            live = await reload(id);
            await game.story.prepareWorldRequests(id, live);
            assert.deepEqual((await requests(id))[0].context, prepared.context);
            await game.processDecisionRequests(id, live);
            assert.equal((await requests(id))[0].job_id, null, 'No dispatch before world consent');

            // Price only this targeted director request. Round planning is outside this regression.
            const batch = await game.worldGeneration.quote(owner.user.id, id, live.state, {
              operationId: randomUUID(),
            });
            const consent = {
              operationId: batch.operationId,
              quoteId: batch.quote.id,
              consent: true,
            };
            await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
            await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
            const frozen = (
              await db.query('SELECT entries FROM game_world_generation_batches WHERE id=$1', [
                batch.quote.id,
              ])
            ).rows[0];
            assert.equal(frozen.entries.length, 1);
            assert.equal(frozen.entries[0].requestId, posted.id);
            await game.processDecisionRequests(id, live);
            const scheduled = (await requests(id))[0];
            assert.equal(scheduled.status, 'scheduled', scheduled.result_code);
            assert.ok(scheduled.job_id);
            await ai.run(scheduled.job_id, async () => true);
            const received = (
              await db.query('SELECT status,context,proposal FROM npc_ai_jobs WHERE id=$1', [
                scheduled.job_id,
              ])
            ).rows[0];
            assert.equal(received.status, 'result_received');
            assert.deepEqual(received.context, prepared.context);
            if (effect === 'harm')
              assert.equal(
                received.proposal.steps[1].replyContextHash,
                harmVoice(prepared.context).speechHash,
                'The native result keeps the conditional hash from the consented body',
              );
            live = await reload(id);
            await game.processAi(id, live);

            async function assertCommittedOnce() {
              const completed = await savedTurn(posted.id);
              assert.equal(completed.status, 'committed', completed.result_code);
              assert.equal(completed.result_code, null);
              const persisted = (
                await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])
              ).rows[0].state;
              const matching = persisted.narrativeCanon.turns.filter(
                (turn) => turn.id === posted.id,
              );
              assert.equal(matching.length, 1);
              assert.equal(persisted.narrativeCanon.revision, canonRevision + 1);
              assert.deepEqual(matching[0].audienceIds, audienceIds);
              assert.equal(matching[0].channel, 'whisper');
              assert.equal(matching[0].impact.effect, effect);
              assert.equal(matching[0].impact.damage, effect === 'harm' ? 1 : 0);
              assert.equal(
                persisted.entities.keeper.vitality,
                vitality - (effect === 'harm' ? 1 : 0),
              );
              assert.equal((await requests(id))[0].status, 'committed');
              const jobs = (await db.query('SELECT * FROM npc_ai_jobs WHERE campaign_id=$1', [id]))
                .rows;
              assert.equal(jobs.length, 1);
              assert.equal(jobs[0].purpose, 'story_turn');
              assert.equal(jobs[0].status, 'committed');
              const entries = await savedFeed(posted.id);
              assert.deepEqual(
                entries.map((row) => row.entry.kind),
                ['attempt', 'speech', 'outcome', 'npc_reply', 'narration'],
              );
              assert.ok(entries.every((row) => row.channel === 'whisper'));
              assert.ok(
                entries.every(
                  (row) =>
                    JSON.stringify([...row.audience_ids].sort()) === JSON.stringify(audienceIds),
                ),
              );
              const source = persisted.npcUtterances.filter(
                (u) => u.speakerId === actorId && u.text === words,
              );
              assert.equal(source.length, 1);
              assert.deepEqual([...source[0].audienceIds].sort(), audienceIds);
              assert.equal(
                entries.find((row) => row.entry.kind === 'speech').entry.sourceId,
                source[0].id,
              );
              assert.deepEqual(
                entries.find((row) => row.entry.kind === 'speech').entry.speakerKnownToIds,
                source[0].speakerKnownToIds ?? [],
              );
              const replies = persisted.npcUtterances.filter(
                (u) => u.text === 'PRIVATE_STORY_REPLY: I am still here.',
              );
              assert.equal(replies.length, 1);
              assert.deepEqual([...replies[0].audienceIds].sort(), audienceIds);
              assert.equal(
                entries.find((row) => row.entry.kind === 'npc_reply').entry.sourceId,
                replies[0].id,
              );
              const own = await game.storyFeed(req, id);
              assert.equal(
                own.entries.filter((entry) => entry.turnId === posted.id).length,
                entries.length,
              );
              assert.ok(JSON.stringify(own).includes(`PRIVATE_STORY_NARRATION_${effect}`));
              assert.equal(own.entries.filter((entry) => entry.text === words).length, 1);
              assert.equal(
                own.entries.filter(
                  (entry) => entry.text === 'PRIVATE_STORY_REPLY: I am still here.',
                ).length,
                1,
              );
              const thirdFeed = await game.storyFeed(third, id);
              const thirdSnapshot = await game.snapshot(third, id, false);
              assert.equal(
                thirdFeed.entries.some((entry) => entry.turnId === posted.id),
                false,
              );
              assert.equal(
                JSON.stringify({ thirdFeed, thirdSnapshot }).includes('PRIVATE_STORY_'),
                false,
              );
              assert.equal(
                thirdSnapshot.projection.entities.find((entity) => entity.id === 'keeper')
                  ?.vitality,
                vitality - (effect === 'harm' ? 1 : 0),
                'Restricted words do not conceal the visible physical consequence',
              );
              for (const observerId of [actorId, readerId]) {
                const shared = buildNarrativeContext(live.state, observerId, 'What happens next?');
                assert.equal(shared.evidenceIds.includes(posted.id), false);
                assert.equal(JSON.stringify(shared).includes('PRIVATE_STORY_'), false);
                const publicStory = buildStoryTurnContext(
                  live.state,
                  observerId,
                  {
                    operationId: randomUUID(),
                    text: 'What happens next?',
                    channel: 'say',
                    expectedCanonRevision: persisted.narrativeCanon.revision,
                    turnFence: turnFence(live.state),
                  },
                  randomUUID(),
                );
                assert.equal(JSON.stringify(publicStory).includes('PRIVATE_STORY_'), false);
                const history = await extendContextHistory(
                  database,
                  historyReader,
                  id,
                  live.state,
                  observerId,
                  publicStory,
                  'story_turn',
                );
                assert.equal(JSON.stringify(history).includes('PRIVATE_STORY_'), false);
              }
              const privateContext = buildNarrativeContext(
                live.state,
                actorId,
                'Continue privately',
                'en',
                audienceIds,
              );
              assert.ok(privateContext.evidenceIds.includes(posted.id));
              assert.ok(
                JSON.stringify(privateContext).includes(`PRIVATE_STORY_NARRATION_${effect}`),
              );
              const privateHistory = await extendContextHistory(
                database,
                historyReader,
                id,
                live.state,
                actorId,
                {
                  mode: 'director',
                  channel: 'whisper',
                  outputAudienceIds: audienceIds,
                  director: privateContext,
                },
                'story_turn',
              );
              assert.ok(
                privateHistory.history.some((entry) =>
                  entry.text?.includes(`PRIVATE_STORY_NARRATION_${effect}`),
                ),
              );
              assert.equal(calls, beforeCalls + 1);
            }
            await assertCommittedOnce();
            live = await reload(id);
            await game.story.prepareWorldRequests(id, live);
            await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
            await game.processDecisionRequests(id, live);
            await game.processAi(id, live);
            assert.equal((await game.storySubmit(req, id, submission)).status, 'committed');
            await assertCommittedOnce();
          },
        );
      }
      await t.test(
        'area whisper death before words keeps the virtual reply unpaid and drains its pending reference',
        async () => {
          const { id } = ids.find((entry) => entry.effect === 'death');
          await game.snapshot(req, id);
          let live = game.live.get(id);
          Object.assign(live.state.entities[actorId], { x: 5, y: 4 });
          Object.assign(live.state.entities.keeper, { x: 6, y: 4 });
          // Outside whisper hearing, still close enough to see the physical consequence.
          Object.assign(live.state.entities[readerId], { x: 5, y: 2 });
          for (const brain of Object.values(live.state.npcBrains)) {
            brain.plan = [];
            brain.cursor = 0;
            brain.nextDecisionTick = 999999;
          }
          await game.persist(id, live, live.state, 'test.pending-private-story.fixture');
          const words = 'PRIVATE_STORY_AFTER_DEATH: Can you hear me now?';
          const prospective = npcSpeechListenerIds(live.state, actorId, {
            channel: 'whisper',
            text: words,
          });
          assert.ok(prospective.includes('keeper'));
          assert.ok(!prospective.includes(readerId));
          const beforeCalls = calls;
          const vitality = live.state.entities.keeper.vitality;
          const lifeRevision = live.state.entities.keeper.lifeRevision ?? 0;
          const canonRevision = live.state.narrativeCanon?.revision ?? 0;
          const body = {
            operationId: randomUUID(),
            text: `*I strike the keeper with PRIVATE_STORY_FATAL_INTENT* ${words}`,
            channel: 'whisper',
            replyLocale: 'en',
            expectedCanonRevision: canonRevision,
            turnFence: turnFence(live.state),
          };
          const quoted = await game.storyQuote(req, id, body);
          assert.equal(quoted.status, 'quoted');
          assert.equal(quoted.mode, 'director');
          assert.deepEqual(quoted.actionPreview, []);
          const submission = {
            ...body,
            turnId: quoted.turnId,
            quoteId: quoted.quote.id,
            consent: true,
            confirmedActionHash: quoted.confirmationHash,
          };
          const posted = await game.storySubmit(req, id, submission);
          assert.equal(posted.status, 'committed');
          assert.equal((await game.storySubmit(req, id, submission)).id, posted.id);
          const localRequests = await requests(id);
          assert.equal(localRequests.length, 2);
          const pending = localRequests.find((row) => row.purpose === 'speech');
          const director = localRequests.find((row) => row.purpose === 'story_turn');
          assert.ok(pending);
          assert.equal(director.id, posted.id);
          assert.equal(pending.npc_id, 'keeper');
          assert.equal(pending.context.awaitStoryDirector, posted.id);
          assert.equal(pending.context.lifeRevision, lifeRevision);
          assert.deepEqual(pending.context.pendingStorySpeech.sources, [
            {
              actorId,
              text: words,
              channel: 'whisper',
              identity: { turnId: posted.id, segmentIndex: 1 },
            },
          ]);
          assert.equal(pending.context.pendingStorySpeech.reference.id, pending.id);
          assert.equal(pending.context.pendingStorySpeech.reference.pendingStoryTurnId, undefined);
          const assertNotAdmitted = () => {
            assert.equal(live.state.entities.keeper.vitality, vitality);
            assert.equal(
              (live.state.npcUtterances ?? []).some((entry) => entry.text === words),
              false,
            );
            assert.equal(
              live.state.npcBrains.keeper.living.observations.some((entry) =>
                entry.text?.includes(words),
              ),
              false,
            );
            assert.equal(
              npcReplyObservation(
                live.state,
                actorId,
                'keeper',
                pending.context.replyToObservationId,
              ),
              undefined,
            );
            assert.equal(
              live.state.turnController.deferredSpeech.find((ref) => ref.id === pending.id)
                ?.pendingStoryTurnId,
              posted.id,
            );
          };
          assertNotAdmitted();
          const localFeed = await savedFeed(posted.id);
          assert.deepEqual(
            localFeed.map((row) => row.entry.kind),
            ['attempt', 'speech'],
          );
          assert.ok(
            localFeed.every(
              (row) => row.audience_ids.length === 1 && row.audience_ids[0] === actorId,
            ),
          );
          assert.equal(
            localFeed.find((row) => row.entry.kind === 'speech').entry.sourceId,
            undefined,
          );
          live = await reload(id);
          assertNotAdmitted();
          const playerCount = live.state.turnController.actorOrder.length;
          for (
            let remaining = playerCount;
            remaining > 0 && live.state.turnController.phase === 'player';
            remaining--
          ) {
            const next = endPlayerTurn(
              live.state,
              live.state.turnController.activeActorId,
              turnFence(live.state),
            );
            assert.equal(next.error, undefined);
            await game.persist(id, live, next.state, 'test.pending-private-story.end-turn');
          }
          assert.equal(live.state.turnController.phase, 'world');
          await game.story.prepareWorldRequests(id, live);
          const prepared = (await requests(id)).find((row) => row.id === pending.id);
          assert.equal(prepared.context.worldPrepared, true);
          assert.equal(prepared.context.awaitStoryDirector, posted.id);
          assert.equal(prepared.context.lifeRevision, lifeRevision);
          assert.deepEqual(prepared.context.pendingStorySpeech, pending.context.pendingStorySpeech);
          const rebuilt = game.deferredSpeechContext(live.state, {
            id: prepared.id,
            npcId: prepared.npc_id,
            purpose: prepared.purpose,
            causeKey: prepared.cause_key,
            context: prepared.context,
          });
          assert.equal(rebuilt.awaitStoryDirector, posted.id);
          assert.equal(rebuilt.lifeRevision, lifeRevision);
          assert.deepEqual(rebuilt.pendingStorySpeech, prepared.context.pendingStorySpeech);
          assert.ok(JSON.stringify(rebuilt.currentUtterance).includes(words));
          assertNotAdmitted();
          live = await reload(id);
          await game.story.prepareWorldRequests(id, live);
          assert.deepEqual(
            (await requests(id)).find((row) => row.id === pending.id).context,
            prepared.context,
          );
          assertNotAdmitted();

          const batch = await game.worldGeneration.quote(owner.user.id, id, live.state, {
            operationId: randomUUID(),
          });
          const consent = {
            operationId: batch.operationId,
            quoteId: batch.quote.id,
            consent: true,
          };
          const entries = (
            await db.query('SELECT entries FROM game_world_generation_batches WHERE id=$1', [
              batch.quote.id,
            ])
          ).rows[0].entries;
          assert.deepEqual(
            entries.map((entry) => entry.purpose),
            ['story_turn', 'speech'],
          );
          assert.equal(entries[1].requestId, pending.id);
          await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
          await game.processDecisionRequests(id, live);
          const admitted = await requests(id);
          const scheduled = admitted.find((row) => row.id === director.id);
          assert.equal(scheduled.status, 'scheduled', scheduled.result_code);
          assert.ok(scheduled.job_id);
          assert.equal(admitted.find((row) => row.id === pending.id).status, 'queued');
          assert.equal(admitted.find((row) => row.id === pending.id).job_id, null);
          assert.equal(calls, beforeCalls);
          assertNotAdmitted();
          await ai.run(scheduled.job_id, async () => true);
          assert.equal(
            (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [scheduled.job_id]))
              .rows[0].status,
            'result_received',
          );
          live = await reload(id);
          assertNotAdmitted();
          await game.processAi(id, live);
          const completed = await savedTurn(posted.id);
          assert.equal(completed.status, 'committed', completed.result_code);
          assert.equal(completed.result_code, null);
          assert.equal(live.state.entities.keeper.lifeState, 'dead');
          assert.equal(live.state.entities.keeper.lifeRevision, lifeRevision + 1);
          assert.equal(live.state.entities.keeper.vitality, 0);
          assert.equal(
            live.state.turnController.deferredSpeech.some((ref) => ref.id === pending.id),
            false,
          );
          assert.equal(
            npcReplyObservation(
              live.state,
              actorId,
              'keeper',
              pending.context.replyToObservationId,
            ),
            undefined,
          );
          assert.equal(
            live.state.npcBrains.keeper.living.observations.some((entry) =>
              entry.text?.includes(words),
            ),
            false,
          );
          // The pending recipient is reconciled only after the director's terminal result.
          live = await reload(id);
          await game.processDecisionRequests(id, live);
          const cancelled = (await requests(id)).find((row) => row.id === pending.id);
          assert.equal(cancelled.status, 'failed');
          assert.equal(cancelled.result_code, 'STORY_SPEECH_NOT_ADMITTED');
          assert.equal(cancelled.job_id, null);
          assert.equal(cancelled.context.awaitStoryDirector, posted.id);
          assert.equal(cancelled.context.lifeRevision, lifeRevision);
          const financial = (
            await db.query(
              `SELECT
            (SELECT count(*)::int FROM live_test_text_permits WHERE request_id=$1) AS permits,
            (SELECT count(*)::int FROM spark_holds WHERE source_id=$1::text) AS holds,
            (SELECT count(*)::int FROM generation_budget_reservations WHERE operation_key='manual-text:'||$1::text) AS reservations`,
              [pending.id],
            )
          ).rows[0];
          assert.deepEqual(financial, { permits: 0, holds: 0, reservations: 0 });
          await game.advanceTurnWorld(id, live);
          assert.equal(
            live.state.turnController.phase,
            'player',
            'The cancelled pending voice cannot strand the world phase',
          );
          assert.deepEqual(live.state.turnController.deferredSpeech, []);

          async function assertAreaCommittedOnce() {
            const persisted = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
              .rows[0].state;
            const canon = persisted.narrativeCanon.turns.filter((turn) => turn.id === posted.id);
            assert.equal(canon.length, 1);
            assert.equal(persisted.narrativeCanon.revision, canonRevision + 1);
            assert.deepEqual(canon[0].audienceIds, [actorId]);
            assert.equal(canon[0].impact.effect, 'death');
            assert.equal(canon[0].impact.damage, vitality);
            assert.equal(persisted.entities.keeper.lifeState, 'dead');
            assert.equal(persisted.entities.keeper.lifeRevision, lifeRevision + 1);
            assert.deepEqual(persisted.turnController.deferredSpeech, []);
            assert.equal(
              persisted.npcBrains.keeper.living.observations.some((entry) =>
                entry.text?.includes(words),
              ),
              false,
            );
            const speech = persisted.npcUtterances.filter(
              (entry) => entry.speakerId === actorId && entry.text === words,
            );
            assert.equal(speech.length, 1);
            assert.deepEqual(speech[0].audienceIds, [actorId]);
            assert.equal(
              persisted.npcUtterances.some((entry) => entry.speakerId === 'keeper'),
              false,
            );
            const feed = await savedFeed(posted.id);
            assert.deepEqual(
              feed.map((row) => row.entry.kind),
              ['attempt', 'speech', 'outcome', 'narration'],
            );
            assert.ok(
              feed.every(
                (row) =>
                  row.channel === 'whisper' &&
                  row.audience_ids.length === 1 &&
                  row.audience_ids[0] === actorId,
              ),
            );
            assert.equal(
              feed.find((row) => row.entry.kind === 'speech').entry.sourceId,
              speech[0].id,
            );
            assert.deepEqual(
              feed.find((row) => row.entry.kind === 'speech').entry.speakerKnownToIds,
              speech[0].speakerKnownToIds ?? [],
            );
            const own = await game.storyFeed(req, id);
            assert.equal(own.entries.filter((entry) => entry.text === words).length, 1);
            assert.equal(own.entries.filter((entry) => entry.turnId === posted.id).length, 4);
            const thirdFeed = await game.storyFeed(third, id);
            const thirdSnapshot = await game.snapshot(third, id, false);
            assert.equal(
              JSON.stringify({ thirdFeed, thirdSnapshot }).includes('PRIVATE_STORY_'),
              false,
            );
            assert.equal(
              thirdSnapshot.projection.entities.find((entity) => entity.id === 'keeper')?.lifeState,
              'dead',
            );
            assert.equal(
              buildNarrativeContext(live.state, readerId, 'Continue').evidenceIds.includes(
                posted.id,
              ),
              false,
            );
            assert.ok(
              buildNarrativeContext(live.state, actorId, 'Continue privately', 'en', [
                actorId,
              ]).evidenceIds.includes(posted.id),
            );
            const jobs = (
              await db.query('SELECT purpose,status FROM npc_ai_jobs WHERE campaign_id=$1', [id])
            ).rows;
            assert.deepEqual(jobs, [{ purpose: 'story_turn', status: 'committed' }]);
            assert.ok(
              (await requests(id)).every((row) => !['queued', 'scheduled'].includes(row.status)),
            );
            assert.equal(calls, beforeCalls + 1);
          }
          await assertAreaCommittedOnce();
          live = await reload(id);
          await game.worldGeneration.consent(owner.user.id, id, live.state, consent);
          assert.equal((await game.storySubmit(req, id, submission)).status, 'committed');
          await game.processDecisionRequests(id, live);
          await game.processAi(id, live);
          await assertAreaCommittedOnce();
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
