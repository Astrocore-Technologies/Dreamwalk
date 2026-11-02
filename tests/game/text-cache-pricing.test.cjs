const test = require('node:test');
const assert = require('node:assert/strict');
const {
  textUsageCostMicros,
  textInputReserveRate,
} = require('../../apps/api/dist/generation/text-pricing.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const cachePricing = {
  cachedInputMicrosPerMillion: 10000,
  cacheWrite30mMicrosPerMillion: 125000,
  cacheWrite12hMicrosPerMillion: 250000,
};
const rates = { inputMicrosPerMillion: 100000, outputMicrosPerMillion: 500000, cachePricing };
test('reviewed cache categories sum once, write rate is total rather than surcharge', () => {
  assert.deepEqual(
    textUsageCostMicros(rates, {
      inputTokens: 1000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 400,
      cacheWriteInputTokensDetails: { ttl30mTokens: 300, ttl12hTokens: 100 },
      outputTokens: 100,
    }),
    { costMicros: 155, costVerifiedForSparks: true },
  );
  assert.deepEqual(
    textUsageCostMicros(rates, { inputTokens: 1000, cacheWriteInputTokens: 1000, outputTokens: 0 }),
    { costMicros: 125, costVerifiedForSparks: true },
  );
  assert.equal(
    textUsageCostMicros(rates, { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 })
      .costMicros,
    1,
  );
});
test('unpriced legacy cache stays unverified without changing old no-cache arithmetic', () => {
  const legacy = { inputMicrosPerMillion: 100000, outputMicrosPerMillion: 500000 };
  assert.deepEqual(textUsageCostMicros(legacy, { inputTokens: 1000, outputTokens: 100 }), {
    costMicros: 150,
    costVerifiedForSparks: true,
  });
  assert.deepEqual(
    textUsageCostMicros(legacy, { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 100 }),
    { costMicros: 150, costVerifiedForSparks: false },
  );
  assert.equal(
    textUsageCostMicros(legacy, {
      inputTokens: 1000,
      cacheWriteInputTokens: 1000,
      outputTokens: 100,
    }).costVerifiedForSparks,
    false,
  );
});
test('invalid cache usage never becomes a verified cost', () => {
  for (const usage of [
    { inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 6, outputTokens: 0 },
    {
      inputTokens: 10,
      cacheWriteInputTokens: 5,
      cacheWriteInputTokensDetails: { ttl30mTokens: 2, ttl12hTokens: 2 },
      outputTokens: 0,
    },
    { inputTokens: 10, cachedInputTokens: -1, outputTokens: 0 },
    { inputTokens: 10, outputTokens: NaN },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
  ])
    assert.throws(() => textUsageCostMicros(rates, usage));
});
test('reserve covers worst reviewed input class and snapshot binds every cache rate', () => {
  assert.equal(textInputReserveRate(rates), 250000);
  const profile = {
    ...rates,
    model: 'synthetic',
    contextTokens: 20000,
    maxInputBytes: 20000,
    maxOutputTokens: 100,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 4096,
      marginBps: 0,
      fixedMarginMicros: 0,
    },
  };
  const snapshot = estimateTextRequest('x'.repeat(1000), profile, 'synthetic');
  assert.equal(snapshot.inputMicros, 1274);
  assert.equal(snapshot.reserveMicros, 1324);
  assert.deepEqual(snapshot.cachePricing, cachePricing);
  for (const key of Object.keys(cachePricing)) {
    const edited = { ...profile, cachePricing: { ...cachePricing, [key]: cachePricing[key] + 1 } };
    assert.notEqual(
      estimateTextRequest('x'.repeat(1000), edited, 'synthetic').fingerprint,
      snapshot.fingerprint,
    );
  }
  profile.cachePricing.cachedInputMicrosPerMillion = 999;
  assert.equal(snapshot.cachePricing.cachedInputMicrosPerMillion, 10000);
});
