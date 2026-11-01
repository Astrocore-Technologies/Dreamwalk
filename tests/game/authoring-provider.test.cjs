const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BoundedAuthoringTextProvider,
} = require('../../apps/api/dist/live-test/authoring-provider.js');
const definition = {
  version: 'fixture-v1',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
  instructions: 'Return a bounded private layout.',
  validateProposal: (x) => x,
};
const request = {
  jobId: 'synthetic-job',
  context: { brief: 'Synthetic fixture' },
  signal: new AbortController().signal,
};
test('private adapter pins model/endpoint/caps and retains known usage for invalid JSON', async () => {
  let calls = 0;
  const provider = new BoundedAuthoringTextProvider(
    definition,
    'synthetic-not-a-real-key',
    async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.max_output_tokens, 2048);
      assert.equal(body.reasoning.effort, 'none');
      assert.equal(body.service_tier, 'default');
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      return new Response(
        JSON.stringify({
          id: 'synthetic-receipt',
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 50, output_tokens: 10 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid-json' }] }],
        }),
        { status: 200 },
      );
    },
  );
  const result = await provider.generate(request);
  assert.equal(calls, 1);
  assert.equal(result.failureCode, 'PROVIDER_INVALID_RESULT');
  assert.equal(result.usage.costMicros, 20);
});
test('403 and uncertain HTTP retain only a bounded safe request ID, never retry', async () => {
  let calls = 0;
  const provider = new BoundedAuthoringTextProvider(
    definition,
    'synthetic-not-a-real-key',
    async () => {
      calls++;
      return new Response('body is never inspected', {
        status: 403,
        headers: { 'x-request-id': 'req_synthetic_403' },
      });
    },
  );
  await assert.rejects(
    provider.generate(request),
    (e) =>
      e.code === 'PROVIDER_HTTP_403' && e.uncertain === true && e.requestId === 'req_synthetic_403',
  );
  assert.equal(calls, 1);
  const invalid = new BoundedAuthoringTextProvider(
    definition,
    'synthetic-not-a-real-key',
    async () =>
      new Response('{}', { status: 403, headers: { 'x-request-id': 'spaces are rejected' } }),
  );
  await assert.rejects(invalid.generate(request), (e) => e.requestId === undefined);
});
test('oversized context fails before transport', async () => {
  let calls = 0;
  const provider = new BoundedAuthoringTextProvider(
    definition,
    'synthetic-not-a-real-key',
    async () => {
      calls++;
      throw new Error('must not call');
    },
  );
  await assert.rejects(
    provider.generate({ ...request, context: { text: 'x'.repeat(64001) } }),
    (e) => e.code === 'AUTHORING_CONTEXT_TOO_LARGE' && !e.uncertain,
  );
  assert.equal(calls, 0);
});
