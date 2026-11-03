/** Exact composer consent against disposable PostgreSQL and an injected local provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const {
  activateReleaseDeployment,
} = require('../images/release-deployment-fixture.cjs');
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
const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch.js');
const { createMockNpcPlan } = require('../../packages/game-core/dist');
const database = new Db();
const code = (expected) => (error) => error.getResponse?.().code === expected;
await test(
  'durable world generation batch authorizes only its exact immutable unpaid list',
  { timeout: 120000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().registerLegacyFixture();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 9; i++) {
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
            proposal: request.context.mockProposal,
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

      const batch = new WorldGenerationBatch(database, ai);
      async function pendingWorld(id) {
        const live = await setup(id);
        const next = endPlayerTurn(live.state, actorId, turnFence(live.state));
        assert.equal(next.error, undefined);
        await game.persist(id, live, next.state, 'test.batch.world');
        return live;
      }
      async function addRequest(id, live, extra = {}) {
        const requestId = randomUUID();
        const context = await game.decisionContext(id, live.state, 'keeper', 'plan');
        context.mockProposal = createMockNpcPlan(live.state, 'keeper');
        Object.assign(context, extra);
        await db.query(
          `INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context)
          VALUES($1,$2,'keeper','plan',$3,$4)`,
          [requestId, id, `test-batch:${requestId}`, JSON.stringify(context)],
        );
        return requestId;
      }
      await t.test(
        'quote and cancellation cause no provider calls, no wallet holds and no state mutation',
        async () => {
          const id = ids[0],
            live = await pendingWorld(id);
          await addRequest(id, live);
          const before = structuredClone(live.state),
            funds = await wallet(),
            operationId = randomUUID();
          assert.deepEqual(await batch.status(owner.user.id, id, live.state), {
            available: true,
            pending: false,
            unknown: false,
          });
          const q = await batch.quote(owner.user.id, id, live.state, { operationId });
          assert.equal(q.quote.chargeUnit, 'sparks');
          assert.ok(q.quote.providerReserveMicros > 0);
          assert.deepEqual(await batch.quote(owner.user.id, id, live.state, { operationId }), q);
          assert.deepEqual(live.state, before);
          assert.deepEqual(await wallet(), funds);
          assert.equal(calls, 0);
          assert.equal((await requests(id))[0].requester_user_id, null);
        },
      );
      await t.test(
        'new unpaid request invalidates exact list; edited context and invalid operation cannot consent',
        async () => {
          const id = ids[1],
            live = await pendingWorld(id);
          const first = await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          await addRequest(id, live);
          await assert.rejects(
            batch.consent(owner.user.id, id, live.state, {
              operationId,
              quoteId: q.quote.id,
              consent: true,
            }),
            code('GENERATION_QUOTE_STALE'),
          );
          const op2 = randomUUID(),
            q2 = await batch.quote(owner.user.id, id, live.state, { operationId: op2 });
          await db.query(
            'UPDATE game_npc_decision_requests SET context=context||\'{"changed":true}\' WHERE id=$1',
            [first],
          );
          await assert.rejects(
            batch.consent(owner.user.id, id, live.state, {
              operationId: op2,
              quoteId: q2.quote.id,
              consent: true,
            }),
            code('GENERATION_QUOTE_STALE'),
          );
          await assert.rejects(
            batch.consent(owner.user.id, id, live.state, {
              operationId: randomUUID(),
              quoteId: q2.quote.id,
              consent: true,
            }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.equal(calls, 0);
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test(
        'single acceptance is atomic and idempotent; sequential scheduler waits for prior job',
        async () => {
          const id = ids[2],
            live = await pendingWorld(id);
          await addRequest(id, live);
          await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          const body = { operationId, quoteId: q.quote.id, consent: true };
          const result = await Promise.all([
            batch.consent(owner.user.id, id, live.state, body),
            batch.consent(owner.user.id, id, live.state, body),
          ]);
          assert.deepEqual(result[0], result[1]);
          assert.equal(calls, 0);
          assert.equal((await wallet()).held_subunits, '0');
          assert.ok((await requests(id)).every((r) => r.requester_user_id === owner.user.id));
          await game.processDecisionRequests(id, live);
          const scheduled = (await requests(id)).filter((r) => r.job_id);
          assert.equal(scheduled.length, 1);
          const waiting = (await requests(id)).find((r) => !r.job_id);
          assert.equal(await batch.quotedWorldRequest(id, waiting), null);
          assert.equal((await batch.status(owner.user.id, id, live.state)).pending, true);
          await ai.run(scheduled[0].job_id, async () => true);
          await database.tx((c) => ai.finalize(c, scheduled[0].job_id, 'committed'));
          assert.equal(calls, 1);
          await game.processDecisionRequests(id, live);
          const next = (await requests(id)).find((r) => r.id === waiting.id);
          if (next.job_id) {
            await ai.run(next.job_id, async () => true);
            await database.tx((c) => ai.finalize(c, next.job_id, 'committed'));
          }
          assert.ok(calls <= 2);
          // Accept replay never creates a new quote, native job or financial hold.
          assert.equal((await batch.consent(owner.user.id, id, live.state, body)).accepted, true);
          assert.equal((await requests(id)).filter((r) => r.job_id).length, 2);
        },
      );
      await t.test(
        'accepted snapshot context drift is invalidated before any provider admission',
        async () => {
          const id = ids[3],
            live = await pendingWorld(id);
          const requestId = await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          await batch.consent(owner.user.id, id, live.state, {
            operationId,
            quoteId: q.quote.id,
            consent: true,
          });
          const staleCaller = (await requests(id))[0];
          await db.query(
            'UPDATE game_npc_decision_requests SET context=context||\'{"changed":true}\' WHERE id=$1',
            [requestId],
          );
          assert.equal(await batch.quotedWorldRequest(id, staleCaller), null);
          assert.equal(
            (
              await db.query('SELECT state FROM game_world_generation_batches WHERE id=$1', [
                q.quote.id,
              ])
            ).rows[0].state,
            'stale',
          );
          assert.equal((await wallet()).held_subunits, '0');
        },
      );
      await t.test('other owner cannot read, quote or consent a private world batch', async () => {
        const id = ids[4],
          live = await pendingWorld(id);
        await addRequest(id, live);
        await assert.rejects(batch.status(randomUUID(), id, live.state), code('FORBIDDEN'));
        await assert.rejects(
          batch.quote(randomUUID(), id, live.state, { operationId: randomUUID() }),
          code('FORBIDDEN'),
        );
      });

      await t.test(
        'aggregate insufficient funds rejects the entire acceptance before any job or hold',
        async () => {
          const id = ids[5],
            live = await pendingWorld(id);
          await addRequest(id, live);
          await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          const before = await wallet();
          await db.query('UPDATE spark_wallets SET balance_subunits=$2 WHERE owner_id=$1', [
            owner.user.id,
            String(BigInt(q.quote.sparkReservedSubunits) - 1n),
          ]);
          await assert.rejects(
            batch.consent(owner.user.id, id, live.state, {
              operationId,
              quoteId: q.quote.id,
              consent: true,
            }),
            code('INSUFFICIENT_SPARKS'),
          );
          assert.ok((await requests(id)).every((r) => !r.job_id && !r.requester_user_id));
          assert.equal((await wallet()).held_subunits, '0');
          await db.query('UPDATE spark_wallets SET balance_subunits=$2 WHERE owner_id=$1', [
            owner.user.id,
            before.balance_subunits,
          ]);
        },
      );
      await t.test(
        'status is read-only on expired approval; expired and accepted quotes cannot replay as fresh',
        async () => {
          const id = ids[6],
            live = await pendingWorld(id);
          await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          await batch.consent(owner.user.id, id, live.state, {
            operationId,
            quoteId: q.quote.id,
            consent: true,
          });
          await assert.rejects(
            batch.quote(owner.user.id, id, live.state, { operationId }),
            code('GENERATION_QUOTE_STALE'),
          );
          await db.query(
            "UPDATE game_world_generation_batches SET expires_at=now()-interval '1 minute' WHERE id=$1",
            [q.quote.id],
          );
          const status = await batch.status(owner.user.id, id, live.state);
          assert.equal(status.available, true);
          assert.equal(status.pending, false);
          assert.equal(
            (
              await db.query('SELECT state FROM game_world_generation_batches WHERE id=$1', [
                q.quote.id,
              ])
            ).rows[0].state,
            'accepted',
          );
          await assert.rejects(
            batch.quote(owner.user.id, id, live.state, { operationId }),
            code('GENERATION_QUOTE_STALE'),
          );
        },
      );
      await t.test(
        'cancelled first job stops remaining batch; persisted context is checked despite a stale caller row',
        async () => {
          const id = ids[7],
            live = await pendingWorld(id);
          await addRequest(id, live);
          await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          await batch.consent(owner.user.id, id, live.state, {
            operationId,
            quoteId: q.quote.id,
            consent: true,
          });
          await game.processDecisionRequests(id, live);
          const list = await requests(id),
            first = list.find((r) => r.job_id),
            second = list.find((r) => !r.job_id);
          await ai.cancel(first.job_id);
          assert.equal(await batch.quotedWorldRequest(id, second), null);
          assert.equal(
            (
              await db.query('SELECT state FROM game_world_generation_batches WHERE id=$1', [
                q.quote.id,
              ])
            ).rows[0].state,
            'stale',
          );
          assert.equal((await requests(id)).filter((r) => r.job_id).length, 1);
        },
      );
      await t.test(
        'unknown native outcome and queue-commit/request-link crash block every remaining authorization',
        async () => {
          const id = ids[8],
            live = await pendingWorld(id);
          await addRequest(id, live);
          await addRequest(id, live);
          const operationId = randomUUID(),
            q = await batch.quote(owner.user.id, id, live.state, { operationId });
          await batch.consent(owner.user.id, id, live.state, {
            operationId,
            quoteId: q.quote.id,
            consent: true,
          });
          await game.processDecisionRequests(id, live);
          const list = await requests(id),
            first = list.find((r) => r.job_id),
            second = list.find((r) => !r.job_id);
          await db.query("UPDATE npc_ai_jobs SET status='reconciling' WHERE id=$1", [first.job_id]);
          await db.query(
            "UPDATE game_npc_decision_requests SET status='queued',job_id=NULL WHERE id=$1",
            [first.id],
          );
          assert.deepEqual(await batch.status(owner.user.id, id, live.state), {
            available: false,
            pending: true,
            unknown: true,
          });
          assert.equal(await batch.quotedWorldRequest(id, second), null);
          await assert.rejects(
            batch.quote(owner.user.id, id, live.state, { operationId: randomUUID() }),
            code('LIVE_OUTCOME_UNRESOLVED'),
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS count FROM npc_ai_jobs WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].count,
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
