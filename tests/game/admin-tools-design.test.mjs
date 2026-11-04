import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('remaining admin visual scope does not manufacture assets or edit ledger and audit contracts', async () => {
  const source = await read('apps/web/components/admin.tsx');
  const tools = source.slice(source.indexOf('function AdminReports()'));
  for (const page of ['reports', 'models', 'credits', 'audit'])
    assert.ok(tools.includes(`data-admin-tool="${page}"`));
  assert.match(tools, /JSON.stringify\(\{ status, resolution \}\)/);
  assert.match(tools, /JSON.stringify\(\{ userId, amount, reason, idempotencyKey: key \}\)/);
  assert.match(tools, /setResult\(readSparksWallet\(wallet, userId\)\)/);
  assert.match(tools, /formatSparkSubunits\(result.availableSubunits, locale\)/);
  assert.doesNotMatch(tools, /<img|\/wallet\/adjust|\/admin\/audit.*method:/);
  assert.match(tools, /maxInputTokens/);
  assert.match(tools, /maxOutputTokens/);
  assert.match(tools, /timeoutMs/);
  assert.match(tools, /concurrency/);
  assert.match(tools, /<AdminDirector \/>/);
});

test('all mutating tool dialogs block pending close and return focus locally', async () => {
  const source = await read('apps/web/components/admin.tsx');
  const tools = source.slice(source.indexOf('function AdminReports()'));
  assert.equal((tools.match(/onClose=\{dialog.close\}/g) || []).length, 3);
  assert.equal((tools.match(/dialog.pending.current = true/g) || []).length, 3);
  const hook = await read('apps/web/components/studio/admin-tool-dialog.ts');
  assert.match(hook, /if \(!pending.current\) dismiss\(\)/);
  assert.match(hook, /target.isConnected/);
  assert.match(hook, /target.focus\(\{ preventScroll: true \}\)/);
});

test('taxonomy table retains translations, aliases, historical values and revision guard', async () => {
  const source = await read('apps/web/components/studio/admin-taxonomy.tsx');
  assert.match(source, /genreDefinitions: \[\.\.\.historical, \.\.\.genres\]/);
  assert.match(source, /expectedRevision: resource.data\?\.revision/);
  assert.match(source, /\.\.\.tag,/);
  assert.match(source, /entry.labels\[language\]/);
  assert.match(source, /setSelectedGenre\(index\)/);
  assert.match(source, /setSelectedTag\(index\)/);
  const copy = await read('apps/web/components/studio/admin-tool-copy.ts');
  for (const locale of ['ru', 'uk', 'en']) assert.match(copy, new RegExp(`${locale}: \\{`));
});
