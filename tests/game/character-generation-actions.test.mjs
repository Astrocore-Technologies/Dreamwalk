import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL(`../../apps/web/components/visual-authoring/${path}`, import.meta.url), 'utf8');
test('character-only compact surface has a quote-to-generate action and independent free library', async () => {
  const compact = await read('compact-character-generation.tsx');
  assert.match(await read('character-sprite-control.tsx'), /compactActions/);
  assert.match(await read('external-generation.tsx'), /props.compactActions \?/);
  assert.match(compact, /fresh \? g\('generate'\) : imageText\('quote'\)/);
  assert.match(compact, /g\('takeFromLibrary'\)/);
  assert.match(compact, /api<ArtRevision\[\]>\('\/asset-library'\)/);
  assert.match(compact, /revision.owned && revision.canReuse/);
  assert.match(compact, /generation\/reuse/);
  assert.match(compact, /semanticReview: true/);
  assert.doesNotMatch(compact, /ImageConfirmation|RequestReserve|g\('refresh'\)/);
});
test('compact consent remains quote/revision-bound and transport-safe', async () => {
  const compact = await read('compact-character-generation.tsx');
  for (const part of [
    'state?.projectRevision === project.revision',
    'Date.parse(quote.expiresAt) > now',
    "quote.mode === 'external'",
    'ownerImageQuoteMatches',
    'generationRemaining',
    'consent: true',
    'estimateRiskConsent: true',
    'operationId: operations.current.get(key)',
    'uncertain.includes(role)',
    'libraryEpoch.current++',
    'currentIdentity.current === owner',
  ])
    assert.ok(compact.includes(part), part);
  assert.match(compact, /if \(disabled \|\| lock.current\) return/);
  assert.match(compact, /GenerationProgress status=\{job.status\}/);
  assert.match(compact, /\['cancelled', 'expired', 'rejected'\]\.includes\(job.status\)/);
  assert.match(compact, /uncertain.includes\(role\) \|\| !!item\?\.dispatchOperationId/);
});
