import {
  TextureBudget,
  textureDimensions,
  ART_TEXTURE_LIMITS,
} from '../../apps/web/components/assets/texture-budget.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { authorizedArt, visibleSceneArt } from '../../apps/web/components/assets/art-visibility.ts';
import { artCameraMatches, artPreviewUrl } from '../../apps/web/components/assets/types.ts';
const id = '12345678-1234-1234-1234-123456789abc';
const entry = (slot) => ({
  slot,
  revisionId: id,
  sha256: 'a'.repeat(64),
  mime: 'image/webp',
  width: 64,
  height: 64,
  url: `/api/v1/asset-library/revisions/${id}/file?campaignId=${id}`,
});
test('only authenticated same-origin immutable revision routes become image sources', () => {
  assert.equal(artPreviewUrl(entry('x').url), entry('x').url);
  for (const unsafe of [
    'https://attacker.test/file',
    '//attacker.test/file',
    '/api/v1/assets/private-original',
    'data:image/svg+xml,test',
    entry('x').url + '&originalUrl=secret',
  ])
    assert.equal(artPreviewUrl(unsafe), undefined);
});
test('scene art excludes hidden maps, NPC portraits, players and inactive door variants', () => {
  const projection = {
    map: { id: 'courtyard' },
    entities: [
      { id: 'keeper', kind: 'npc' },
      { id: 'door', kind: 'door', open: false },
      { id: 'player', kind: 'player' },
    ],
  };
  const bindings = [
    'map:courtyard:background',
    'map:archive:background',
    'entity:keeper:sprite',
    'entity:keeper:portrait',
    'entity:hidden:sprite',
    'entity:door:object:closed',
    'entity:door:object:open',
    'entity:player:sprite',
  ].map(entry);
  assert.deepEqual(
    visibleSceneArt(projection, bindings).map((x) => x.slot),
    ['map:courtyard:background', 'entity:keeper:sprite', 'entity:door:object:closed'],
  );
  assert.deepEqual(
    visibleSceneArt({ map: { id: 'archive' }, entities: [] }, bindings).map((x) => x.slot),
    ['map:archive:background'],
  );
  assert.deepEqual(visibleSceneArt(projection, []), []);
});
test('late image responses are checked against current audience and abort generation before texture insertion', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /controller\.signal\.aborted/);
  assert.match(source, /artRequests\.get\(entry\.url\) !== controller/);
  assert.match(source, /visibleSceneArt\(latest.current.projection, latest.current.art\)/);
  assert.match(source, /texture.destroy\(true\)/);
  assert.match(source, /cache: 'no-store'/);
});
test('binding autosave uses independent CAS, retries stable operation and leaves publication explicit', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/assets/story-art-bindings.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useDraftAutosave/);
  assert.match(source, /expectedRevision: revision/);
  assert.match(source, /operation.current.id/);
  assert.match(source, /beforePersist/);
  assert.match(source, /beforeunload/);
  assert.doesNotMatch(source, /\/submit|playable-versions/);
  const manifest = await readFile(
    new URL('../../apps/web/components/assets/use-campaign-art.ts', import.meta.url),
    'utf8',
  );
  assert.match(manifest, /\/campaigns\/\$\{campaignId\}\/manifest/);
  assert.doesNotMatch(manifest, /\/versions\//);
});

test('explicit projection withdrawal beats cached metadata and default door art is not doubled', () => {
  const closed = entry('entity:door:object:closed'),
    fallback = entry('entity:door:object:default');
  const p = { map: { id: 'courtyard' }, entities: [{ id: 'door', kind: 'door', open: false }] };
  assert.deepEqual(visibleSceneArt(p, [fallback, closed]), [closed]);
  assert.deepEqual(visibleSceneArt({ ...p, artBindings: [] }, [fallback, closed]), []);
  assert.deepEqual(authorizedArt({ ...p, artBindings: [] }, [entry('entity:keeper:portrait')]), []);
  assert.deepEqual(visibleSceneArt({ ...p, artBindings: [closed] }, [fallback, closed]), [closed]);
});

test('display dimensions preserve aspect without upscaling or changing originals', () => {
  assert.deepEqual(textureDimensions('map:room:background', 4096, 2048), {
    width: 2048,
    height: 1024,
  });
  assert.deepEqual(textureDimensions('entity:npc:sprite', 4096, 2048), { width: 512, height: 256 });
  assert.deepEqual(textureDimensions('entity:item:object:default', 32, 64), {
    width: 32,
    height: 64,
  });
  assert.equal(textureDimensions('map:room:background', 5000, 1), null);
  assert.equal(textureDimensions('map:room:background', Infinity, 1), null);
});
test('four decodes at most and aborted work retains its reservation until settled', () => {
  const budget = new TextureBudget();
  for (let i = 0; i < 4; i++) assert.equal(budget.admit(String(i), 512, 512), true);
  assert.equal(budget.admit('fifth', 512, 512), false);
  budget.release('0');
  assert.equal(budget.pending, 4);
  budget.complete('0', false);
  assert.equal(budget.admit('fifth', 512, 512), true);
  budget.close();
  assert.equal(budget.admit('after-close', 1, 1), false);
  for (const key of ['1', '2', '3', 'fifth']) budget.complete(key, true);
  assert.equal(budget.pixels, 0);
  assert.equal(budget.pending, 0);
});
test('aggregate retained and pending pixels are bounded with placeholder admission failure', () => {
  const budget = new TextureBudget();
  assert.equal(budget.admit('background', 2048, 2048), true);
  budget.complete('background', true);
  let accepted = 0;
  for (let i = 0; i < 128; i++) {
    const key = String(i);
    if (budget.admit(key, 512, 512)) {
      accepted++;
      budget.complete(key, true);
    }
  }
  assert.equal(accepted, 16);
  assert.equal(budget.pixels, ART_TEXTURE_LIMITS.pixels);
  assert.equal(budget.admit('negative', -2, -2), false);
  budget.release('background');
  assert.equal(budget.admit('new-map', 2048, 2048), true);
  budget.complete('new-map', false);
  for (let i = 0; i < 16; i++) budget.release(String(i));
  assert.equal(budget.pixels, 0);
});
test('decoder closes temporary bitmaps and renderer destroys bounded canvas sources', async () => {
  const decoder = await readFile(
    new URL('../../apps/web/components/assets/decode-art.ts', import.meta.url),
    'utf8',
  );
  assert.match(decoder, /resizeWidth: width/);
  assert.match(decoder, /bitmap.close/);
  assert.match(decoder, /URL.revokeObjectURL/);
  const renderer = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(renderer, /textureBudget.admit/);
  assert.match(renderer, /textureBudget.complete/);
  assert.match(renderer, /surface.width = 0/);
  assert.match(renderer, /textureBudget.close/);
});

test('specific slots accept exact and unrestricted camera art, not conflicting viewpoints', () => {
  assert.equal(artCameraMatches('top-down', 'top-down'), true);
  assert.equal(artCameraMatches('top-down', 'unrestricted'), true);
  assert.equal(artCameraMatches('portrait', 'unrestricted'), true);
  assert.equal(artCameraMatches('portrait', 'top-down'), false);
  assert.equal(artCameraMatches('top-down', 'isometric'), false);
  assert.equal(artCameraMatches(undefined, 'isometric'), true);
  assert.equal(artCameraMatches('unrestricted', 'side'), true);
});
