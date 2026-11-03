import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { providerSparkSubunits } from '../../apps/web/components/visual-authoring/spark-equivalent.ts';

test('provider equivalents respect bound legacy/new versions and reject missing bound tariffs', () => {
  assert.equal(providerSparkSubunits(12500), '25000');
  assert.equal(providerSparkSubunits(12500, 'api-cent-2-sparks-v2'), '25000');
  assert.equal(providerSparkSubunits(12500, 'api-cent-1-spark-v1'), '12500');
  assert.equal(providerSparkSubunits(12500, null), null);
  assert.equal(providerSparkSubunits(12500, 'future'), null);
  for (const value of [null, undefined, -1, 1.5, Infinity, NaN])
    assert.equal(providerSparkSubunits(value), null);
});

test('launch, builder and image quote estimates pass stored tariff while wallet fields stay unscaled', async () => {
  for (const file of ['game/adventure-launch.tsx', 'visual-authoring/story-playable-builder.tsx']) {
    const source = await readFile(`apps/web/components/${file}`, 'utf8');
    assert.match(source, /sparks\.rateVersion \?\? null/);
  }
  for (const file of [
    'assets/image-generation.tsx',
    'visual-authoring/location-image-inline.tsx',
    'visual-authoring/external-generation.tsx',
  ]) {
    assert.match(await readFile(`apps/web/components/${file}`, 'utf8'), /<ImageQuotePrice/);
  }
  const image = await readFile('apps/web/components/assets/image-quote-price.tsx', 'utf8');
  assert.match(
    image,
    /quote.funding\?\.totalReservedSubunits \?\?\s*quote.sparks\?\.reserveSubunits/,
  );
  assert.match(image, /formatSparkSubunits\(total, locale, 'exact'\)/);
  const source = await readFile('apps/web/components/visual-authoring/sparks-cost.tsx', 'utf8');
  assert.match(source, /formatSparkSubunits\(reserved, locale\)/);
  assert.match(source, /formatSparkSubunits\(units, locale\)/);
});

test('charged job history shows immutable wallet receipt instead of repricing provider micros', async () => {
  for (const file of ['visual-authoring/external-generation.tsx', 'assets/image-generation.tsx']) {
    const source = await readFile(`apps/web/components/${file}`, 'utf8');
    assert.match(source, /!job\.sparkStatus &&/);
    assert.match(source, /SparkReceiptCost/);
  }
  const builder = await readFile(
    'apps/web/components/visual-authoring/story-playable-builder.tsx',
    'utf8',
  );
  assert.match(builder, /!j\.sparkStatus && j\.actual_micros/);
  const inline = await readFile(
    'apps/web/components/visual-authoring/location-image-inline.tsx',
    'utf8',
  );
  assert.match(inline, /j\.sparkStatus \? \(/);
  assert.match(inline, /SparkReceiptCost receipt=\{\{ \.\.\.j, generationCost: null \}\}/);
});
