const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
  totalQuotedSparkSubunits,
  commonQuotedSparkRate,
} = require('../../apps/api/dist/generation/sparks-quote-total');
const quote = (reserve, micros = 10000) => ({
  chargeUnit: 'sparks',
  sparkReservedSubunits: reserve,
  providerReserveMicros: micros,
});

test('aggregated quote sums legacy, current and mixed stored Spark reserves independently of USD', () => {
  assert.equal(totalQuotedSparkSubunits([quote('10000'), quote('10000')]), '20000');
  assert.equal(totalQuotedSparkSubunits([quote('20000'), quote('20000')]), '40000');
  assert.equal(totalQuotedSparkSubunits([quote('10000'), quote('20000')]), '30000');
  assert.equal(
    totalQuotedSparkSubunits([quote('9007199254740993'), quote('1')]),
    '9007199254740994',
  );
});

test('aggregation rejects missing, invalid or overflowing stored Spark prices', () => {
  for (const quotes of [
    [],
    [quote(null)],
    [quote(undefined)],
    [quote('-1')],
    [quote('01')],
    [quote('9223372036854775807'), quote('1')],
    [{ ...quote('1'), chargeUnit: 'credits' }],
  ]) {
    assert.throws(() => totalQuotedSparkSubunits(quotes), /SPARK_PRICE_UNVERIFIED/);
  }
});

test('story replies and world batches both use persisted Spark quote aggregation', () => {
  for (const file of ['story-turn-runtime.ts', 'world-generation-batch.ts']) {
    const source = readFileSync(`apps/api/src/game/${file}`, 'utf8');
    assert.match(source, /sparkReservedSubunits: totalQuotedSparkSubunits\(/);
    assert.doesNotMatch(source, /sparkReservedSubunits: String\(reserve\)/);
  }
});

test('only homogeneous versioned child quotes expose a common rate', () => {
  const legacy = { ...quote('10000'), sparkRateVersion: 'api-cent-1-spark-v1' };
  const current = { ...quote('20000'), sparkRateVersion: 'api-cent-2-sparks-v2' };
  assert.deepEqual(commonQuotedSparkRate([legacy, legacy]), {
    sparkRateVersion: legacy.sparkRateVersion,
  });
  assert.deepEqual(commonQuotedSparkRate([current, current]), {
    sparkRateVersion: current.sparkRateVersion,
  });
  assert.deepEqual(commonQuotedSparkRate([legacy, current]), {});
  assert.deepEqual(commonQuotedSparkRate([legacy, quote('10000')]), {});
  assert.deepEqual(commonQuotedSparkRate([]), {});
});

test('absent funding is omitted so immediate and persisted quote/hold DTOs replay identically', async () => {
  const {
    optionalFunding,
    aggregateFunding,
    heldFunding,
  } = require('../../apps/api/dist/generation/currency-funding');
  const { sparkQuoteView, sparkHoldView } = require('../../apps/api/dist/generation/sparks-hooks');
  const legacy = {
    reserve_subunits: '100',
    reserved_subunits: '100',
    captured_subunits: null,
    status: 'held',
    price_snapshot: { tariff: { sparkRateVersion: 'api-cent-2-sparks-v2' } },
  };
  const c = { query: async () => ({ rows: [legacy] }) };
  for (const result of [
    optionalFunding(undefined),
    optionalFunding(aggregateFunding([quote('100')])),
    await sparkQuoteView(c, 'legacy-quote'),
    await sparkHoldView(c, 'legacy-quote'),
  ]) {
    assert.equal(Object.hasOwn(result, 'funding'), false);
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  }
  const funding = heldFunding({
    reserved_subunits: '100',
    sparks_reserved_subunits: '25',
    captured_subunits: '80',
  });
  const result = optionalFunding(funding);
  assert.strictEqual(result.funding, funding);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});
