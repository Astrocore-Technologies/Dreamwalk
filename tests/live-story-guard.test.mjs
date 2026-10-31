import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStoryGuard, LIMITS } from '../scripts/live-story/guard.mjs';
const legacyFileTest = process.platform === 'win32' ? test.skip : test;
const request = (id = 'job-1') => ({
  method: 'POST',
  redirect: 'error',
  headers: { 'X-Client-Request-Id': id },
  body: JSON.stringify({
    model: LIMITS.model,
    service_tier: 'default',
    store: false,
    stream: false,
    max_output_tokens: LIMITS.maxOutputTokens,
    input: JSON.stringify({ purpose: 'speech', context: { contextHash: 'synthetic' } }),
  }),
});
const receipt = (tier = 'default', usage = { input_tokens: 20, output_tokens: 10 }) =>
  new Response(JSON.stringify({ id: 'receipt-synthetic', service_tier: tier, usage }), {
    headers: { 'x-request-id': 'http-receipt-synthetic' },
  });
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'live-guard-'));
  try {
    await fn(join(dir, 'ledger.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('default evaluation plan never reads a key or dispatches', () => {
  const p = spawnSync(process.execPath, ['scripts/evaluate-live-story.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, NPC_AI_API_KEY: 'DO_NOT_READ_OR_PRINT_THIS', LIVE_STORY_APPROVED: '' },
  });
  assert.equal(p.status, 0);
  const plan = JSON.parse(p.stdout);
  assert.equal(plan.carriedMicros, 10769);
  assert.equal(plan.remainingMicros, 989231);
  assert.ok(!p.stdout.includes('DO_NOT_READ'));
  assert.equal(p.stderr, '');
});
legacyFileTest(
  'reserve is durable before transport, receipts scoped and repeated job denied after reopening',
  async () =>
    fixture(async (path) => {
      let calls = 0;
      let g = await createStoryGuard(path, async () => {
        calls++;
        const l = JSON.parse(await readFile(path));
        assert.equal(l.attempts[0].state, 'reserved');
        return receipt();
      });
      await g.fetch('https://api.openai.com/v1/responses', request());
      assert.equal(g.snapshot().attempts[0].state, 'known');
      assert.equal(g.snapshot().attempts[0].requestId, 'receipt-synthetic');
      assert.equal(g.snapshot().attempts[0].httpRequestId, 'http-receipt-synthetic');
      assert.equal(g.snapshot().attempts[0].responseId, 'receipt-synthetic');
      await g.close();
      g = await createStoryGuard(path, async () => {
        calls++;
        return receipt();
      });
      await assert.rejects(
        g.fetch('https://api.openai.com/v1/responses', request()),
        /DUPLICATE_DISPATCH/,
      );
      assert.equal(calls, 1);
      await g.close();
    }),
);
legacyFileTest(
  'oversized body, wrong model, tools and nonapproved routes refuse before dispatch',
  async () =>
    fixture(async (path) => {
      let calls = 0;
      const g = await createStoryGuard(path, async () => {
        calls++;
        return receipt();
      });
      for (const change of [
        { model: 'other' },
        { tools: [{}] },
        { service_tier: 'auto' },
        { input: 'x'.repeat(65000) },
      ]) {
        const r = request();
        r.body = JSON.stringify({ ...JSON.parse(r.body), ...change });
        await assert.rejects(g.fetch('https://api.openai.com/v1/responses', r));
      }
      await assert.rejects(g.fetch('https://other.invalid', request()));
      assert.equal(calls, 0);
      assert.equal(g.snapshot().attempts.length, 0);
      await g.close();
    }),
);
legacyFileTest(
  'missing tier/usage or ambiguous transport retains upper exposure and blocks every retry',
  async () => {
    for (const transport of [
      async () => receipt('priority'),
      async () => receipt(undefined, {}),
      async () => {
        throw Error('synthetic network failure');
      },
    ])
      await fixture(async (path) => {
        const g = await createStoryGuard(path, transport);
        await assert.rejects(
          g.fetch('https://api.openai.com/v1/responses', request()),
          /LIVE_OUTCOME_UNKNOWN_STOP/,
        );
        const item = g.snapshot().attempts[0];
        assert.equal(item.state, 'unknown');
        assert.equal(item.upperMicros, 50000);
        await assert.rejects(
          g.fetch('https://api.openai.com/v1/responses', request('new-job')),
          /UNRECONCILED_EXPOSURE/,
        );
        await g.close();
      });
  },
);
legacyFileTest(
  'four dispatch total cap survives new process guard and existing lock prevents concurrency',
  async () =>
    fixture(async (path) => {
      let calls = 0;
      const g = await createStoryGuard(path, async () => {
        calls++;
        return receipt();
      });
      await assert.rejects(
        createStoryGuard(path, async () => receipt()),
        { code: 'EEXIST' },
      );
      for (let i = 0; i < 4; i++)
        await g.fetch('https://api.openai.com/v1/responses', request(`job-${i}`));
      await assert.rejects(
        g.fetch('https://api.openai.com/v1/responses', request('fifth')),
        /LIVE_BUDGET_EXHAUSTED/,
      );
      assert.equal(calls, 4);
      assert.equal(g.snapshot().limits.carriedMicros, 10769);
      await g.close();
    }),
);

test('fresh key leaves outer bootstrap environment; rehearsal strips without reading', async () => {
  const { consumeFreshKey, stripBootstrapSecrets } =
    await import('../scripts/live-story/key-entry.mjs');
  const env = {
    NPC_AI_API_KEY: 'synthetic-fresh',
    OPENAI_API_KEY: 'synthetic-unused',
    PATH: 'safe',
  };
  assert.equal(consumeFreshKey(env), 'synthetic-fresh');
  assert.deepEqual(env, { PATH: 'safe' });
  let reads = 0;
  const inherited = new Proxy(
    { NPC_AI_API_KEY: 'synthetic', OPENAI_API_KEY: 'unused' },
    {
      get(target, key) {
        reads++;
        return target[key];
      },
    },
  );
  stripBootstrapSecrets(inherited);
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(inherited), []);
});

test('both API launches use file URLs for the ESM preload, including Windows paths', async () => {
  const source = await readFile('scripts/evaluate-live-story.mjs', 'utf8');
  assert.equal(
    (
      source.match(/pathToFileURL\(resolve\(root, 'scripts\/live-story\/preload.mjs'\)\)\.href/g) ??
      []
    ).length,
    2,
  );
  const { pathToFileURL } = await import('node:url');
  assert.equal(
    pathToFileURL('D:\\Dreamwalk folder\\scripts\\preload.mjs', { windows: true }).href,
    'file:///D:/Dreamwalk%20folder/scripts/preload.mjs',
  );
});
