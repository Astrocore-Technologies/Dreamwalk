const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCharacterQuality } = require('./character-quality-fixture.cjs');
test('three contrasting NPCs retain separate voices, knowledge and player agency', () => {
  const report = evaluateCharacterQuality();
  assert.equal(report.externalRequests, 0);
  assert.equal(report.naturalLanguageQuality, 'not_measured');
  assert.equal(report.checks.length, 6);
  assert.ok(report.checks.every((check) => check.result === 'pass'));
});
