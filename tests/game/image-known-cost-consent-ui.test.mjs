import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL(`../../apps/web/components/${path}`, import.meta.url), 'utf8');
const callers = [
  ['assets/image-generation.tsx', 'quote'],
  ['visual-authoring/location-image-inline.tsx', 'quote.quote'],
  ['visual-authoring/compact-character-generation.tsx', 'quote'],
  ['visual-authoring/external-generation.tsx', 'quote'],
];
for (const [path, quote] of callers) {
  test(`${path}: new quotes opt in, original acceptance sends only the displayed policy hash`, async () => {
    const source = await read(path);
    assert.match(source, /automaticKnownCostPolicy: 'known-cost-v1'/);
    assert.ok(source.includes(`...(${quote}.automaticKnownCostSettlement`));
    assert.ok(
      source
        .replace(/\s+/g, ' ')
        .includes(
          `automaticKnownCostPolicyHash: ${quote}.automaticKnownCostSettlement.fingerprint`,
        ),
    );
    assert.match(source, /consent: true/);
    assert.match(source, /estimateRiskConsent: true/);
    assert.match(source, /<ImageQuotePrice quote=/);
    assert.doesNotMatch(source, /setAutomaticKnownCost|automaticKnownCostPolicyHash: ['"]/);
    assert.match(source, /uncertain|dispatchUncertain/);
    assert.match(source, /Date.parse\(quote(?:\.quote)?\.expiresAt\)/);
  });
}
test('quoted policy disclosure is localized, explicit about failure and retention, and adds no consent step', async () => {
  const price = await read('assets/image-quote-price.tsx');
  assert.match(price, /quote.automaticKnownCostSettlement &&/);
  assert.match(price, /data-image-known-cost-policy/);
  const copy = await read('assets/image-messages.ts');
  for (const text of [
    'даже если изображение не удалось применить',
    'even if the image cannot be applied',
    'навіть якщо зображення не вдалося застосувати',
    'резерв останется удержан без дополнительного списания',
    'the reserve stays held without an additional charge',
    'резерв залишиться утриманим без додаткового списання',
  ])
    assert.ok(copy.includes(text), text);
  const confirmation = await read('assets/image-confirmation.tsx');
  assert.equal((confirmation.match(/onClick=\{onConfirm\}/g) ?? []).length, 1);
  assert.doesNotMatch(confirmation, /automaticKnownCost|type="checkbox"/);
});
test('policy bindings are immutable server evidence, not a generated client default', async () => {
  const contract = await read('assets/image-cost-policy.ts');
  for (const field of ['quoteId', 'requestHash', 'reserveMicros', 'fingerprint'])
    assert.ok(contract.includes(`${field}: string`));
  assert.match(contract, /automaticRetry: false/);
  assert.match(contract, /unknownOrOverrun: 'retain'/);
  assert.match(await read('assets/image-generation.tsx'), /request.mode === 'external'/);
});
