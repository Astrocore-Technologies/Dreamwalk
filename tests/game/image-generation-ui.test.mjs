import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL('../../apps/web/components/assets/' + path, import.meta.url), 'utf8');
test('generation UI gates the selected mode with fresh quote consent and stable retry identity', async () => {
  const s = await read('image-generation.tsx');
  assert.match(s, /externalOnly \? 'external' : 'mock'/);
  assert.match(s, /externalDispatchAllowed/);
  assert.match(s, /studioSourceHash === preparedRequest.studioLocationContext.sourceHash/);
  assert.match(s, /readOnly=\{!!preparedRequest\}/);
  assert.match(s, /result.quote\?\.mode === mode/);
  assert.match(s, /config.data\?\.verifiedUpperMicros/);
  assert.match(s, /!config.data\?\.externalEnabled \|\| !authorizationId/);
  assert.match(s, /result.quote.upperMicros === 0/);
  assert.match(s, /!valid\s+\|\|\s+!quoteBudgetAvailable\s+\|\|\s+!quote\s+\|\|\s+!consent/);
  assert.match(s, /quotedFingerprint.current !== fingerprint/);
  assert.match(s, /quote\?\.mode !== mode/);
  assert.match(s, /quote.upperMicros === null/);
  assert.match(s, /estimatePending/);
  assert.match(s, /setConsent\(false\)/);
  assert.match(s, /operation.current.id/);
  assert.match(s, /declineReuse: true/);
  assert.match(s, /revision.owned/);
  assert.match(s, /Math.min\(\s*2,/);
  assert.match(s, /references.length <= referenceLimit/);
  assert.match(s, /references.length >= referenceLimit/);
  assert.doesNotMatch(s, /api.openai|Authorization:|apiKey|process.env/);
});
test('job result cannot silently publish or bind and external unavailable copy has all locales', async () => {
  const s = await read('image-generation.tsx');
  assert.doesNotMatch(s, /\/submit|playable-versions|method: 'PUT'/);
  assert.match(s, /onSelect\(revision\)/);
  assert.match(s, /job.status === 'admitted'/);
  const labels = await read('image-messages.ts');
  for (const marker of [
    'Внешняя генерация недоступна',
    'External generation is unavailable',
    'Зовнішня генерація недоступна',
  ])
    assert.ok(labels.includes(marker));
});
