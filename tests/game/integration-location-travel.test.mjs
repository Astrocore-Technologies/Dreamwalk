/** One finite text+image consent, real PostgreSQL, local synthetic provider transports only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
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
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { canonical } = require('../../apps/api/dist/ai/context.js');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { endPlayerTurn, turnFence } = require('../../packages/game-core/dist');
const { ApiException } = require('../../apps/api/dist/errors.js');
const { eraseImageGeneration } = require('../../apps/api/dist/image-generation/data-requests.js');
const database = new Db();
const code = (expected) => (error) => error.getResponse?.().code === expected;
await test(
  'illustrated RP travel uses one compound consent and durable exact native jobs',
  { timeout: 180000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const guest = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const { campaignId } = await (i === 7 ? guest : owner).request('/game/campaigns', {
          turnBased: i !== 6,
          playableVersionId: source.playableVersionId,
        });
        ids.push(campaignId);
        if (i === 1) {
          await owner.request(`/game/campaigns/${campaignId}/invitations`, {
            username: guest.handle,
          });
          await guest.request(`/game/campaigns/${campaignId}/accept`, {});
        }
      }
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,10000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=10000000',
        [owner.user.id],
      );
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,10000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=10000000',
        [guest.user.id],
      );
      const profile = requestEstimateOwnerProfile();
      profile.image.size = '1024x1024';
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      let textCalls = 0,
        imageCalls = 0,
        imageOutcome = 'success',
        textOutcome = 'success';
      const ai = new NpcAiEngine(
        database,
        new ReleaseGenerationProvider(
          {
            id: 'travel-synthetic',
            version: 'v1',
            external: true,
            prepareTextRequest(purpose, context) {
              const body = JSON.stringify(canonical({ purpose, context }));
              return {
                body,
                snapshot: estimateTextRequest(body, config.text, 'travel-synthetic-v1'),
              };
            },
            async generate(request) {
              textCalls++;
              let proposal = request.context.mockProposal;
              if (
                textOutcome === 'semantic' &&
                request.purpose === 'story_turn' &&
                !request.context.travelSceneSpec
              ) {
                proposal = structuredClone(proposal);
                proposal.travelIntent = {
                  segmentIndex: 1,
                  destinationName: 'Coffee and Silence',
                  description:
                    'A quiet city cafe with blue windows, fitting the observatory district.',
                  template: 'room',
                };
                proposal.steps = proposal.steps.map((step) => ({
                  ...step,
                  action:
                    step.segmentIndex === 0 ? { kind: 'pick_up', targetId: 'new_item' } : null,
                }));
                proposal.narrative = {
                  narration: 'The notebook is pocketed. The traveler sets off toward the cafe.',
                  newScene: null,
                  newNpc: null,
                  newItem: { name: 'notebook', description: 'An ordinary pocket notebook.' },
                  evidenceIds: [],
                };
              }
              return {
                proposal:
                  textOutcome === 'invalid' && request.purpose === 'story_turn' ? null : proposal,
                ...(textOutcome === 'invalid' && request.purpose === 'story_turn'
                  ? { failureCode: 'INVALID_PROPOSAL', failureStage: 'response_schema' }
                  : {}),
                requestId: `synthetic-${request.jobId}`,
                usage: {
                  inputTokens: 10,
                  outputTokens: 10,
                  costMicros: 30,
                  costEvidence: 'configured_rates',
                },
              };
            },
          },
          authority,
        ),
        {
          externalApproved: true,
          creditPrice: 0,
          providerUpperMicros: config.text.upperMicros,
          providerCapMicros: config.aggregateCapMicros,
          version: 'travel-synthetic-v1',
        },
      );
      const png = await sharp({
        create: { width: 1024, height: 1024, channels: 3, background: '#5b725c' },
      })
        .png()
        .toBuffer();
      const runtime = createOwnerImageRuntime(config, {
        resolveApiKey: () => 'synthetic-unused-key',
        fetchImpl: async (_url, init) => {
          imageCalls++;
          const body = JSON.parse(init.body);
          assert.equal(body.n, 1);
          assert.equal(body.size, '1024x1024');
          return new Response(
            JSON.stringify({
              data: [{ b64_json: png.toString('base64') }],
              ...(imageOutcome === 'unknown'
                ? {}
                : {
                    usage: {
                      input_tokens_details: { text_tokens: 100, image_tokens: 0 },
                      output_tokens: 100,
                    },
                  }),
            }),
            { headers: { 'x-request-id': `synthetic-image-${imageCalls}` } },
          );
        },
      });
      const art = new AssetReuseService(database),
        auth = new Auth(database);
      const images = new ImageGenerationEngine(
        database,
        art,
        runtime.provider,
        runtime.policy,
        runtime.capabilities,
      );
      images.setLiveAuthorizer((c, user, id, input) =>
        authority.authorizeImage(c, user, id, input),
      );
      images.setReleaseResultAuthorizer((...args) => authority.authorizeReleaseResult(...args));
      function instantiate() {
        game = new GameService(
          database,
          auth,
          new PlayableService(database, auth, art),
          ai,
          art,
          images,
        );
        clearInterval(game.timer);
        game.dispatchAi = () => {};
      }
      instantiate();
      const req = { headers: { cookie: owner.cookie } },
        other = { headers: { cookie: guest.cookie } },
        actor = `player-${owner.user.id}`,
        otherActor = `player-${guest.user.id}`;
      async function setup(id, user = req) {
        await game.snapshot(user, id);
        const live = game.live.get(id);
        for (const brain of Object.values(live.state.npcBrains)) {
          brain.plan = [];
          brain.cursor = 0;
          brain.nextDecisionTick = 999999;
        }
        await game.persist(id, live, live.state, 'test.travel.fixture');
        return live;
      }
      async function post(id, live, text, user = req) {
        const input = {
          operationId: randomUUID(),
          text,
          channel: 'say',
          replyLocale: 'en',
          expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
          ...(turnFence(live.state) ? { turnFence: turnFence(live.state) } : {}),
        };
        const q = await game.storyQuote(user, id, input);
        assert.equal(q.status, 'quoted');
        assert.equal(q.quote.credits, 0);
        assert.equal(q.quote.requiresConsent, false);
        const submission = {
          ...input,
          turnId: q.turnId,
          quoteId: q.quote.id,
          consent: true,
          confirmedActionHash: q.confirmationHash,
        };
        const result = await game.storySubmit(user, id, submission);
        assert.equal(result.status, 'committed');
        const revision = live.state.revision;
        const replay = await game.storySubmit(user, id, submission);
        assert.equal(replay.id, result.id);
        assert.equal(replay.status, 'committed');
        assert.equal(live.state.revision, revision);
        return result;
      }
      async function end(id, live, actorId = actor) {
        const result = endPlayerTurn(live.state, actorId, turnFence(live.state));
        assert.equal(result.error, undefined);
        await game.persist(id, live, result.state, 'test.travel.end');
      }
      async function quote(id, user = req) {
        return game.worldGenerationQuote(user, id, { operationId: randomUUID() });
      }
      async function accept(id, q, user = req) {
        return game.worldGenerationConsent(user, id, {
          operationId: q.operationId,
          quoteId: q.quote.id,
          consent: true,
          estimateRiskConsent: true,
          ...(q.quote.automaticKnownCostPolicy === 'known-cost-v1' &&
          q.quote.automaticKnownCostPolicyHash
            ? { automaticKnownCostPolicyHash: q.quote.automaticKnownCostPolicyHash }
            : {}),
        });
      }
      async function drain(id, live, allowUnpaidContinuation = false) {
        for (let i = 0; i < 60; i++) {
          await game.processDecisionRequests(id, live);
          await images.workOnce();
          const jobs = (
            await db.query(
              "SELECT id FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('queued','reserved') ORDER BY created_at,id",
              [id],
            )
          ).rows;
          for (const job of jobs) {
            await ai.run(job.id, async () => true);
            await game.processAi(id, live);
          }
          const pending = (
            await db.query(
              "SELECT 1 FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.campaign_id=$1 AND (r.purpose='story_turn' OR $2::boolean) AND (r.status='queued' OR (r.status='scheduled' AND (NOT $2::boolean OR j.status IN ('queued','reserved','running','result_received','validated','reconciling')))) AND NOT($2::boolean AND r.status='queued' AND r.job_id IS NULL AND r.context ? 'semanticTravelSourceTurnId')",
              [id, allowUnpaidContinuation],
            )
          ).rowCount;
          if (!pending) return;
        }
        const debug = (
          await db.query(
            'SELECT npc_id,purpose,status,result_code,job_id FROM game_npc_decision_requests WHERE campaign_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows;
        const media = (
          await db.query(
            'SELECT p.state,j.status,j.error_code,h.status AS hold FROM game_location_travel_preparations p LEFT JOIN image_generation_jobs j ON j.id=p.image_job_id LEFT JOIN spark_holds h ON h.id=j.spark_quote_id WHERE p.campaign_id=$1',
            [id],
          )
        ).rows;
        assert.fail(`Travel pipeline did not drain: ${JSON.stringify({ debug, media })}`);
      }
      await t.test(
        'legacy realtime existing-location travel is free, immediate and replay-safe',
        async () => {
          const id = ids[6],
            live = await setup(id);
          assert.equal(live.state.turnController, undefined);
          const destination = Object.values(live.state.maps).find(
            (map) => map.id !== live.state.entities[actor].mapId,
          );
          const calls = [textCalls, imageCalls];
          const turn = await post(id, live, `*I go to ${destination.label ?? destination.id}*`);
          assert.equal(live.state.entities[actor].mapId, destination.id);
          assert.equal(turn.status, 'committed');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_npc_decision_requests WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          assert.deepEqual([textCalls, imageCalls], calls);
          const missing = await game.storyQuote(req, id, {
            operationId: randomUUID(),
            text: '*I go to Future Cafe*',
            channel: 'say',
            replyLocale: 'en',
            expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
          });
          assert.equal(missing.status, 'clarification');
          assert.equal(missing.code, 'LOCATION_GENERATION_REQUIRES_TURNS');
          assert.deepEqual([textCalls, imageCalls], calls);
        },
      );
      await t.test(
        'quote is inert; one consent generates, pins and arrives once even after runtime restart',
        async () => {
          const id = ids[0];
          let live = await setup(id);
          const before = structuredClone(live.state);
          const turn = await post(id, live, '*I go to Blue Bird Cafe*');
          assert.equal(live.state.entities[actor].mapId, before.entities[actor].mapId);
          await end(id, live);
          const calls = [textCalls, imageCalls];
          const status = await game.worldGenerationStatus(req, id);
          assert.equal(status.generatedLocationImages, 1);
          assert.equal(status.estimateRiskConsentRequired, true);
          await db.query(
            'INSERT INTO game_ordinary_round_consents(campaign_id,round_id,owner_id,operation_id) VALUES($1,$2,$3,$4)',
            [id, live.state.turnController.roundId, owner.user.id, randomUUID()],
          );
          await game.admitOrdinaryRound(id);
          const waiting = await game.worldGenerationStatus(req, id);
          assert.equal(waiting.ordinary.code, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
          assert.equal(waiting.available, true);
          assert.equal(waiting.generatedLocationImages, 1);
          assert.deepEqual([textCalls, imageCalls], calls);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_world_generation_batches WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_location_travel_preparations WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          const q = await quote(id);
          assert.equal(q.quote.generatedLocationImages, 1);
          assert.equal(q.quote.estimateRiskConsentRequired, true);
          assert.deepEqual([textCalls, imageCalls], calls);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM image_generation_jobs WHERE input->'travelContext'->>'preparationId'=$1",
                [turn.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(q.quote.automaticKnownCostPolicy, 'known-cost-v1');
          assert.match(q.quote.automaticKnownCostPolicyHash, /^[a-f0-9]{64}$/);
          // Old clients and a mismatched acceptance cannot authorize a new marked quote.
          for (const automaticKnownCostPolicyHash of [undefined, '0'.repeat(64)]) {
            await assert.rejects(
              game.worldGenerationConsent(req, id, {
                operationId: q.operationId,
                quoteId: q.quote.id,
                consent: true,
                estimateRiskConsent: true,
                ...(automaticKnownCostPolicyHash ? { automaticKnownCostPolicyHash } : {}),
              }),
              code('IMAGE_SETTLEMENT_POLICY_CONSENT_REQUIRED'),
            );
          }
          await assert.rejects(
            game.worldGenerationConsent(req, id, {
              operationId: q.operationId,
              quoteId: q.quote.id,
              consent: true,
              automaticKnownCostPolicyHash: q.quote.automaticKnownCostPolicyHash,
            }),
            code('IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'),
          );
          assert.deepEqual([textCalls, imageCalls], calls);
          assert.equal(
            (
              await db.query('SELECT accepted_at FROM game_world_generation_batches WHERE id=$1', [
                q.quote.id,
              ])
            ).rows[0].accepted_at,
            null,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM image_generation_jobs WHERE input->'travelContext'->>'preparationId'=$1",
                [turn.id],
              )
            ).rows[0].n,
            0,
          );
          await accept(id, q);
          assert.equal(
            (
              await db.query(
                'SELECT state,batch_id FROM game_ordinary_round_consents WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].state,
            'accepted',
          );
          await accept(id, q);
          await assert.rejects(
            () => game.worldGenerationDecline(req, id, { requestIds: [turn.id] }),
            code('LOCATION_TRAVEL_ALREADY_STARTED'),
          );
          await game.onModuleDestroy();
          instantiate();
          await game.snapshot(req, id);
          live = game.live.get(id);
          await drain(id, live);
          assert.equal(live.state.entities[actor].mapId, `scene-${turn.id}`);
          assert.ok(
            live.state.artBindings.some((b) => b.slot === `map:scene-${turn.id}:background`),
          );
          const prep = (
            await db.query('SELECT * FROM game_location_travel_preparations WHERE id=$1', [turn.id])
          ).rows[0];
          assert.equal(prep.state, 'committed');
          const image = (
            await db.query('SELECT status FROM image_generation_jobs WHERE id=$1', [
              prep.image_job_id,
            ])
          ).rows[0];
          assert.equal(image.status, 'admitted');
          assert.equal(imageCalls, calls[1] + 1);
          await drain(id, live);
          assert.equal(imageCalls, calls[1] + 1);
          const receipt = (await game.storyFeed(req, id)).turns.find((t) => t.id === turn.id);
          assert.equal(receipt.travel.status, 'committed');
          assert.equal(receipt.travel.sparkStatus, 'settled');
        },
      );
      await t.test(
        'independent players receive distinct complete scenes under the same consent',
        async () => {
          const id = ids[1],
            live = await setup(id);
          const a = await post(id, live, '*I go to Amber Cafe*');
          await end(id, live);
          const b = await post(id, live, '*I go to Silver Library*', other);
          await end(id, live, otherActor);
          const q = await quote(id);
          assert.equal(q.quote.generatedLocationImages, 2);
          // Explicit consent can win before the ordinary timer has observed travel.
          await db.query(
            'INSERT INTO game_ordinary_round_consents(campaign_id,round_id,owner_id,operation_id) VALUES($1,$2,$3,$4)',
            [id, live.state.turnController.roundId, owner.user.id, randomUUID()],
          );
          await accept(id, q);
          const linked = (
            await db.query(
              'SELECT state,batch_id FROM game_ordinary_round_consents WHERE campaign_id=$1',
              [id],
            )
          ).rows[0];
          assert.equal(linked.state, 'accepted');
          assert.equal(linked.batch_id, q.quote.id);
          await game.processDecisionRequests(id, live);
          await game.admitOrdinaryRound(id);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM game_npc_decision_requests WHERE id=ANY($1::uuid[]) AND status IN ('failed','cancelled')",
                [[a.id, b.id]],
              )
            ).rows[0].n,
            0,
          );
          await drain(id, live);
          assert.equal(live.state.entities[actor].mapId, `scene-${a.id}`);
          assert.equal(live.state.entities[otherActor].mapId, `scene-${b.id}`);
          assert.ok(live.state.artBindings.some((x) => x.slot === `map:scene-${a.id}:background`));
          assert.ok(live.state.artBindings.some((x) => x.slot === `map:scene-${b.id}:background`));
        },
      );
      await t.test(
        'deterministically impossible new scene fails unpaid without stranding the world queue',
        async () => {
          const id = ids[2],
            live = await setup(id);
          live.state.narrativeConstraints = {
            ...live.state.narrativeConstraints,
            allowNewScenes: false,
          };
          await game.persist(id, live, live.state, 'test.travel.closed');
          const turn = await post(id, live, '*I go to Unavailable Cafe*');
          await end(id, live);
          const before = imageCalls;
          await quote(id);
          const row = (
            await db.query(
              'SELECT status,result_code FROM game_npc_decision_requests WHERE id=$1',
              [turn.id],
            )
          ).rows[0];
          assert.equal(row.status, 'failed');
          assert.equal(imageCalls, before);
        },
      );
      await t.test(
        'original consent survives quote TTL without new request or changed tariff',
        async () => {
          const id = ids[3],
            live = await setup(id),
            turn = await post(id, live, '*I go to Evening Cafe*');
          await end(id, live);
          const q = await quote(id);
          await accept(id, q);
          const before = (
            await db.query(
              'SELECT image_quote,input_hash FROM game_location_travel_preparations WHERE id=$1',
              [turn.id],
            )
          ).rows[0];
          const now = Date.now;
          try {
            Date.now = () => now() + 10 * 60 * 1000;
            await drain(id, live);
          } finally {
            Date.now = now;
          }
          assert.equal(live.state.entities[actor].mapId, `scene-${turn.id}`);
          const after = (
            await db.query(
              'SELECT image_quote,input_hash FROM game_location_travel_preparations WHERE id=$1',
              [turn.id],
            )
          ).rows[0];
          assert.deepEqual(after, before);
        },
      );
      await t.test(
        'rejected final art pin leaves no partial map and terminalizes the exact text job',
        async () => {
          const id = ids[4],
            live = await setup(id),
            origin = live.state.entities[actor].mapId,
            turn = await post(id, live, '*I go to Fragile Cafe*');
          await end(id, live);
          const q = await quote(id);
          await accept(id, q);
          const original = art.pinCampaignArtTx.bind(art);
          art.pinCampaignArtTx = async (...args) => {
            if (args[4] === `map:scene-${turn.id}:background`)
              throw new ApiException(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
            return original(...args);
          };
          try {
            await drain(id, live);
          } finally {
            art.pinCampaignArtTx = original;
          }
          assert.equal(live.state.entities[actor].mapId, origin);
          assert.equal(live.state.maps[`scene-${turn.id}`], undefined);
          const result = (
            await db.query(
              'SELECT r.status,r.result_code,j.status AS text_status FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
              [turn.id],
            )
          ).rows[0];
          assert.equal(result.status, 'failed');
          assert.equal(result.result_code, 'ART_UNAVAILABLE');
          assert.equal(result.text_status, 'stale');
          const receipt = (await game.storyFeed(req, id)).turns.find((t) => t.id === turn.id);
          assert.equal(receipt.travel.status, 'failed');
          assert.equal(receipt.travel.imageStatus, 'admitted');
          assert.equal(receipt.travel.sparkStatus, 'settled');
          const calls = [textCalls, imageCalls];
          await drain(id, live);
          assert.deepEqual([textCalls, imageCalls], calls);
        },
      );
      await t.test(
        'mixed semantic RP commits effects once, then requests one durable illustrated continuation consent',
        async () => {
          const id = ids[8],
            live = await setup(id),
            before = structuredClone(live.state);
          textOutcome = 'semantic';
          const turn = await post(
            id,
            live,
            '*pick up notebook* *Leaving the bustle behind, he chooses Coffee and Silence as the next chapter of his day*',
          );
          await end(id, live);
          const ordinaryOperation = randomUUID();
          await db.query(
            'INSERT INTO game_ordinary_round_consents(campaign_id,round_id,owner_id,operation_id) VALUES($1,$2,$3,$4)',
            [id, live.state.turnController.roundId, owner.user.id, ordinaryOperation],
          );
          const imageBefore = imageCalls;
          await game.admitOrdinaryRound(id);
          await drain(id, live, true);
          textOutcome = 'success';
          assert.equal(imageCalls, imageBefore, 'ordinary End turn cannot create an image');
          assert.equal(live.state.entities[actor].mapId, before.entities[actor].mapId);
          assert.deepEqual(live.state.entities[actor].inventory, [`prop-${turn.id}`]);
          const children = (
            await db.query(
              "SELECT * FROM game_story_turns WHERE campaign_id=$1 AND context->>'semanticTravelSourceTurnId'=$2",
              [id, turn.id],
            )
          ).rows;
          assert.equal(children.length, 1);
          const child = children[0];
          assert.equal(child.status, 'committed');
          assert.equal(child.input.text, '*go to «Coffee and Silence»*');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_location_travel_preparations WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          const status = await game.worldGenerationStatus(req, id);
          assert.equal(status.generatedLocationImages, 1);
          assert.equal(status.estimateRiskConsentRequired, true);
          const callsBefore = [textCalls, imageCalls];
          await game.admitOrdinaryRound(id);
          assert.deepEqual([textCalls, imageCalls], callsBefore);
          const q = await quote(id);
          assert.equal(q.quote.generatedLocationImages, 1);
          const entries = (
            await db.query('SELECT entries FROM game_world_generation_batches WHERE id=$1', [
              q.quote.id,
            ])
          ).rows[0].entries;
          assert.ok(entries.some((entry) => entry.requestId === child.id));
          assert.ok(
            !entries.some((entry) => entry.requestId === turn.id),
            'do not sell the original interpreted post again',
          );
          await accept(id, q);
          await game.onModuleDestroy();
          instantiate();
          await game.snapshot(req, id);
          const restarted = game.live.get(id);
          await drain(id, restarted);
          assert.equal(restarted.state.entities[actor].mapId, `scene-${child.id}`);
          assert.deepEqual(restarted.state.entities[actor].inventory, [`prop-${turn.id}`]);
          assert.equal(restarted.state.maps[`scene-${child.id}`].label, 'Coffee and Silence');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id=$2',
                [id, turn.id],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id=$2',
                [id, child.id],
              )
            ).rows[0].n,
            1,
          );
          const callsAfter = [textCalls, imageCalls];
          await accept(id, q);
          await game.processDecisionRequests(id, restarted);
          assert.deepEqual([textCalls, imageCalls], callsAfter);
        },
      );
      await t.test(
        'declining unpaid map generation preserves the post and lets the original ordinary turn finish',
        async () => {
          const id = ids[9],
            live = await setup(id),
            origin = live.state.entities[actor].mapId;
          const turn = await post(id, live, '*I go to Optional Cafe*');
          await end(id, live);
          await db.query(
            'INSERT INTO game_ordinary_round_consents(campaign_id,round_id,owner_id,operation_id) VALUES($1,$2,$3,$4)',
            [id, live.state.turnController.roundId, owner.user.id, randomUUID()],
          );
          await game.admitOrdinaryRound(id);
          const status = await game.worldGenerationStatus(req, id);
          assert.deepEqual(status.pendingLocationIds, [turn.id]);
          const declinedQuote = await quote(id);
          const beforeCalls = [textCalls, imageCalls];
          await assert.rejects(
            () =>
              game.worldGeneration.declineLocations(guest.user.id, id, live.state, {
                requestIds: [turn.id],
              }),
            code('FORBIDDEN'),
          );
          const declined = await game.worldGenerationDecline(req, id, { requestIds: [turn.id] });
          assert.equal(declined.declined, true);
          assert.deepEqual(
            await game.worldGenerationDecline(req, id, { requestIds: [turn.id] }),
            declined,
          );
          assert.deepEqual([textCalls, imageCalls], beforeCalls);
          await assert.rejects(() => accept(id, declinedQuote), code('GENERATION_QUOTE_STALE'));
          assert.equal(
            (await game.storyFeed(req, id)).turns.find((entry) => entry.id === turn.id).travel
              .status,
            'declined',
          );
          assert.equal(
            (
              await db.query(
                'SELECT state FROM game_ordinary_round_consents WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].state,
            'pending',
          );
          assert.equal((await game.worldGenerationStatus(req, id)).generatedLocationImages, 0);
          await game.admitOrdinaryRound(id);
          await drain(id, live, true);
          await game.advanceTurnWorld(id, live);
          assert.equal(live.state.entities[actor].mapId, origin);
          assert.notEqual(live.state.turnController.phase, 'world');
          assert.equal(imageCalls, beforeCalls[1]);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id=$2',
                [id, turn.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query('SELECT status,result_code FROM game_story_turns WHERE id=$1', [
                turn.id,
              ])
            ).rows[0].status,
            'committed',
          );
        },
      );
      await t.test(
        'known-cost provider-invalid travel text terminalizes its receipt without altering liability or retrying',
        async () => {
          const id = ids[7],
            live = await setup(id, other),
            origin = live.state.entities[otherActor].mapId;
          const turn = await post(id, live, '*I go to Quiet Gallery*', other);
          await end(id, live, otherActor);
          const q = await quote(id, other);
          await accept(id, q, other);
          textOutcome = 'invalid';
          try {
            await drain(id, live);
          } finally {
            textOutcome = 'success';
          }
          assert.equal(live.state.entities[otherActor].mapId, origin);
          const row = (
            await db.query(
              `SELECT r.status,r.result_code,p.state AS preparation,j.status AS job_status,j.provider_actual_micros,h.status AS hold_status,h.reserved_subunits,h.captured_subunits
          FROM game_npc_decision_requests r JOIN game_location_travel_preparations p ON p.id=r.id
          JOIN npc_ai_jobs j ON j.id=r.job_id LEFT JOIN spark_holds h ON h.id=j.spark_hold_id WHERE r.id=$1`,
              [turn.id],
            )
          ).rows[0];
          assert.equal(row.status, 'failed');
          assert.equal(row.result_code, 'INVALID_PROPOSAL');
          assert.equal(row.preparation, 'failed');
          assert.equal(row.job_status, 'stale');
          assert.equal(Number(row.provider_actual_micros), 30);
          assert.equal(row.hold_status, 'pending');
          const receipt = (await game.storyFeed(other, id)).turns.find(
            (entry) => entry.id === turn.id,
          );
          assert.equal(receipt.travel.status, 'failed');
          assert.equal(receipt.travel.imageStatus, 'admitted');
          assert.equal(receipt.travel.sparkStatus, 'settled');
          const calls = [textCalls, imageCalls];
          await drain(id, live);
          assert.deepEqual([textCalls, imageCalls], calls);
          const hold = (
            await db.query(
              'SELECT h.status AS hold_status,h.reserved_subunits,h.captured_subunits FROM spark_holds h JOIN npc_ai_jobs j ON j.spark_hold_id=h.id JOIN game_npc_decision_requests r ON r.job_id=j.id WHERE r.id=$1',
              [turn.id],
            )
          ).rows[0];
          assert.deepEqual(hold, {
            hold_status: row.hold_status,
            reserved_subunits: row.reserved_subunits,
            captured_subunits: row.captured_subunits,
          });
        },
      );
      await t.test(
        'uncertain image preserves its liability and stops text or replacement spending',
        async () => {
          const id = ids[5],
            live = await setup(id),
            origin = live.state.entities[actor].mapId,
            turn = await post(id, live, '*I go to Mist Cafe*');
          await end(id, live);
          const q = await quote(id);
          await accept(id, q);
          imageOutcome = 'unknown';
          const calls = imageCalls;
          await drain(id, live);
          assert.equal(imageCalls, calls + 1);
          assert.equal(live.state.entities[actor].mapId, origin);
          const receipt = (await game.storyFeed(req, id)).turns.find((t) => t.id === turn.id);
          assert.equal(receipt.travel.imageStatus, 'unknown');
          assert.equal(receipt.travel.sparkStatus, 'pending');
          const storyJobs = (
            await db.query(
              "SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='story_turn'",
              [id],
            )
          ).rows[0].n;
          assert.equal(storyJobs, 0);
          await drain(id, live);
          assert.equal(imageCalls, calls + 1);
          const status = await game.worldGenerationStatus(req, id);
          assert.equal(status.unknown, true);
          assert.equal(status.pending, true);
        },
      );
      await t.test(
        'confirmed erasure scrubs travel canon and image inputs but retains unknown liabilities',
        async () => {
          const c = await db.connect();
          await c.query('BEGIN');
          try {
            const liabilities = async () =>
              (
                await c.query(
                  `SELECT j.id,j.status,j.actual_micros,h.status AS hold_status,h.reserved_subunits,h.captured_subunits
             FROM game_location_travel_preparations p JOIN image_generation_jobs j ON j.id=p.image_job_id
             LEFT JOIN spark_holds h ON h.id=j.spark_quote_id WHERE p.owner_id=$1 ORDER BY j.id`,
                  [owner.user.id],
                )
              ).rows;
            const before = await liabilities();
            assert.ok(
              before.some((row) => row.status === 'unknown' && row.hold_status === 'pending'),
            );
            await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner.user.id]);
            await eraseImageGeneration(c, owner.user.id);
            assert.deepEqual(await liabilities(), before);
            const preparations = (
              await c.query(
                'SELECT scene,canon_snapshot,image_input,image_quote,input_hash,state FROM game_location_travel_preparations WHERE owner_id=$1',
                [owner.user.id],
              )
            ).rows;
            assert.ok(preparations.length >= 5);
            for (const prep of preparations) {
              assert.deepEqual(prep.scene, {});
              assert.deepEqual(prep.canon_snapshot, {});
              assert.deepEqual(prep.image_input, {});
              assert.equal(prep.image_quote, null);
              assert.equal(prep.input_hash, 'erased');
              assert.equal(prep.state, 'failed');
            }
            const jobs = (
              await c.query(
                'SELECT input,request_hash FROM image_generation_jobs WHERE actor_id=$1',
                [owner.user.id],
              )
            ).rows;
            for (const job of jobs) {
              assert.deepEqual(job.input, {});
              assert.equal(job.request_hash, 'erased');
            }
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
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
