/** Disposable local PostgreSQL, synthetic provider only. No production IDs or external transport. */
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
const { endPlayerTurn, turnFence, createMockNpcPlan } = require('../../packages/game-core/dist');
const { SparksAccounting } = require('../../apps/api/dist/generation/sparks-accounting.js');
const database = new Db();

await test(
  'owner settles a known rejected NPC bill via HTTP, with one capture, concurrent replay and restart',
  { timeout: 120000 },
  async () => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const outsider = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const { campaignId } = await owner.request('/game/campaigns', {
        turnBased: true,
        playableVersionId: source.playableVersionId,
      });
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=1000000',
        [owner.user.id],
      );
      const profile = requestEstimateOwnerProfile();
      Object.assign(profile.text, {
        inputMicrosPerMillion: 100000,
        outputMicrosPerMillion: 500000,
        cachePricing: {
          cachedInputMicrosPerMillion: 10000,
          cacheWrite30mMicrosPerMillion: 125000,
          cacheWrite12hMicrosPerMillion: 250000,
        },
      });
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      let calls = 0;
      const inner = {
        id: 'known-settlement-synthetic',
        version: 'v1',
        external: true,
        prepareTextRequest(purpose, context) {
          const body = JSON.stringify(canonical({ purpose, context }));
          return {
            body,
            snapshot: estimateTextRequest(body, config.text, 'synthetic-settlement-v1'),
          };
        },
        async generate(request) {
          calls++;
          return {
            proposal: request.context.mockProposal,
            requestId: `synthetic-${request.jobId}`,
            usage: {
              inputTokens: 6405,
              cachedInputTokens: 1383,
              outputTokens: 201,
              cacheWriteInputTokens: 5019,
              cacheWriteInputTokensDetails: { ttl30mTokens: 5019, ttl12hTokens: 0 },
              costMicros: 743,
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
        version: 'synthetic-settlement-v1',
      });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
      clearInterval(game.timer);
      game.dispatchAi = () => {};
      const req = { headers: { cookie: owner.cookie } },
        actorId = `player-${owner.user.id}`;
      await game.snapshot(req, campaignId);
      const live = game.live.get(campaignId);
      const next = endPlayerTurn(live.state, actorId, turnFence(live.state));
      assert.equal(next.error, undefined);
      await game.persist(campaignId, live, next.state, 'test.settlement.world');
      const context = await game.decisionContext(campaignId, live.state, 'keeper', 'plan');
      context.mockProposal = createMockNpcPlan(live.state, 'keeper');
      const requestId = randomUUID();
      await db.query(
        "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context) VALUES($1,$2,'keeper','plan',$3,$4)",
        [requestId, campaignId, `test-settlement:${requestId}`, JSON.stringify(context)],
      );
      // Recreate the old producer before immutable INSERT; never rewrite an admitted bill.
      const legacyQuote = async (scope, candidate) => {
        const original = SparksAccounting.prototype.quote;
        SparksAccounting.prototype.quote = function (c, input) {
          const historical = structuredClone(input);
          delete historical.providerQuote.automaticKnownCostPolicy;
          return original.call(this, c, historical);
        };
        try {
          return await ai.quote(scope, candidate, owner.user.id);
        } finally {
          SparksAccounting.prototype.quote = original;
        }
      };
      const scope = {
        campaignId,
        npcId: 'keeper',
        purpose: 'plan',
        origin: 'user',
        requesterUserId: owner.user.id,
      };
      const quote = await legacyQuote(scope, context);
      const queued = await ai.queue({
        scope,
        context,
        operationId: randomUUID(),
        quoteId: quote.id,
        consent: true,
        runtimeRequestId: requestId,
      });
      const jobId = queued.id;
      assert.ok(jobId);
      await ai.run(jobId, async () => true);
      await database.tx((c) => ai.finalize(c, jobId, 'stale'));
      assert.equal(calls, 1);
      await game.onModuleDestroy();
      game = undefined;
      const preserved = async () => ({
        job: (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [jobId])).rows[0],
        campaign: (await db.query('SELECT * FROM game_campaigns WHERE id=$1', [campaignId]))
          .rows[0],
        provider: (
          await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
            'release:known-settlement-synthetic',
          ])
        ).rows[0],
        reservation: (
          await db.query(
            'SELECT r.* FROM generation_budget_reservations r JOIN npc_ai_jobs j ON j.generation_reservation_id=r.id WHERE j.id=$1',
            [jobId],
          )
        ).rows[0],
      });
      const before = await preserved();
      await startApi();
      const path = `/game/campaigns/${campaignId}/ai/jobs/${jobId}/settlement`;
      await outsider.request(path, undefined, 'GET', 404);
      const view = await owner.request(path);
      assert.equal(view.actualMicros, '743');
      assert.equal(view.captureSubunits, '1486');
      assert.equal(view.status, 'pending');
      assert.equal(view.settlementMode, 'legacy_confirmation');
      const discovery = await owner.request('/sparks/settlements');
      assert.equal(
        discovery.entries.find((entry) => entry.holdId === view.holdId)?.state,
        'verified',
      );
      assert.equal((await outsider.request('/sparks/settlements')).entries.length, 0);
      const body = {
        operationId: randomUUID(),
        holdId: view.holdId,
        expectedActualMicros: view.actualMicros,
        expectedReservedSubunits: view.reservedSubunits,
        expectedCaptureSubunits: view.captureSubunits,
        consent: true,
      };
      await outsider.request(path, body, 'POST', 404);
      await owner.request(path, { ...body, expectedActualMicros: '744' }, 'POST', 409);
      const results = await Promise.all([owner.request(path, body), owner.request(path, body)]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].status, 'settled');
      assert.deepEqual(results[0].sparks, { balanceSubunits: '998514', heldSubunits: '0' });
      assert.equal(results[0].releaseSubunits, String(BigInt(view.reservedSubunits) - 1486n));
      assert.deepEqual(await preserved(), before);
      assert.equal(calls, 1);
      const ledger = (
        await db.query(
          "SELECT kind,amount_subunits FROM spark_ledger WHERE hold_id=$1 AND kind IN ('capture','release') ORDER BY kind",
          [view.holdId],
        )
      ).rows;
      assert.deepEqual(ledger, [
        { kind: 'capture', amount_subunits: '1486' },
        { kind: 'release', amount_subunits: results[0].releaseSubunits },
      ]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM audit WHERE target_id=$1 AND action='npc.known_failure.settled'",
            [jobId],
          )
        ).rows[0].n,
        1,
      );
      await stopApi('SIGKILL');
      await startApi();
      assert.deepEqual(await owner.request(path, body), results[0]);
      await owner.request(path, { ...body, operationId: randomUUID() }, 'POST', 409);
      assert.deepEqual(await preserved(), before);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM spark_ledger WHERE hold_id=$1 AND kind='capture'",
            [view.holdId],
          )
        ).rows[0].n,
        1,
      );
      // A separately admitted player story_turn uses the same accounting and owner boundary.
      await db.query(
        'INSERT INTO dream_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,balance_subunits=1000',
        [owner.user.id],
      );
      const playerState = (
        await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
      ).rows[0].state;
      const playerContext = {
        turnFence: turnFence(playerState),
        contextHash: randomUUID(),
        mockProposal: { actions: [{ kind: 'wait' }] },
      };
      const playerScope = {
        campaignId,
        npcId: actorId,
        subjectKind: 'player',
        purpose: 'story_turn',
        origin: 'user',
        requesterUserId: owner.user.id,
      };
      const playerQuote = await legacyQuote(playerScope, playerContext);
      const playerJob = await ai.queue({
        scope: playerScope,
        context: playerContext,
        operationId: randomUUID(),
        quoteId: playerQuote.id,
        consent: true,
      });
      await ai.run(playerJob.id, async () => true);
      await database.tx((c) => ai.finalize(c, playerJob.id, 'stale'));
      const playerPath = `/game/campaigns/${campaignId}/ai/jobs/${playerJob.id}/settlement`;
      const playerView = await owner.request(playerPath);
      assert.equal(playerView.settlementMode, 'legacy_confirmation');
      assert.equal(playerView.captureSubunits, '1486');
      assert.equal(playerView.funding.dreamsCaptureSubunits, '1000');
      assert.equal(playerView.funding.sparksCaptureSubunits, '486');
      const playerBefore = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [playerJob.id]))
        .rows[0];
      const playerBody = {
        operationId: randomUUID(),
        holdId: playerView.holdId,
        expectedActualMicros: playerView.actualMicros,
        expectedReservedSubunits: playerView.reservedSubunits,
        expectedCaptureSubunits: playerView.captureSubunits,
        consent: true,
      };
      await outsider.request(playerPath, playerBody, 'POST', 404);
      const playerResults = await Promise.all([
        owner.request(playerPath, playerBody),
        owner.request(playerPath, playerBody),
      ]);
      assert.deepEqual(playerResults[0], playerResults[1]);
      assert.equal(playerResults[0].status, 'settled');
      assert.deepEqual(await owner.request(playerPath, playerBody), playerResults[0]);
      assert.equal((await owner.request(playerPath)).status, 'settled');
      assert.deepEqual(
        (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [playerJob.id])).rows[0],
        playerBefore,
      );
      assert.equal(calls, 2);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM spark_ledger WHERE hold_id=$1 AND kind='capture'",
            [playerView.holdId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM audit WHERE target_id=$1 AND action='npc.known_failure.settled'",
            [playerJob.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal((await owner.request('/sparks/settlements')).entries.length, 0);
    } finally {
      await game?.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
