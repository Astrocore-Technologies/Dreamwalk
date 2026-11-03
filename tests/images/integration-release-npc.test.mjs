/** Real disposable PostgreSQL, injected synthetic providers; never network dispatch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../game/support-runtime.mjs';
import { requestEstimateOwnerProfile } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { canonical } = require('../../apps/api/dist/ai/context.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { ProviderFailure } = require('../../apps/api/dist/ai/types.js');
const database = {
  query: async (sql, p = []) => (await db.query(sql, p)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
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
  id: 'release-npc-fixture',
  version: 'synthetic-v1',
  external: true,
  prepareTextRequest(purpose, context) {
    const body = JSON.stringify(canonical({ purpose, context }));
    return {
      body,
      snapshot: estimateTextRequest(body, config.text, 'release-fixture-fingerprint'),
    };
  },
  async generate(req) {
    calls++;
    if (req.context.testOutcome === 'unknown') throw new ProviderFailure('SYNTHETIC_TIMEOUT', true);
    const cost = req.context.testOutcome === 'overrun' ? req.maxCostMicros + 100 : 30;
    return {
      proposal: { actions: [{ kind: 'wait' }] },
      requestId: `fixture-${req.jobId}`,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        costMicros: cost,
        costEvidence: 'configured_rates',
      },
    };
  },
};
const provider = new ReleaseGenerationProvider(inner, authority);
const engine = new NpcAiEngine(database, provider, {
  externalApproved: true,
  creditPrice: 0,
  providerUpperMicros: config.text.upperMicros,
  providerCapMicros: config.aggregateCapMicros,
  version: 'release-fixture-v1',
});
const code = (e) => e?.getResponse?.().code ?? e?.message;
async function actor(enabled = true, balance = 500000) {
  const id = randomUUID(),
    campaign = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'unusable','Fixture',$3)",
    [id, `${id}@example.test`, `npc_${id.replaceAll('-', '').slice(0, 12)}`],
  );
  await db.query('INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,$2,$3)', [
    id,
    enabled,
    balance,
  ]);
  await db.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic','{}')",
    [campaign, id],
  );
  await db.query(
    "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'hero','accepted')",
    [campaign, id],
  );
  return { id, campaign };
}
const scope = (a) => ({
  campaignId: a.campaign,
  npcId: 'npc',
  origin: 'user',
  requesterUserId: a.id,
  purpose: 'plan',
});
const wallet = async (a) =>
  (
    await db.query('SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1', [
      a.id,
    ])
  ).rows[0];
async function enqueue(a, extra = {}) {
  const context = { contextHash: randomUUID(), ...extra };
  const s = scope(a);
  const q = await engine.quote(s, context, a.id);
  const input = {
    scope: s,
    context,
    operationId: randomUUID(),
    requesterUserId: a.id,
    quoteId: q.id,
    consent: true,
  };
  return { job: await engine.queue(input), input, q };
}
await test(
  'release native NPC and explicit system permits retain exactly one payer/hold',
  { timeout: 60000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      await t.test(
        'ordinary authenticated quote runs with no runtime request or test claim and replays once',
        async () => {
          const a = await actor();
          const { job, input } = await enqueue(a);
          const duplicates = await Promise.all([engine.queue(input), engine.queue(input)]);
          assert.ok(duplicates.every((value) => value.id === job.id));
          assert.equal(
            (await db.query('SELECT count(*) n FROM spark_holds WHERE owner_id=$1', [a.id])).rows[0]
              .n,
            '1',
          );
          await engine.run(job.id, async () => true);
          assert.equal(calls, 1);
          await database.tx((c) => engine.finalize(c, job.id, 'committed'));
          await database.tx((c) => engine.finalize(c, job.id, 'committed'));
          assert.deepEqual(await wallet(a), { balance_subunits: '499940', held_subunits: '0' });
          const record = (
            await db.query(
              'SELECT r.actual_micros,r.spark_quote_id,j.spark_hold_id FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id WHERE j.id=$1',
              [job.id],
            )
          ).rows[0];
          assert.equal(record.actual_micros, '30');
          assert.equal(record.spark_quote_id, record.spark_hold_id);
        },
      );
      await t.test(
        'required email verification gates release quote and dispatch without changing funds',
        async () => {
          const a = await actor();
          await db.query(
            'UPDATE users SET email_verification_required=true,email_verified=false WHERE id=$1',
            [a.id],
          );
          const before = await wallet(a),
            beforeCalls = calls;
          await assert.rejects(
            engine.quote(scope(a), { contextHash: randomUUID() }, a.id),
            (e) => code(e) === 'FORBIDDEN',
          );
          assert.deepEqual(await wallet(a), before);
          assert.equal(
            (await db.query('SELECT count(*) n FROM npc_ai_quotes WHERE user_id=$1', [a.id]))
              .rows[0].n,
            '0',
          );
          assert.equal(calls, beforeCalls);
          await db.query('UPDATE users SET email_verified=true WHERE id=$1', [a.id]);
          const { job } = await enqueue(a);
          const held = await wallet(a);
          await db.query('UPDATE users SET email_verified=false WHERE id=$1', [a.id]);
          await engine.run(job.id, async () => true);
          assert.equal(calls, beforeCalls);
          assert.deepEqual(await wallet(a), held);
          assert.equal(
            (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [job.id])).rows[0].status,
            'reserved',
          );
          await db.query('UPDATE users SET email_verified=true WHERE id=$1', [a.id]);
          await engine.run(job.id, async () => true);
          assert.equal(calls, beforeCalls + 1);
          await database.tx((c) => engine.finalize(c, job.id, 'committed'));
          assert.deepEqual(await wallet(a), { balance_subunits: '499940', held_subunits: '0' });
        },
      );
      await t.test('disabled and insufficient wallets cannot admit a paid request', async () => {
        const disabled = await actor(false);
        await assert.rejects(enqueue(disabled), (e) => code(e) === 'SPARK_WALLET_NOT_ENABLED');
        const empty = await actor(true, 0);
        await assert.rejects(enqueue(empty), (e) => /INSUFFICIENT_SPARKS/.test(code(e)));
        assert.equal(
          (
            await db.query('SELECT count(*) n FROM npc_ai_jobs WHERE campaign_id=$1', [
              empty.campaign,
            ])
          ).rows[0].n,
          '0',
        );
      });
      await t.test(
        'parallel actors remain independent and unknown request retains only its own reserve',
        async () => {
          const a = await actor(),
            b = await actor();
          const [x, y] = await Promise.all([enqueue(a, { testOutcome: 'unknown' }), enqueue(b)]);
          await Promise.all([
            engine.run(x.job.id, async () => true),
            engine.run(y.job.id, async () => true),
          ]);
          await database.tx((c) => engine.finalize(c, y.job.id, 'committed'));
          assert.ok(BigInt((await wallet(a)).held_subunits) > 0n);
          assert.equal((await wallet(b)).held_subunits, '0');
          assert.equal(
            (
              await db.query('SELECT blocked FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                provider.id,
              ])
            ).rows[0].blocked,
            false,
          );
          assert.equal((await authority.status(a.id)).state, 'stopped');
          assert.equal((await authority.status(b.id)).state, 'active');
        },
      );
      await t.test(
        'overrun stores full liability without globally stopping other accounts',
        async () => {
          const a = await actor();
          const x = await enqueue(a, { testOutcome: 'overrun' });
          await engine.run(x.job.id, async () => true);
          const row = (
            await db.query(
              'SELECT r.actual_micros,r.upper_micros,b.blocked FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id JOIN generation_budget_scopes b ON b.id=r.scope_id WHERE j.id=$1',
              [x.job.id],
            )
          ).rows[0];
          assert.equal(BigInt(row.actual_micros), BigInt(row.upper_micros) + 100n);
          assert.equal(row.blocked, true);
          assert.equal(
            (
              await db.query('SELECT blocked FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                provider.id,
              ])
            ).rows[0].blocked,
            false,
          );
        },
      );
      for (const withRequester of [false, true])
        await t.test(
          `explicit runtime permit ${withRequester ? 'with requester' : 'system payer'} never creates a second hold`,
          async () => {
            const a = await actor(),
              id = randomUUID();
            const fence = { roundId: 'round', phaseEpoch: 1, rulesetVersion: 1 };
            await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
              a.campaign,
              JSON.stringify({
                turnController: { ...fence, phase: 'world', ruleset: { version: 1 } },
              }),
            ]);
            const context = { contextHash: randomUUID(), turnFence: fence };
            await db.query(
              "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,'npc','plan',$3,$4,$5)",
              [id, a.campaign, id, withRequester ? a.id : null, JSON.stringify(context)],
            );
            const request = (await authority.pending(a.id, a.campaign)).requests[0];
            await authority.consent(a.id, a.campaign, id, {
              operationId: randomUUID(),
              consent: true,
              turnFence: fence,
              policyRevision: request.policyRevision,
              policyHash: request.policyHash,
              estimateFingerprint: request.estimateSnapshot.fingerprint,
            });
            const before = (
              await db.query(
                'SELECT spark_quote_id FROM live_test_text_permits WHERE request_id=$1',
                [id],
              )
            ).rows[0].spark_quote_id;
            const s = withRequester
              ? scope(a)
              : { ...scope(a), origin: 'system', requesterUserId: undefined };
            const job = await engine.queue({
              scope: s,
              context,
              operationId: randomUUID(),
              runtimeRequestId: id,
              ...(withRequester ? { requesterUserId: a.id } : {}),
            });
            const row = (
              await db.query(
                'SELECT j.spark_hold_id,r.spark_quote_id FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id WHERE j.id=$1',
                [job.id],
              )
            ).rows[0];
            assert.equal(job.chargeUnit, 'sparks');
            assert.equal(job.demo, false);
            assert.equal(row.spark_hold_id, null);
            assert.equal(row.spark_quote_id, before);
            assert.equal(
              (await db.query('SELECT count(*) n FROM spark_holds WHERE owner_id=$1', [a.id]))
                .rows[0].n,
              '1',
            );
            await engine.run(job.id, async () => true);
            const afterRun = (
              await db.query('SELECT status,result_code FROM npc_ai_jobs WHERE id=$1', [job.id])
            ).rows[0];
            assert.equal(afterRun.status, 'result_received', JSON.stringify(afterRun));
            await database.tx((c) => engine.finalize(c, job.id, 'committed'));
            assert.equal((await wallet(a)).held_subunits, '0');
          },
        );
      await t.test(
        'system request without explicit payer proof cannot create an allowance',
        async () => {
          const a = await actor();
          await assert.rejects(
            engine.queue({
              scope: { campaignId: a.campaign, npcId: 'npc', origin: 'system', purpose: 'plan' },
              context: { contextHash: 'synthetic' },
              operationId: randomUUID(),
            }),
            (e) => code(e) === 'GENERATION_EXPLICIT_PAYER_REQUIRED',
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*) n FROM live_test_sessions WHERE owner_id=$1 AND mode='release'",
                [a.id],
              )
            ).rows[0].n,
            '0',
          );
        },
      );
      await t.test(
        'historical incompatible jobs are retained untouched while current release jobs can run',
        async () => {
          const a = await actor();
          const oldId = randomUUID();
          await db.query(
            `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at,provider_upper_micros,provider_budget_status) VALUES($1,$2,'legacy-npc',$3,'synthetic','system','plan','synthetic','{}','legacy-fixture','legacy-v1','legacy-v1','reserved',now()-interval '1 hour',55,'reserved')`,
            [oldId, a.campaign, randomUUID()],
          );
          await db.query(
            'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,reserved_micros) VALUES($1,1000,55) ON CONFLICT DO NOTHING',
            ['legacy-fixture'],
          );
          const before = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [oldId])).rows[0];
          await engine.sweep(a.campaign);
          await engine.run(oldId, async () => true);
          const current = await enqueue(a);
          await engine.runNext(a.campaign, async () => true);
          assert.deepEqual(
            (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [oldId])).rows[0],
            before,
          );
          assert.equal(
            (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [current.job.id])).rows[0]
              .status,
            'result_received',
          );
          await database.tx((c) => engine.finalize(c, current.job.id, 'committed'));
          assert.equal(
            (
              await db.query(
                'SELECT reserved_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
                ['legacy-fixture'],
              )
            ).rows[0].reserved_micros,
            '55',
          );
        },
      );
      await t.test(
        'late actual above provider cap is retained in full without erasing the unknown hold',
        async () => {
          const a = await actor();
          const x = await enqueue(a, { testOutcome: 'unknown' });
          await engine.run(x.job.id, async () => true);
          const actual = config.aggregateCapMicros + 123;
          await engine.reconcile(x.job.id, `late:${x.job.id}`, actual);
          const receipt = (
            await db.query(
              'SELECT r.actual_micros,j.provider_actual_micros FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id WHERE j.id=$1',
              [x.job.id],
            )
          ).rows[0];
          assert.equal(receipt.actual_micros, String(actual));
          assert.equal(receipt.provider_actual_micros, String(actual));
          assert.ok(BigInt((await wallet(a)).held_subunits) > 0n);
          assert.equal(
            (
              await db.query('SELECT blocked FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                provider.id,
              ])
            ).rows[0].blocked,
            false,
          );
        },
      );
      await t.test(
        'explicit unlimited release lifts only provider cap and preserves wallet admission and historical spend',
        async () => {
          const profile = requestEstimateOwnerProfile();
          delete profile.totalCapMicros;
          delete profile.textCapMicros;
          delete profile.imageCapMicros;
          const unlimitedConfig = readGenerationConfig({
            GENERATION_MODE: 'release',
            GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, allowance: 'unlimited' }),
          });
          const unboundedAuthority = new GenerationAuthority(database, unlimitedConfig);
          const unboundedProvider = new ReleaseGenerationProvider(
            { ...inner, id: 'unlimited-npc-fixture' },
            unboundedAuthority,
          );
          const unbounded = new NpcAiEngine(database, unboundedProvider, {
            externalApproved: true,
            creditPrice: 0,
            providerUpperMicros: unlimitedConfig.text.upperMicros,
            providerCapMicros: null,
            version: 'unlimited-fixture',
          });
          assert.throws(
            () => new NpcAiEngine(database, inner, { providerCapMicros: null }),
            /INVALID_AI_BUDGET/,
          );
          assert.throws(
            () => new NpcAiEngine(database, provider, { providerCapMicros: null }),
            /INVALID_AI_BUDGET/,
          );
          const a = await actor();
          await db.query(
            'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros) VALUES($1,0)',
            [unboundedProvider.id],
          );
          for (let i = 0; i < 2; i++) {
            const context = { contextHash: randomUUID() },
              q = await unbounded.quote(scope(a), context, a.id);
            const input = {
              scope: scope(a),
              context,
              operationId: randomUUID(),
              quoteId: q.id,
              consent: true,
            };
            const job = await unbounded.queue(input);
            assert.equal((await unbounded.queue(input)).id, job.id);
            await unbounded.run(job.id, async () => true);
            await database.tx((c) => unbounded.finalize(c, job.id, 'committed'));
            if (i === 0)
              await db.query(
                'UPDATE npc_ai_provider_budgets SET spent_micros=1000000000000 WHERE provider_id=$1',
                [unboundedProvider.id],
              );
          }
          const budget = (
            await db.query(
              'SELECT cap_micros,unlimited_allowance,spent_micros,reserved_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
              [unboundedProvider.id],
            )
          ).rows[0];
          assert.deepEqual(budget, {
            cap_micros: null,
            unlimited_allowance: true,
            spent_micros: '1000000000030',
            reserved_micros: '0',
          });
          assert.deepEqual(await wallet(a), { balance_subunits: '499880', held_subunits: '0' });
          await db.query('UPDATE spark_wallets SET balance_subunits=0 WHERE owner_id=$1', [a.id]);
          await assert.rejects(
            async () => {
              const context = { contextHash: randomUUID() };
              const q = await unbounded.quote(scope(a), context, a.id);
              return unbounded.queue({
                scope: scope(a),
                context,
                operationId: randomUUID(),
                quoteId: q.id,
                consent: true,
              });
            },
            (e) => /INSUFFICIENT_SPARKS/.test(code(e)),
          );
        },
      );
    } finally {
      await db.end();
    }
  },
);
