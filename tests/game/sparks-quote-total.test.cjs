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
