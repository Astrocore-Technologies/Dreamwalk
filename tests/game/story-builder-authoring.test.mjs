import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(
  new URL('../../apps/web/components/visual-authoring/story-playable-builder.tsx', import.meta.url),
  'utf8',
);
// Bounded source-contract checks, not browser execution or live AI verification.
test('builder restores durable latest state and ignores obsolete navigation responses', () => {
  assert.match(source, /useEffect\(\(\) =>/);
  assert.match(source, /adventureId \+ '\/latest'/);
  assert.match(source, /token !== epoch.current/);
  assert.match(source, /epoch.current\+\+/);
  assert.match(source, /disabled=\{!loaded\}/);
  assert.match(source, /setLoaded\(true\)/);
});
test('builder flushes author edits, locks repeated actions and preserves uncertain operation identity', () => {
  assert.match(source, /beforePrepare\?: \(\) => Promise<unknown>/);
  assert.match(source, /await beforePrepare\?\.\(\)/);
  assert.ok(
    source.indexOf('await beforePrepare?.()') <
      source.indexOf('const p = (await mutate(path, {}))'),
  );
  assert.match(source, /if \(lock.current\) return/);
  assert.match(source, /if \(!ops.current.has\(key\)\)/);
  assert.match(source, /operationId: ops.current.get\(key\)/);
  assert.match(source, /ops.current.delete\(JSON.stringify\(\{ path, b: \{\} \}\)\)/);
  assert.match(source, /if \(active\(\)\)/);
});
test('new preparations are explicit and unresolved jobs cannot automatically retry', () => {
  assert.match(source, /kind === 'prepare' && \(!loaded \|\| unresolved\)/);
  assert.match(source, /!unresolved &&/);
  assert.match(source, /onClick=\{\(\) => void act\('prepare'\)\}/);
  assert.doesNotMatch(source, /setInterval|setTimeout|act\('dispatch'\);/);
  assert.match(source, /Do not regenerate; refresh its status/);
});
test('quote and review bind to source and build; stale inputs and expired quotes fail closed', () => {
  assert.match(source, /prior\?\.id !== next.id/);
  assert.match(source, /prior\?\.sourceHash !== next.sourceHash/);
  assert.match(source, /setReview\(false\)/);
  assert.match(source, /quote.buildId !== fresh.id/);
  assert.match(source, /quote.sourceHash !== fresh.sourceHash/);
  assert.match(source, /!fresh.sourceCurrent/);
  assert.match(source, /Date.parse\(quote.expiresAt\) <= Date.now\(\)/);
  assert.match(source, /!Number.isSafeInteger\(quote.reserveMicros\)/);
  assert.match(source, /STORY_CONTEXT_STALE/);
});
test('ordinary quote shows distinct Sparks estimate and reserve while retaining explicit consent', () => {
  assert.match(
    source,
    /providerSparkSubunits\(\s*micros,\s*quote\?\.sparks \? \(quote.sparks.rateVersion \?\? null\) : undefined,/,
  );
  assert.match(source, /copyText\('estimated'\)/);
  assert.match(source, /copyText\('reserved'\)/);
  assert.match(source, /consent: true/);
  assert.match(source, /onClick=\{\(\) => void act\('dispatch'\)\}/);
  assert.doesNotMatch(source, /quote.model|currency: 'USD'|\/settings|api.openai|apiKey/);
});
test('application is reviewed and separate from publication, with localized durable statuses', () => {
  assert.match(source, /if \(!review \|\| fresh.status !== 'proposed' \|\| !fresh.draft\) return/);
  assert.match(source, /imageReuseConsent: true/);
  assert.match(source, /onApplied\?\.\(\)/);
  assert.match(source, /statusText\(j.status\)/);
  assert.doesNotMatch(source, /\{j.status\}|\{j.error_code\}|\/submit|\/publish/);
  for (const text of [
    'Она ещё не опубликована',
    'It is not published yet',
    'Її ще не опубліковано',
    'История изменилась',
    'The story changed',
    'Історія змінилася',
  ])
    assert.ok(source.includes(text));
});

test('builder review composition uses only actual draft labels and retains the disabled map', async () => {
  assert.match(source, /story-playable-builder\.module\.css/);
  assert.match(source, /aria-current=\{index === step \? 'step' : undefined\}/);
  assert.match(source, /state\.draft\.maps\.map/);
  assert.match(source, /state\.draft\.npcs\.map/);
  assert.match(source, /state\.draft\.objects\.map/);
  assert.match(source, /item\.labelTranslations\?\.\[locale\] \|\| item\.label/);
  assert.match(source, /<GameCanvas\s+projection=\{projection\}\s+disabled\s+reducedMotion/);
  assert.doesNotMatch(
    source,
    /initialFacts|initialKnowledge|personality|promiseTemplates|<img|backgroundImage/,
  );
  const css = await readFile(
    new URL(
      '../../apps/web/components/visual-authoring/story-playable-builder.module.css',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 2fr\) minmax\(260px, 1fr\)/);
});
