import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  providerBoundKnown,
  samePreparedTurn,
} from '../../apps/web/components/game/narrative-guards.ts';
test('external narrative approval fails closed without a valid explicit provider spending bound', () => {
  assert.equal(providerBoundKnown({}, true), false);
  assert.equal(providerBoundKnown({ external: true, providerUpperMicros: -1 }, true), false);
  assert.equal(providerBoundKnown({ external: true, providerUpperMicros: 1000 }, true), true);
  assert.equal(providerBoundKnown({ external: true, providerUpperMicros: Infinity }, true), false);
  assert.equal(providerBoundKnown({ external: false }, false), true);
});
test('prepared turn binds original input and canon revision, never a silently edited prompt', () => {
  const prepared = { text: 'Investigate', canonRevision: 2 };
  assert.equal(samePreparedTurn(prepared, ' Investigate ', 2), true);
  assert.equal(samePreparedTurn(prepared, 'Rewrite everything', 2), false);
  assert.equal(samePreparedTurn(prepared, 'Investigate', 3), false);
});
test('normal narrative shows committed shared results only and uses explicit consent, not diagnostic controls', async () => {
  const s = await readFile(
    new URL('../../apps/web/components/game/narrative-director.tsx', import.meta.url),
    'utf8',
  );
  assert.match(s, /turn.status === 'committed'/);
  assert.match(s, /committed.map/);
  assert.match(s, /consent: true/);
  assert.match(s, /operationId: sent.operationId/);
  assert.match(s, /actionLock.current/);
  assert.doesNotMatch(s, /dangerouslySetInnerHTML|\/image-generation|sponsorId:/);
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    page.indexOf('<NarrativeDirector') < page.indexOf('<details data-testid="game-advanced">'),
  );
  assert.match(page, /<details data-testid="game-advanced">/);
});

test('scene artwork uses authoritative CAS reuse and separate explicit grounded mock consent', async () => {
  const media = await readFile(
    new URL('../../apps/web/components/game/scene-media.tsx', import.meta.url),
    'utf8',
  );
  assert.match(media, /\/media-preparation/);
  assert.match(media, /\/media-bindings/);
  assert.match(media, /expectedCanonRevision: prepared.canonRevision/);
  assert.match(media, /expectedMapId: prepared.expectedMapId/);
  assert.match(media, /prepared.matches.some/);
  assert.match(media, /operation.current/);
  const generation = await readFile(
    new URL('../../apps/web/components/game/grounded-image.tsx', import.meta.url),
    'utf8',
  );
  assert.match(generation, /prompt: preparation.prompt/);
  assert.match(generation, /groundingHash: preparation.groundingHash/);
  assert.match(generation, /mode: 'mock'/);
  assert.match(generation, /useState\(false\)/);
  assert.match(generation, /!attested/);
  assert.match(generation, /!consent/);
  assert.match(generation, /consent: true/);
  assert.match(generation, /result.quote.upperMicros === 0/);
  assert.match(generation, /job.status === 'admitted'/);
  assert.doesNotMatch(
    generation,
    /\/media-bindings|mode: 'external'|setConsent\(true\)|setAttested\(true\)/,
  );
});

test('narrative composer has a stable accessible name and separately associated audience hint', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/narrative-director.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /aria-label=\{h\('input'\)\}/);
  assert.match(source, /aria-describedby=\{inputHintId\}/);
  assert.match(source, /<small id=\{inputHintId\}>\{h\('shared'\)\}/);
  assert.doesNotMatch(source, /<Field label=\{h\('input'\)\} hint=/);
});

test('art selectors and approval controls have explicit localized accessible names independent of options and values', async () => {
  const media = await readFile(
    new URL('../../apps/web/components/game/scene-media.tsx', import.meta.url),
    'utf8',
  );
  for (const key of ['mediaKind', 'mediaNpc'])
    assert.ok(media.includes(`aria-label={h('${key}')}`));
  const generation = await readFile(
    new URL('../../apps/web/components/game/grounded-image.tsx', import.meta.url),
    'utf8',
  );
  for (const key of ['license', 'attribution'])
    assert.ok(generation.includes(`aria-label={a('${key}')}`));
  for (const key of ['rights', 'consent'])
    assert.ok(generation.includes(`aria-label={g('${key}')}`));
});
