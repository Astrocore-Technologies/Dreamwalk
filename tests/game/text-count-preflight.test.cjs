const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countRequestBody,
  countOpenAiInput,
  bodyHash,
  evidenceCounter,
  modelContext,
} = require('../../apps/api/dist/ai/text-preflight.js');
const full = JSON.stringify({
  model: 'synthetic',
  instructions: 'FULL_INSTRUCTIONS',
  input: 'FULL_RUSSIAN_ENVELOPE',
  text: { format: { type: 'json_schema', schema: { type: 'object' } } },
  reasoning: { effort: 'none' },
  truncation: 'disabled',
  store: false,
  stream: false,
  max_output_tokens: 2048,
  service_tier: 'default',
});
test('count payload retains the full model input/schema, excluding generation-only fields', () => {
  const b = JSON.parse(countRequestBody(full));
  assert.equal(b.instructions, 'FULL_INSTRUCTIONS');
  assert.deepEqual(b.text, JSON.parse(full).text);
  assert.equal(b.input, 'FULL_RUSSIAN_ENVELOPE');
  assert.equal(b.model, 'synthetic');
  for (const k of ['store', 'stream', 'service_tier', 'max_output_tokens'])
    assert.equal(k in b, false);
});
test('manual count transport uses only the official endpoint with no redirects or retry', async () => {
  let calls = 0;
  const n = await countOpenAiInput(
    full,
    'synthetic-only',
    'synthetic-operation',
    async (url, o) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses/input_tokens');
      assert.equal(o.redirect, 'error');
      assert.equal(o.headers.authorization, 'Bearer synthetic-only');
      return new Response(
        JSON.stringify({ object: 'response.input_tokens', input_tokens: 130000 }),
      );
    },
  );
  assert.equal(n, 130000);
  assert.equal(calls, 1);
});
for (const value of [
  { object: 'wrong', input_tokens: 1 },
  { object: 'response.input_tokens', input_tokens: -1 },
  { object: 'response.input_tokens', input_tokens: 1.5 },
])
  test('invalid count evidence fails closed: ' + JSON.stringify(value), async () => {
    let n = 0;
    await assert.rejects(
      countOpenAiInput(full, 'synthetic', 'operation', async () => {
        n++;
        return new Response(JSON.stringify(value));
      }),
      /TEXT_COUNT_INVALID_RESPONSE/,
    );
    assert.equal(n, 1);
  });
test('403, ambiguous transport and oversized receipts are never retried or exposed', async () => {
  for (const transport of [
    async () => new Response('SENSITIVE_ERROR', { status: 403 }),
    async () => {
      throw Error('SENSITIVE_ERROR');
    },
    async () => new Response('x'.repeat(20000)),
  ]) {
    let n = 0;
    await assert.rejects(
      countOpenAiInput(full, 'synthetic', 'operation', async (...args) => {
        n++;
        return transport(...args);
      }),
      (e) => {
        assert.doesNotMatch(e.message, /SENSITIVE_ERROR/);
        return true;
      },
    );
    assert.equal(n, 1);
  }
});
test('count evidence measures exactly its saved body and model/version; it is not a tokenizer formula', () => {
  const e = {
    id: 'saved-count',
    model: 'synthetic',
    providerVersion: 'provider-v1',
    bodySha256: bodyHash(full),
    inputTokens: 130000,
    policyRevision: 2,
    policyHash: 'a'.repeat(64),
  };
  const counter = evidenceCounter(full, 'synthetic', 'provider-v1', { textCountEvidence: e });
  assert.equal(counter.precision, 'exact');
  assert.equal(counter.countInput(full, 'synthetic'), 130000);
  assert.throws(() => counter.countInput(full + ' ', 'synthetic'), /TEXT_COUNT_EVIDENCE_STALE/);
  assert.throws(
    () => evidenceCounter(full, 'different', 'provider-v1', { textCountEvidence: e }),
    /TEXT_COUNT_EVIDENCE_STALE/,
  );
  assert.throws(
    () => evidenceCounter(full, 'synthetic', 'provider-v2', { textCountEvidence: e }),
    /TEXT_COUNT_EVIDENCE_STALE/,
  );
});
test('private candidate and count metadata are never duplicated into model input', () => {
  assert.deepEqual(
    modelContext({
      canon: 'PINNED',
      textCountEvidence: { id: 'private' },
      textContextCandidate: { history: 'FULL' },
    }),
    { canon: 'PINNED' },
  );
});
