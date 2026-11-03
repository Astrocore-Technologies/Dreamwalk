/** Disposable PG + actual adapter with injected response bytes. No provider/network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../game/support-runtime.mjs';
import { requestEstimateOwnerProfile } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider.js');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const database = {
  query: async (sql, p = []) => (await db.query(sql, p)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const value = await work(c);
      await c.query('COMMIT');
      return value;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  },
};
const cachePricing = {
  cachedInputMicrosPerMillion: 100000,
  cacheWrite30mMicrosPerMillion: 1250000,
  cacheWrite12hMicrosPerMillion: 2500000,
};
async function fixture(details, priced = true, forgedFlag = false) {
  const profile = requestEstimateOwnerProfile();
  if (priced) profile.text.cachePricing = cachePricing;
  const config = readGenerationConfig({
    GENERATION_MODE: 'release',
    GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
  });
  const authority = new GenerationAuthority(database, config);
  let calls = 0;
  const inner = new OpenAiNpcProvider(
    {
      ...config.text,
      enabled: true,
      apiKey: 'synthetic-not-a-real-key',
      version: `cache-fixture-${randomUUID()}`,
      maxModelInputTokens: config.text.contextTokens,
      maxResponseBytes: 128000,
    },
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: `fixture-response-${randomUUID()}`,
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: details },
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify({ text: 'Synthetic cached reply.' }) },
              ],
            },
          ],
        }),
        { headers: { 'x-request-id': 'synthetic-cache-receipt' } },
      );
    },
  );
  if (forgedFlag) {
    const generate = inner.generate.bind(inner);
    inner.generate = async (request) => {
      const result = await generate(request);
      return { ...result, usage: { ...result.usage, costVerifiedForSparks: true } };
    };
  }
  const provider = new ReleaseGenerationProvider(inner, authority);
  const engine = new NpcAiEngine(database, provider, {
    externalApproved: true,
    creditPrice: 0,
    providerUpperMicros: config.text.upperMicros,
    providerCapMicros: config.aggregateCapMicros,
    version: inner.version,
  });
  const id = randomUUID(),
    campaign = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'unusable','Cache fixture',$3)",
    [id, `${id}@example.test`, `cache_${id.replaceAll('-', '').slice(0, 12)}`],
  );
  await db.query(
    'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,500000)',
    [id],
  );
  await db.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic','{}')",
    [campaign, id],
  );
  await db.query(
    "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'hero','accepted')",
    [campaign, id],
  );
  const scope = {
    campaignId: campaign,
    npcId: 'npc',
    origin: 'user',
    requesterUserId: id,
    purpose: 'speech',
  };
  const context = { contextHash: randomUUID() };
  const q = await engine.quote(scope, context, id);
  const input = {
    scope,
    context,
    operationId: randomUUID(),
    requesterUserId: id,
    quoteId: q.id,
    consent: true,
  };
  const job = await engine.queue(input);
  const wallet = async () =>
    (
      await db.query('SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1', [
        id,
      ])
    ).rows[0];
  return { id, engine, input, job, wallet, calls: () => calls };
}
await test(
  'release cached provider usage reaches one exact financial settlement',
  { timeout: 60000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      for (const [label, details, expected] of [
        ['cache read', { cached_tokens: 200, cache_write_tokens: 0 }, 1020],
        ['implicit 30m cache write', { cached_tokens: 200, cache_write_tokens: 400 }, 1120],
        [
          'mixed TTL cache write',
          {
            cached_tokens: 200,
            cache_write_tokens: 400,
            cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 100 },
          },
          1245,
        ],
      ])
        await t.test(label, async () => {
          const f = await fixture(details);
          const held = await f.wallet();
          assert.ok(BigInt(held.held_subunits) >= BigInt(expected * 2));
          assert.equal((await f.engine.queue(f.input)).id, f.job.id);
          await f.engine.run(f.job.id, async () => true);
          await database.tx((c) => f.engine.finalize(c, f.job.id, 'committed'));
          await database.tx((c) => f.engine.finalize(c, f.job.id, 'committed'));
          await f.engine.run(f.job.id, async () => true);
          assert.equal(f.calls(), 1);
          assert.deepEqual(await f.wallet(), {
            balance_subunits: String(500000 - expected * 2),
            held_subunits: '0',
          });
          const r = (
            await db.query(
              'SELECT r.actual_micros,r.spark_quote_id,j.spark_hold_id FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id WHERE j.id=$1',
              [f.job.id],
            )
          ).rows[0];
          assert.equal(r.actual_micros, String(expected));
          assert.equal(r.spark_quote_id, r.spark_hold_id);
          const receipt = (
            await db.query('SELECT provider_usage FROM npc_ai_jobs WHERE id=$1', [f.job.id])
          ).rows[0].provider_usage;
          assert.equal(receipt.inputTokens, 1000);
          assert.equal(receipt.outputTokens, 100);
          assert.equal(receipt.cachedInputTokens, details.cached_tokens);
          assert.equal(receipt.costMicros, expected);
          assert.deepEqual(receipt.cacheWriteInputTokensDetails, {
            ttl30mTokens:
              details.cache_write_tokens_details?.ttl_30m_tokens ?? details.cache_write_tokens ?? 0,
            ttl12hTokens: details.cache_write_tokens_details?.ttl_12h_tokens ?? 0,
          });
          await assert.rejects(
            db.query("UPDATE npc_ai_jobs SET provider_usage='{}' WHERE id=$1", [f.job.id]),
            (e) => e.code === '23514',
          );
          assert.deepEqual(
            (await db.query('SELECT provider_usage FROM npc_ai_jobs WHERE id=$1', [f.job.id]))
              .rows[0].provider_usage,
            receipt,
          );
        });
      for (const [label, details, priced, forgedFlag] of [
        ['unverified old cache tariff', { cached_tokens: 200, cache_write_tokens: 0 }, false],
        ['missing required provider cache counters', { cached_tokens: 200 }, true],
        [
          'forged verified flag without frozen tariffs',
          { cached_tokens: 200, cache_write_tokens: 400 },
          false,
          true,
        ],
        [
          'inconsistent TTL split',
          {
            cached_tokens: 0,
            cache_write_tokens: 400,
            cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 200 },
          },
          true,
        ],
      ])
        await t.test(label + ' retains reserve without retry', async () => {
          const f = await fixture(details, priced, forgedFlag),
            before = await f.wallet();
          await f.engine.run(f.job.id, async () => true);
          await f.engine.run(f.job.id, async () => true);
          assert.equal(f.calls(), 1);
          assert.deepEqual(await f.wallet(), before);
          const h = (
            await db.query(
              'SELECT h.status FROM npc_ai_jobs j JOIN spark_holds h ON h.id=j.spark_hold_id WHERE j.id=$1',
              [f.job.id],
            )
          ).rows[0];
          assert.equal(h.status, 'pending');
        });
    } finally {
      await db.end();
    }
  },
);
