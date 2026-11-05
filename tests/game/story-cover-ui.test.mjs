import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('cover uses shared quote/confirmation and owned asset selection outside the story form', async () => {
  const studio = await source('apps/web/components/studio.tsx');
  const dialog = await source('apps/web/components/studio/story-cover-dialog.tsx');
  const coverStart = studio.indexOf('{coverGenerationOpen && (');
  const formEnd = studio.lastIndexOf('</form>', coverStart);
  assert.ok(formEnd >= 0 && coverStart > formEnd, 'cover stays outside the story form');
  assert.doesNotMatch(studio.slice(formEnd + '</form>'.length, coverStart), /<form\b/);
  assert.match(studio, /<MediaPicker/);
  assert.match(studio, /onSelected=\{\(assetId\) => change\('coverAssetId', assetId\)\}/);
  assert.doesNotMatch(dialog, /defaultImageStylePrompt|Default art:/);
  assert.match(dialog, /<ImageGeneration/);
  assert.match(dialog, /externalOnly/);
  assert.match(dialog, /storyCover=\{draft\}/);
  assert.match(dialog, /!revision\.owned/);
  assert.match(dialog, /lock\.current/);
  assert.match(dialog, /active\.current = false;\s*onClose\(\)/);
  assert.match(dialog, /story-covers\/\$\{revision\.id\}\/asset/);
  assert.doesNotMatch(dialog, /\.world|\.rules|\.notes|\.lorebook|method: 'POST'/);
  for (const title of ['Создать обложку с ИИ', 'Generate AI cover', 'Створити обкладинку з ШІ'])
    assert.ok(dialog.includes(title));
});

test('cover jobs recover from server history and keep shared Sparks/idempotency safeguards', async () => {
  const flow = await source('apps/web/components/assets/image-generation.tsx');
  assert.match(flow, /storyCoverContext: \{ draftId: storyCover.draftId \}/);
  assert.match(flow, /allowAuthorReuse: heroPortrait \|\| storyCover \? false : allowReuse/);
  assert.match(flow, /'\/image-generation\/story-covers'/);
  assert.match(flow, /operationId: operation.current.id/);
  assert.match(flow, /<ImageConfirmation/);
  assert.match(flow, /<ImageQuotePrice/);
  assert.match(flow, /width=\{revision.width\}/);
  assert.match(flow, /height=\{revision.height\}/);
  assert.match(flow, /if \(generation === epoch.current\)/);
});
