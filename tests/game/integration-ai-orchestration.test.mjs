/** Real disposable-PG tests; every provider below is a local fake, never paid/external traffic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { purgeNpcAiData, exportNpcAiData } from '../../scripts/npc-ai-data-requests.mjs';
const require = createRequire(import.meta.url);
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { MockNpcProvider, HttpJsonNpcProvider } = require('../../apps/api/dist/ai/provider.js');
const { readNpcAiConfiguration } = require('../../apps/api/dist/ai/config.js');
const { Db } = require('../../apps/api/dist/db.js');
const database = new Db();
let sequence = 0;
function makeProvider(options = {}) {
  const mock = new MockNpcProvider(options);
  return {
    id: `mock-test-${randomUUID()}`,
    version: 'test-v1',
    external: false,
    generate: mock.generate.bind(mock),
  };
}
function engine(options = {}, policy = {}) {
  return new NpcAiEngine(database, makeProvider(options), {
    creditPrice: 3,
    providerUpperMicros: 10,
    providerCapMicros: 100,
    timeoutMs: 1000,
    ...policy,
  });
}
function context(extra = {}) {
  return {
    contextHash: `context-${++sequence}`,
    mockProposal: { actions: [{ kind: 'wait' }] },
    ...extra,
  };
}
const code = (expected) => (e) => e?.getResponse?.().code === expected;
await test(
  'AI orchestration reserves, applies, reconciles and erases without external calls',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const a = await client().register();
      await db.query("UPDATE users SET role='admin' WHERE id=$1", [a.user.id]);
      await db.query('UPDATE wallets SET balance=1000 WHERE user_id=$1', [a.user.id]);
      const { campaignId } = await a.request('/game/campaigns', { template: 'observatory-v1' });
      const scope = {
        campaignId,
        npcId: 'keeper',
        origin: 'user',
        requesterUserId: a.user.id,
        purpose: 'plan',
      };
      async function queue(e, ctx = context(), s = scope) {
        const q = await e.quote(s, ctx, a.user.id);
        const input = {
          scope: s,
          operationId: randomUUID(),
          context: ctx,
          quoteId: q.id,
          consent: true,
        };
        return { job: await e.queue(input), input, ctx };
      }
      async function row(id) {
        return (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [id])).rows[0];
      }
      async function budget(e) {
        return (
          await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
            e.provider.id,
          ])
        ).rows[0];
      }
      await t.test(
        'one quote, idempotent reservation, atomic capture and prior public operation replay',
        async () => {
          const e = engine({ costMicros: 4 }),
            { job, input } = await queue(e);
          assert.deepEqual(await e.queue(input), job);
          assert.equal((await e.wallet(a.user.id)).reserved, 3);
          await assert.rejects(
            () => e.queue({ ...input, operationId: randomUUID() }),
            code('QUOTE_CONSUMED'),
          );
          await a.request(
            '/admin/credits',
            { userId: a.user.id, amount: -999, reason: 'held guard', idempotencyKey: randomUUID() },
            'POST',
            409,
          );
          await e.run(job.id, async () => true);
          assert.equal((await e.ready(campaignId))[0].id, job.id);
          await assert.rejects(() =>
            database.tx(async (c) => {
              await e.finalize(c, job.id, 'committed');
              throw new Error('forced transaction rollback');
            }),
          );
          assert.equal((await row(job.id)).reservation_status, 'held');
          await database.tx((c) => e.finalize(c, job.id, 'committed'));
          await database.tx((c) => e.finalize(c, job.id, 'committed'));
          assert.equal(
            (
              await db.query('SELECT count(*) FROM ledger WHERE source_key=$1', [
                `npc-ai:${job.id}:capture`,
              ])
            ).rows[0].count,
            '1',
          );
          assert.equal(
            (await e.replay(scope, input.operationId, input.quoteId, true)).status,
            'committed',
          );
          await assert.rejects(
            () => e.replay({ ...scope, npcId: 'other' }, input.operationId, input.quoteId, true),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.equal((await budget(e)).spent_micros, '4');
          assert.equal((await budget(e)).reserved_micros, '0');
        },
      );
      await t.test(
        'parallel holds cannot spend the same last balance and admin source key is replay safe',
        async () => {
          await db.query('UPDATE wallets SET balance=3 WHERE user_id=$1', [a.user.id]);
          const e = engine(),
            ctx = context(),
            s2 = { ...scope, npcId: 'helper' };
          const q1 = await e.quote(scope, ctx, a.user.id),
            q2 = await e.quote(s2, ctx, a.user.id);
          const results = await Promise.allSettled([
            e.queue({
              scope,
              context: ctx,
              operationId: randomUUID(),
              quoteId: q1.id,
              consent: true,
            }),
            e.queue({
              scope: s2,
              context: ctx,
              operationId: randomUUID(),
              quoteId: q2.id,
              consent: true,
            }),
          ]);
          assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal(
            results.filter((r) => r.status === 'rejected' && code('BUDGET_EXCEEDED')(r.reason))
              .length,
            1,
          );
          await e.cancel(results.find((r) => r.status === 'fulfilled').value.id);
          const key = randomUUID(),
            body = {
              userId: a.user.id,
              amount: 10,
              reason: 'demo test topup',
              idempotencyKey: key,
            };
          await a.request('/admin/credits', body);
          await a.request('/admin/credits', body);
          assert.equal((await e.wallet(a.user.id)).balance, 13);
          await db.query('UPDATE wallets SET balance=1000 WHERE user_id=$1', [a.user.id]);
        },
      );
      await t.test(
        'provider cap includes concurrent reservations and unknown outcomes, independent of released user hold',
        async () => {
          const e = engine({ failure: 'uncertain' }, { providerCapMicros: 10 }),
            { job } = await queue(e);
          await e.run(job.id, async () => true);
          assert.equal((await row(job.id)).status, 'reconciling');
          assert.equal((await e.wallet(a.user.id)).reserved, 0);
          assert.equal((await budget(e)).unknown_micros, '10');
          await assert.rejects(
            () => queue(e, context(), { ...scope, npcId: 'helper' }),
            code('PROVIDER_BUDGET_EXCEEDED'),
          );
          await e.reconcile(job.id, randomUUID(), 4);
          assert.equal((await budget(e)).spent_micros, '4');
          assert.equal((await budget(e)).unknown_micros, '0');
        },
      );
      await t.test(
        'stale results release user reserve but retain measured provider expense and cannot later commit',
        async () => {
          const e = engine({ costMicros: 6 }),
            { job } = await queue(e);
          await e.run(job.id, async () => true);
          await database.tx((c) => e.finalize(c, job.id, 'stale'));
          assert.equal((await row(job.id)).reservation_status, 'released');
          assert.equal((await budget(e)).spent_micros, '6');
          await assert.rejects(
            () => database.tx((c) => e.finalize(c, job.id, 'committed')),
            code('STALE_AI_RESULT'),
          );
        },
      );
      await t.test(
        'cache is private/context-versioned and reusing an accepted result adds no capture or provider expense',
        async () => {
          const e = engine({ costMicros: 2 }),
            ctx = context(),
            first = await queue(e, ctx);
          await e.run(first.job.id, async () => true);
          await database.tx((c) => e.finalize(c, first.job.id, 'committed'));
          const second = await queue(e, ctx);
          await e.run(second.job.id, async () => true);
          assert.equal((await row(second.job.id)).result_code, 'CACHE_REUSED');
          await database.tx((c) => e.finalize(c, second.job.id, 'committed'));
          assert.equal((await row(second.job.id)).credits, 0);
          assert.equal((await budget(e)).spent_micros, '2');
          assert.equal(
            (
              await db.query('SELECT count(*) FROM ledger WHERE source_key=$1', [
                `npc-ai:${second.job.id}:capture`,
              ])
            ).rows[0].count,
            '0',
          );
          const changed = await queue(e, context());
          await e.run(changed.job.id, async () => true);
          await e.cancel(changed.job.id);
          assert.equal((await budget(e)).spent_micros, '4');
        },
      );
      await t.test(
        'offline does not dispatch; received result is held without gameplay capture until runtime resumes',
        async () => {
          const e = engine(),
            { job } = await queue(e);
          await e.run(job.id, async () => false);
          assert.equal((await row(job.id)).status, 'reserved');
          await e.run(job.id, async () => true);
          assert.equal((await row(job.id)).status, 'result_received');
          assert.equal((await row(job.id)).reservation_status, 'held');
          await e.cancel(job.id);
        },
      );
      await t.test(
        'quote and reservation expiration never automatically obtain fresh consent',
        async () => {
          const e = engine(),
            ctx = context(),
            q = await e.quote(scope, ctx, a.user.id);
          await db.query(
            "UPDATE npc_ai_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
            [q.id],
          );
          await assert.rejects(
            () =>
              e.queue({
                scope,
                context: ctx,
                operationId: randomUUID(),
                quoteId: q.id,
                consent: true,
              }),
            code('QUOTE_EXPIRED'),
          );
          const { job } = await queue(e);
          await e.run(job.id, async () => true);
          await db.query(
            "UPDATE npc_ai_jobs SET reservation_expires_at=now()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          await e.sweep(campaignId);
          assert.equal((await row(job.id)).status, 'stale');
          await assert.rejects(
            () => database.tx((c) => e.finalize(c, job.id, 'committed')),
            code('STALE_AI_RESULT'),
          );
        },
      );
      await t.test(
        'restart recovery marks a previously dispatched expired job uncertain, never reruns it',
        async () => {
          const e = engine(),
            { job } = await queue(e);
          await db.query(
            "UPDATE npc_ai_jobs SET status='running',started_at=now()-interval '1 minute',deadline_at=now()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          let calls = 0;
          const recovered = new NpcAiEngine(
            database,
            {
              ...e.provider,
              generate: async () => {
                calls++;
                throw new Error('must not execute');
              },
            },
            e.policy,
          );
          await recovered.runNext(campaignId, async () => true);
          assert.equal(calls, 0);
          assert.equal((await row(job.id)).status, 'reconciling');
          await recovered.reconcile(job.id, randomUUID(), 0);
        },
      );
      await t.test(
        'reported cost above promised ceiling is recorded and blocks every new provider request',
        async () => {
          const e = engine({ costMicros: 15 }),
            { job } = await queue(e);
          await e.run(job.id, async () => true);
          assert.equal((await row(job.id)).provider_actual_micros, '15');
          assert.equal((await budget(e)).blocked, true);
          assert.equal((await budget(e)).overrun_micros, '5');
          await assert.rejects(
            () => queue(e, context(), { ...scope, npcId: 'helper' }),
            code('PROVIDER_DISABLED'),
          );
          await e.reconcile(job.id, randomUUID(), 15);
          assert.equal((await budget(e)).unknown_micros, '0');
          assert.equal((await budget(e)).spent_micros, '10');
          assert.equal((await budget(e)).overrun_micros, '5');
          assert.equal((await budget(e)).blocked, true);
        },
      );
      await t.test(
        'two service instances claim at most one campaign provider request concurrently',
        async () => {
          let calls = 0;
          const p = makeProvider({ delayMs: 150, costMicros: 1 });
          const original = p.generate;
          p.generate = async (req) => {
            calls++;
            return original(req);
          };
          const e = new NpcAiEngine(database, p, {
            creditPrice: 3,
            providerUpperMicros: 10,
            providerCapMicros: 100,
          });
          const second = new NpcAiEngine(database, p, e.policy);
          const one = await queue(e),
            two = await queue(e, context(), { ...scope, npcId: 'helper' });
          await Promise.all([
            e.run(one.job.id, async () => true),
            second.run(two.job.id, async () => true),
          ]);
          assert.equal(calls, 1);
          assert.equal(
            [await row(one.job.id), await row(two.job.id)].filter(
              (j) => j.status === 'result_received',
            ).length,
            1,
          );
          await e.cancel(one.job.id);
          await e.cancel(two.job.id);
        },
      );
      await t.test(
        'server configuration is default free/mock and external adapter fails closed',
        async () => {
          assert.equal(readNpcAiConfiguration({}).provider.external, false);
          assert.throws(() =>
            readNpcAiConfiguration({ NPC_AI_PROVIDER: 'mock', NPC_AI_EXTERNAL_APPROVED: 'true' }),
          );
          assert.throws(() =>
            readNpcAiConfiguration({
              NPC_AI_PROVIDER: 'http-json',
              NPC_AI_EXTERNAL_APPROVED: 'true',
            }),
          );
          const configured = readNpcAiConfiguration({
            NPC_AI_PROVIDER: 'http-json',
            NPC_AI_ENDPOINT: 'https://trusted.example.test/decision',
            NPC_AI_ALLOWED_ORIGINS: 'https://trusted.example.test',
          });
          assert.equal(configured.provider.external, true);
          assert.equal(configured.policy.externalApproved, false);
        },
      );
      await t.test(
        'cancelled in-flight late answer settles expense without recapture or gameplay',
        async () => {
          const e = engine({ delayMs: 150, costMicros: 4 }),
            { job } = await queue(e);
          const running = e.run(job.id, async () => true);
          await delay(50);
          await e.cancel(job.id);
          await running;
          assert.equal((await row(job.id)).status, 'cancelled');
          assert.equal((await row(job.id)).reservation_status, 'released');
          assert.equal((await budget(e)).spent_micros, '4');
          assert.equal((await budget(e)).unknown_micros, '0');
          await assert.rejects(
            () => database.tx((c) => e.finalize(c, job.id, 'committed')),
            code('STALE_AI_RESULT'),
          );
        },
      );
      await t.test(
        'changed provider policy cannot execute a previously queued context',
        async () => {
          const e = engine(),
            { job } = await queue(e);
          const changed = new NpcAiEngine(database, e.provider, {
            ...e.policy,
            version: 'policy-next',
          });
          await changed.run(job.id, async () => true);
          assert.equal((await row(job.id)).status, 'stale');
          assert.equal((await budget(e)).reserved_micros, '0');
        },
      );
      await t.test(
        'technical reservation expiry releases funds without any online player or game tick',
        async () => {
          const e = engine(),
            { job } = await queue(e);
          await db.query(
            "UPDATE npc_ai_jobs SET reservation_expires_at=now()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          await delay(1300);
          assert.equal((await row(job.id)).status, 'stale');
          assert.equal((await row(job.id)).reservation_status, 'released');
        },
      );
      await t.test(
        'membership revocation followed by regrant never resurrects a queued private-context job',
        async () => {
          const e = engine(),
            { job } = await queue(e);
          await db.query(
            "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, a.user.id],
          );
          await db.query(
            "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, a.user.id],
          );
          await e.sweep(campaignId);
          assert.equal((await row(job.id)).status, 'cancelled');
          await e.run(job.id, async () => true);
          assert.equal((await row(job.id)).proposal, null);
        },
      );
      await t.test(
        'account export omits context; erasure releases holds and retains uncertain service exposure',
        async () => {
          const e = engine(),
            { job } = await queue(e, context({ secret: 'PRIVATE_AI_MEMORY' }));
          await db.query(
            "UPDATE npc_ai_jobs SET status='running',started_at=now(),deadline_at=now()+interval '1 minute' WHERE id=$1",
            [job.id],
          );
          await database.tx(async (c) => {
            const exported = await exportNpcAiData(c, a.user.id);
            assert.ok(exported.some((j) => j.id === job.id));
            assert.ok(!JSON.stringify(exported).includes('PRIVATE_AI_MEMORY'));
            await purgeNpcAiData(c, a.user.id, [{ id: campaignId, source_owned: false }]);
          });
          const erased = await row(job.id);
          assert.deepEqual(erased.context, {});
          assert.equal(erased.requester_user_id, null);
          assert.equal(erased.payer_user_id, null);
          assert.equal(erased.reservation_status, 'released');
          assert.equal((await budget(e)).unknown_micros, '10');
          assert.equal(
            (await db.query('SELECT count(*) FROM npc_ai_cache WHERE campaign_id=$1', [campaignId]))
              .rows[0].count,
            '0',
          );
        },
      );
      await t.test(
        'quote creation has a serialized per-user rate limit and no financial side effect',
        async () => {
          const e = engine();
          for (let i = 0; i < 60; i++) await e.quote(scope, context(), a.user.id);
          await assert.rejects(() => e.quote(scope, context(), a.user.id), code('RATE_LIMITED'));
          assert.equal((await e.wallet(a.user.id)).reserved, 0);
        },
      );
      await t.test(
        'operator metrics require admin and contain only counters, never private prompts',
        async () => {
          await client().request('/admin/npc-ai/metrics', undefined, 'GET', 401);
          const ordinary = await client().register();
          await ordinary.request('/admin/npc-ai/metrics', undefined, 'GET', 403);
          const report = await a.request('/admin/npc-ai/metrics');
          assert.ok(Array.isArray(report.counts));
          assert.ok(Array.isArray(report.budgets));
          for (const key of ['samples', 'average_ms', 'maximum_ms'])
            assert.equal(typeof report.latency[key], 'number');
          for (const key of [
            'sampled_campaigns',
            'living_npcs',
            'hot_observations',
            'queued_causes',
            'accepted_obligations',
            'archived_episodes',
          ])
            assert.equal(typeof report.memory[key], 'number');
          assert.equal(report.statementTimeoutMs, 2000);
          assert.ok(!JSON.stringify(report).includes('PRIVATE_AI_MEMORY'));
          assert.ok(!JSON.stringify(report).includes(a.user.id));
        },
      );
      await t.test(
        'HTTP adapter is disabled without approval and limits, rejects IP/redirect hosts, fake transport verifies ceilings',
        async () => {
          let calls = 0;
          const transport = async (_url, init) => {
            calls++;
            assert.equal(init.redirect, 'error');
            const body = JSON.parse(init.body);
            assert.equal(body.limits.maxCostMicros, 10);
            return new Response(
              JSON.stringify({
                proposal: { actions: [{ kind: 'wait' }] },
                requestId: 'synthetic',
                usage: { inputTokens: 1, outputTokens: 1, costMicros: 2 },
              }),
              { status: 200 },
            );
          };
          const config = {
            enabled: false,
            endpoint: 'https://trusted.example.test/decision',
            allowedOrigins: ['https://trusted.example.test'],
            model: 'configured-test-model',
            version: 'test',
            apiKey: 'synthetic-not-a-secret',
          };
          const req = {
            jobId: randomUUID(),
            purpose: 'plan',
            context: context(),
            signal: new AbortController().signal,
            maxCostMicros: 10,
          };
          await assert.rejects(() => new HttpJsonNpcProvider(config, transport).generate(req));
          assert.equal(calls, 0);
          await assert.rejects(() =>
            new HttpJsonNpcProvider({ ...config, enabled: true }, transport).generate(req),
          );
          assert.equal(calls, 0);
          const response = await new HttpJsonNpcProvider(
            { ...config, enabled: true, enforcesCostCeiling: true },
            transport,
          ).generate(req);
          assert.equal(response.usage.costMicros, 2);
          assert.equal(calls, 1);
          for (const endpoint of [
            'http://trusted.example.test/decision',
            'https://127.0.0.1/',
            'https://[fe80::1]/',
            'https://[::ffff:7f00:1]/',
            'https://localhost/',
          ])
            assert.throws(
              () =>
                new HttpJsonNpcProvider(
                  { ...config, endpoint, allowedOrigins: [new URL(endpoint).origin] },
                  transport,
                ),
            );
          await assert.rejects(() =>
            new HttpJsonNpcProvider(
              { ...config, enabled: true, enforcesCostCeiling: true, maxOutputBytes: 4 },
              transport,
            ).generate(req),
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
      await database.onApplicationShutdown();
    }
  },
);
