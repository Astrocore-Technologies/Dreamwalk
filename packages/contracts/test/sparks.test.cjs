'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SPARK_PACK,
  SPARK_SUBUNITS,
  MAX_SPARK_SUBUNITS,
  parseSparkInteger,
  providerMicrosToSparkSubunits,
  createSparkTariffSnapshot,
  actualSparkCost,
  reserveSparkCost,
  formatSparkSubunits,
} = require('../dist/sparks');

const rates = {
  provider: 'fixture',
  model: 'fixture-model',
  providerRateVersion: 'test-v1',
  inputMicrosPerMillion: '100000',
  cachedInputMicrosPerMillion: '10000',
  outputMicrosPerMillion: '500000',
};
const tariff = createSparkTariffSnapshot(rates);

test('selected pack remains fixed while generation uses two Sparks per provider cent', () => {
  assert.equal(SPARK_PACK.usdCents, '500');
  assert.equal(BigInt(SPARK_PACK.sparkSubunits), 200n * SPARK_SUBUNITS);
  assert.equal(providerMicrosToSparkSubunits('10000'), '20000');
  assert.equal(providerMicrosToSparkSubunits('1'), '2');
  assert.equal(providerMicrosToSparkSubunits('0'), '0');
  assert.ok(Object.isFrozen(SPARK_PACK));
});

test('integer API rejects ambiguous, fractional, signed, unsafe-number and overflow values', () => {
  for (const bad of [
    '',
    '01',
    ' 1',
    '1 ',
    '+1',
    '-1',
    '1.0',
    '1e3',
    1,
    NaN,
    null,
    '9223372036854775808',
    '10000000000000000000',
  ]) {
    assert.throws(() => parseSparkInteger(bad), RangeError);
  }
  assert.equal(parseSparkInteger(MAX_SPARK_SUBUNITS.toString()), MAX_SPARK_SUBUNITS);
});

test('tariff copies and freezes identity, rates, precision, rounding and evidence', () => {
  const mutable = { ...rates };
  const snapshot = createSparkTariffSnapshot(mutable);
  mutable.inputMicrosPerMillion = '999';
  assert.equal(snapshot.inputMicrosPerMillion, '100000');
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => {
    snapshot.model = 'changed';
  }, TypeError);
  assert.equal(snapshot.subunitsPerSpark, '10000');
  assert.equal(snapshot.sparkRateVersion, 'api-cent-2-sparks-v2');
  assert.equal(snapshot.costEvidence, 'reported-tokens-configured-rates');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  for (const bad of ['', ' ', 'x'.repeat(201)])
    assert.throws(() => createSparkTariffSnapshot({ ...rates, model: bad }), RangeError);
  assert.throws(
    () => createSparkTariffSnapshot({ ...rates, outputMicrosPerMillion: '-1' }),
    RangeError,
  );
});

test('actual cost charges uncached and cached input once and output including reasoning once', () => {
  assert.equal(
    actualSparkCost(tariff, {
      inputTokens: '10000',
      cachedInputTokens: '0',
      outputTokens: '1000',
    }),
    '3000',
  );
  assert.equal(
    actualSparkCost(tariff, {
      inputTokens: '10000',
      cachedInputTokens: '8000',
      outputTokens: '1000',
    }),
    '1560',
  );
  assert.equal(
    actualSparkCost(tariff, {
      inputTokens: '10000',
      cachedInputTokens: '10000',
      outputTokens: '0',
    }),
    '200',
  );
  assert.throws(
    () =>
      actualSparkCost(tariff, {
        inputTokens: '1',
        cachedInputTokens: '2',
        outputTokens: '0',
      }),
    RangeError,
  );
});

test('tiny charges ceil provider micros once after aggregation, then apply the rate; zero remains zero', () => {
  assert.equal(
    actualSparkCost(tariff, {
      inputTokens: '1',
      cachedInputTokens: '0',
      outputTokens: '1',
    }),
    '2',
  ); // 2 * ceil(0.1 + 0.5), not 2 * (ceil(0.1) + ceil(0.5))
  assert.equal(
    actualSparkCost(tariff, { inputTokens: '1', cachedInputTokens: '0', outputTokens: '0' }),
    '2',
  ); // 2 * ceil(0.1) = 2, whereas ceil(2 * 0.1) would incorrectly charge 1
  assert.equal(reserveSparkCost(tariff, { inputTokensUpper: '1', outputTokensMax: '0' }), '2');
  assert.equal(
    actualSparkCost(tariff, {
      inputTokens: '0',
      cachedInputTokens: '0',
      outputTokens: '0',
    }),
    '0',
  );
});

