const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTurnCosts } = require('../../apps/api/dist/game/turn-cost-report');

const at = (second) => new Date(Date.UTC(2026, 10, 16, 12, 0, second)).toISOString();
const turn = (key, startedAt, seconds, micros, extra = {}) => ({
  key,
  started: at(startedAt),
  finished: at(startedAt + seconds),
  calls: 3,
  in_tokens: '30000',
  out_tokens: '1500',
  micros: String(micros),
  failed: 0,
  cached: 0,
  ...extra,
});

test('turn cost is the sum of everything one message set off, in cents and seconds', () => {
  const report = summarizeTurnCosts([
    turn('a', 0, 6, 20000), // 2 cents
    turn('b', 100, 10, 40000), // 4 cents
    turn('c', 200, 8, 60000, { failed: 1, cached: 2 }), // 6 cents, one failed call
  ]);
  assert.equal(report.turns, 3);
  assert.equal(report.callsPerTurn, 3);
  assert.equal(report.inputTokensPerTurn, 30000);
  assert.deepEqual(report.apiCentsPerTurn, { average: 4, median: 4, p90: 5.6 });
  assert.deepEqual(report.secondsPerTurn, { median: 8, p90: 9.6 });
  assert.equal(report.failedShare, 0.333);
  // 50 Dreams at 2 units per API cent is 25 cents: six turns at an average of 4 cents.
  assert.deepEqual(report.starterGrant, { dreams: 50, turns: 6 });
  assert.equal(report.recent[2].cachedCalls, 2);
});

test('free or empty periods do not invent a price', () => {
  const free = summarizeTurnCosts([turn('x', 0, 1, 0)]);
  assert.equal(free.paidTurns, 0);
  assert.equal(free.apiCentsPerTurn.average, null);
  assert.equal(free.starterGrant.turns, null);
  const none = summarizeTurnCosts([]);
  assert.equal(none.turns, 0);
  assert.equal(none.failedShare, 0);
  assert.equal(none.secondsPerTurn.median, null);
});
