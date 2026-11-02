import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('wallet receipt separates held, pending, released and captured amounts with exact detail', async () => {
  const text = await source('apps/web/components/visual-authoring/sparks-cost.tsx');
  for (const status of ['held', 'pending', 'released', 'settled'])
    assert.ok(text.includes(`'${status}'`));
  assert.match(
    text,
    /status === 'settled'\s*\? receipt.sparkCapturedSubunits\s*: receipt.sparkReservedSubunits/,
  );
  assert.match(text, /formatSparkSubunits\(units, locale, 'exact'\)/);
  assert.match(text, /if \(!receipt.sparkStatus\)/);
  assert.match(text, /Demo units/);
});
test('text and image authoring receipts render actual wallet evidence, not provider equivalents as debits', async () => {
  for (const file of [
    'assets/image-generation.tsx',
    'visual-authoring/location-image-inline.tsx',
    'visual-authoring/external-generation.tsx',
    'visual-authoring/story-playable-builder.tsx',
    'game/unified-story.tsx',
  ]) {
    const text = await source(`apps/web/components/${file}`);
    assert.match(text, /SparkReceiptCost/);
  }
  const text = await source('apps/api/src/game/story-turn-runtime.ts');
  assert.match(text, /LEFT JOIN spark_holds/);
  assert.match(text, /sparkCapturedSubunits/);
});