test('reservation assumes no discount and accommodates unusual higher cached rates', () => {
  assert.equal(
    reserveSparkCost(tariff, { inputTokensUpper: '10000', outputTokensMax: '1000' }),
    '3000',
  );
  const unusual = createSparkTariffSnapshot({ ...rates, cachedInputMicrosPerMillion: '200000' });
  assert.equal(
    reserveSparkCost(unusual, { inputTokensUpper: '10000', outputTokensMax: '1000' }),
    '5000',
  );
  for (let cached = 0; cached <= 10; cached++) {
    const actual = actualSparkCost(tariff, {
      inputTokens: '10',
      cachedInputTokens: String(cached),
      outputTokens: '7',
    });
    assert.ok(
      BigInt(actual) <=
        BigInt(
          reserveSparkCost(tariff, {
            inputTokensUpper: '10',
            outputTokensMax: '7',
          }),
        ),
    );
  }
});

test('calculations reject unsupported snapshots and storage overflow, not intermediate BigInt multiplication', () => {
  const usage = { inputTokens: '1', cachedInputTokens: '0', outputTokens: '0' };
  for (const patch of [
    { currency: 'EUR' },
    { sparkRateVersion: 'future' },
    { rounding: 'nearest' },
    { subunitsPerSpark: '100' },
    { costEvidence: 'invoice' },
  ])
    assert.throws(() => actualSparkCost({ ...tariff, ...patch }, usage), RangeError);
  const large = createSparkTariffSnapshot({
    ...rates,
    inputMicrosPerMillion: (MAX_SPARK_SUBUNITS / 2n).toString(),
  });
  assert.equal(
    actualSparkCost(large, { ...usage, inputTokens: '1000000' }),
    (MAX_SPARK_SUBUNITS - 1n).toString(),
  );
  assert.throws(() => actualSparkCost(large, { ...usage, inputTokens: '1000001' }), RangeError);
  assert.throws(
    () => reserveSparkCost(large, { inputTokensUpper: '1000001', outputTokensMax: '0' }),
    RangeError,
  );
});

test('proposed localized display preserves tiny nonzero charges and exact details', () => {
  assert.equal(formatSparkSubunits('0'), '0.00');
  assert.equal(formatSparkSubunits('1'), '<0.01');
  assert.equal(formatSparkSubunits('99', 'ru'), '<0,01');
  assert.equal(formatSparkSubunits('100', 'uk'), '0,01');
  assert.equal(formatSparkSubunits('1500'), '0.15');
  assert.equal(formatSparkSubunits('19950'), '2.00');
  assert.equal(formatSparkSubunits('1', 'en', 'exact'), '0.0001');
  assert.equal(formatSparkSubunits('19950', 'ru', 'exact'), '1,9950');
  assert.equal(
    formatSparkSubunits(MAX_SPARK_SUBUNITS.toString(), 'en', 'exact'),
    '922337203685477.5807',
  );
  assert.throws(() => formatSparkSubunits('1', 'xx'), RangeError);
});

test('priced cache writes and reads are disjoint total input categories before the Spark rate', () => {
  const snapshot = createSparkTariffSnapshot({ ...rates, cacheWriteMicrosPerMillion: '125000' });
  assert.equal(
    actualSparkCost(snapshot, {
      inputTokens: '10000',
      cachedInputTokens: '4000',
      cacheWriteInputTokens: '3000',
      outputTokens: '1000',
    }),
    '2430',
  ); // 2 * (300 ordinary micros + 40 reads + 375 writes + 500 output)
  assert.equal(
    actualSparkCost(snapshot, {
      inputTokens: '1000000',
      cachedInputTokens: '0',
      cacheWriteInputTokens: '1000000',
      outputTokens: '0',
    }),
    '250000',
  ); // configured write rate is total, not base plus a second premium
  assert.equal(
    actualSparkCost(snapshot, {
      inputTokens: '1',
      cachedInputTokens: '0',
      cacheWriteInputTokens: '1',
      outputTokens: '1',
    }),
    '2',
  ); // 2 * one aggregate provider-micro ceil for 0.125 + 0.5
});

