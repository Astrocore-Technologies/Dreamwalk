import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL('../../apps/web/components/assets/' + path, import.meta.url), 'utf8');
test('generation UI gates one mock job with fresh quote consent and stable retry identity', async () => {
  const s = await read('image-generation.tsx');
  assert.match(s, /mode: 'mock'/);
  assert.match(s, /result.quote.upperMicros === 0/);
  assert.match(s, /!valid \|\| !quote \|\| !consent/);
  assert.match(s, /fingerprint/);
  assert.match(s, /setConsent\(false\)/);
  assert.match(s, /operation.current.id/);
  assert.match(s, /declineReuse: true/);
  assert.match(s, /revision.owned/);
  assert.match(s, /references.length >= 2/);
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
