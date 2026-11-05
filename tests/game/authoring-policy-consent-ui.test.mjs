import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translate } from '../../apps/web/lib/locales.ts';
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const policyKey =
  'Подтверждённый расход спишется автоматически в пределах резерва, даже если подготовка не удалась.';
const legacyKey = 'После подготовки спишется фактическая стоимость, остаток резерва вернётся.';
test('launch discloses automatic authoring settlement only when the quote carries the accepted policy', async () => {
  const source = await read('apps/web/components/game/adventure-launch.tsx');
  assert.match(
    source,
    /quote\.automaticKnownCostPolicy === 'known-cost-v1'\s*\? 'Подтверждённый расход/,
  );
  assert.ok(source.includes(`: '${legacyKey}'`));
  assert.match(source, /automaticKnownCostPolicy: quote\.automaticKnownCostPolicy/);
  assert.match(source, /onClick=\{\(\) => void launch\('confirm'\)\}/);
});
test('story builder keeps legacy notice and adds no second confirmation', async () => {
  const source = await read('apps/web/components/visual-authoring/story-playable-builder.tsx');
  assert.match(source, /quote\.automaticKnownCostPolicy === 'known-cost-v1' \? \(/);
  assert.match(source, /data-authoring-known-cost-policy/);
  assert.match(source, /\) : \(\s*<SparkQuoteNotice quote=\{quote\} \/>/);
  assert.match(source, /automaticKnownCostPolicy: quote\.automaticKnownCostPolicy/);
  assert.equal((source.match(/onClick=\{\(\) => void act\('dispatch'\)\}/g) ?? []).length, 1);
});
test('legacy reserve copy stays unchanged, while new policy explains failure, unknown cost and no retry in all locales', async () => {
  const legacy = {
    ru: legacyKey,
    en: 'The actual cost is captured after preparation; the remaining reserve is released.',
    uk: 'Після підготовки спишеться фактична вартість, решта резерву повернеться.',
  };
  for (const locale of ['ru', 'en', 'uk']) {
    assert.equal(translate(locale, legacyKey), legacy[locale]);
    assert.notEqual(translate(locale, policyKey), policyKey);
  }
  assert.match(translate('ru', policyKey), /без дополнительного списания/);
  assert.match(
    translate('en', policyKey),
    /even if preparation fails.*Unknown costs.*not retry automatically/,
  );
  assert.match(translate('uk', policyKey), /без додаткового списання/);
  const shared = await read('apps/web/components/game/story-messages.ts');
  assert.ok(
    shared.includes(
      'Hold: {amount} Sparks. We charge actual usage and release the remainder after reconciliation.',
    ),
  );
  assert.doesNotMatch(
    shared,
    /Verified usage is charged automatically, even if the result cannot be applied/,
  );
});