test('positive writes require immutable pricing and invalid category counts are rejected', () => {
  const usage = {
    inputTokens: '10',
    cachedInputTokens: '4',
    cacheWriteInputTokens: '3',
    outputTokens: '0',
  };
  assert.throws(() => actualSparkCost(tariff, usage), /no immutable price/);
  const priced = createSparkTariffSnapshot({ ...rates, cacheWriteMicrosPerMillion: '125000' });
  assert.throws(
    () => actualSparkCost(priced, { ...usage, cacheWriteInputTokens: '7' }),
    /exceed total input/,
  );
  for (const bad of ['-1', '0.5', '01', null, 1])
    assert.throws(
      () => actualSparkCost(priced, { ...usage, cacheWriteInputTokens: bad }),
      RangeError,
    );
  assert.throws(
    () => createSparkTariffSnapshot({ ...rates, cacheWriteMicrosPerMillion: '-1' }),
    RangeError,
  );
  const noWrites = { ...usage, cacheWriteInputTokens: '0' };
  const omittedWrites = { inputTokens: '10', cachedInputTokens: '4', outputTokens: '0' };
  assert.equal(actualSparkCost(tariff, noWrites), actualSparkCost(tariff, omittedWrites));
  assert.ok(!Object.hasOwn(tariff, 'cacheWriteMicrosPerMillion'));
});

test('write prices are frozen and reservation includes the largest explicitly priced input category', () => {
  const config = { ...rates, cacheWriteMicrosPerMillion: '125000' };
  const snapshot = createSparkTariffSnapshot(config);
  config.cacheWriteMicrosPerMillion = '999999';
  assert.equal(snapshot.cacheWriteMicrosPerMillion, '125000');
  assert.throws(() => {
    snapshot.cacheWriteMicrosPerMillion = '1';
  }, TypeError);
  assert.equal(
    reserveSparkCost(snapshot, { inputTokensUpper: '10000', outputTokensMax: '1000' }),
    '3500',
  );
  const highReads = createSparkTariffSnapshot({
    ...rates,
    cacheWriteMicrosPerMillion: '125000',
    cachedInputMicrosPerMillion: '200000',
  });
  assert.equal(
    reserveSparkCost(highReads, { inputTokensUpper: '10000', outputTokensMax: '1000' }),
    '5000',
  );
});

test('legacy admitted snapshots retain their original one-Spark-per-cent settlement and reservation', () => {
  const legacy = createSparkTariffSnapshot({ ...rates, sparkRateVersion: 'api-cent-1-spark-v1' });
  assert.equal(legacy.sparkRateVersion, 'api-cent-1-spark-v1');
  const usage = { inputTokens: '10000', cachedInputTokens: '8000', outputTokens: '1000' };
  assert.equal(actualSparkCost(legacy, usage), '780');
  assert.equal(
    reserveSparkCost(legacy, { inputTokensUpper: '10000', outputTokensMax: '1000' }),
    '1500',
  );
  assert.equal(
    actualSparkCost(legacy, { inputTokens: '1', cachedInputTokens: '0', outputTokens: '1' }),
    '1',
  );
  assert.equal(providerMicrosToSparkSubunits('10000', 'api-cent-1-spark-v1'), '10000');
  const legacyMax = createSparkTariffSnapshot({
    ...legacy,
    inputMicrosPerMillion: MAX_SPARK_SUBUNITS.toString(),
  });
  assert.equal(
    actualSparkCost(legacyMax, {
      inputTokens: '1000000',
      cachedInputTokens: '0',
      outputTokens: '0',
    }),
    MAX_SPARK_SUBUNITS.toString(),
  );
});

test('provider conversion rejects multiplication overflow and unsupported rate versions', () => {
  const half = MAX_SPARK_SUBUNITS / 2n;
  assert.equal(providerMicrosToSparkSubunits(half.toString()), (half * 2n).toString());
  assert.throws(() => providerMicrosToSparkSubunits((half + 1n).toString()), RangeError);
  assert.throws(() => providerMicrosToSparkSubunits('1', 'future'), RangeError);
  assert.throws(
    () => createSparkTariffSnapshot({ ...rates, sparkRateVersion: 'future' }),
    RangeError,
  );
});
