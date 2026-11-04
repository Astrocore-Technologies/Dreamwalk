import {
  TextureBudget,
  textureDimensions,
  ART_TEXTURE_LIMITS,
} from '../../apps/web/components/assets/texture-budget.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  authorizedArt,
  visibleSceneArt,
  canvasSceneArt,
} from '../../apps/web/components/assets/art-visibility.ts';
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
test('scene art admits visible player sprites while excluding portraits, hidden actors/maps and inactive doors', () => {
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
    'entity:player:portrait',
    'entity:hidden-player:sprite',
  ].map(entry);
  assert.deepEqual(
    visibleSceneArt(projection, bindings).map((x) => x.slot),
    [
      'map:courtyard:background',
      'entity:keeper:sprite',
      'entity:door:object:closed',
      'entity:player:sprite',
    ],
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
  assert.match(
    source,
    /canvasSceneArt\(\s*latest.current.projection,\s*latest.current.art,\s*latest.current.illustration/,
  );
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

test('inspection portraits require the current visible NPC and matching authorized immutable binding', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  // Execute the component's actual derived selection, not a duplicate test implementation.
  const selection = source.slice(
    source.indexOf('  const inspectedNpc ='),
    source.indexOf('  const selectedTarget ='),
  );
  assert.match(selection, /artPreviewUrl/);
  assert.match(source, /const art = p \? authorizedArt\(p, sceneMedia.art\) : \[\]/);
  assert.match(source, /portraitUrl=\{inspectedPortraitUrl\}/);
  const inspection = await readFile(
    new URL('../../apps/web/components/game/npc-public-inspection.tsx', import.meta.url),
    'utf8',
  );
  assert.match(inspection, /portraitUrl &&[\s\S]*?src=\{portraitUrl\}/);
  const select = new Function(
    'p',
    'art',
    'inspectedNpcId',
    'artPreviewUrl',
    selection + '\nreturn inspectedPortraitUrl;',
  );
  const portrait = entry('entity:keeper:portrait');
  const p = {
    map: { id: 'room' },
    entities: [{ id: 'keeper', kind: 'npc' }],
    artBindings: [portrait],
  };
  const render = (projection, cached = [portrait], npcId = 'keeper') =>
    select(projection, authorizedArt(projection, cached), npcId, artPreviewUrl);
  assert.equal(render(p), portrait.url);
  assert.equal(render(p, [], 'keeper'), undefined);
  assert.equal(render({ ...p, entities: [] }), undefined);
  assert.equal(render({ ...p, entities: [{ id: 'keeper', kind: 'player' }] }), undefined);
  assert.equal(render(p, [portrait], 'other-npc'), undefined);
  assert.equal(render({ ...p, artBindings: [] }), undefined);
  assert.equal(render({ ...p, artBindings: [{ ...portrait, revisionId: 'other' }] }), undefined);
  assert.equal(render({ ...p, artBindings: [{ ...portrait, sha256: 'b'.repeat(64) }] }), undefined);
  assert.equal(
    render(p, [{ ...portrait, url: 'https://private.invalid/original.png' }]),
    undefined,
  );
});

test('saved illustration restores only the current backdrop without widening the normal art allowlist', () => {
  const hero = { id: 'hero', kind: 'player', mapId: 'room', x: 2, y: 3 };
  const npc = { id: 'npc', kind: 'npc', mapId: 'room', x: 4, y: 5 };
  const projection = {
    map: { id: 'room', backgroundMode: 'schematic', blocked: [{ x: 1, y: 1 }] },
    entities: [hero, npc],
    artBindings: [],
  };
  const before = structuredClone(projection);
  const illustration = { ...entry('map:room:background'), mapId: 'room' };
  const privateSprite = entry('entity:hero:sprite');
  assert.deepEqual(canvasSceneArt(projection, [privateSprite], illustration), [illustration]);
  assert.deepEqual(visibleSceneArt(projection, [illustration, privateSprite]), []);
  assert.deepEqual(
    projection,
    before,
    'Rendering does not change positions, collision or grounding',
  );
  for (const invalid of [
    null,
    { ...illustration, mapId: 'other' },
    { ...illustration, slot: 'map:other:background' },
    { ...illustration, slot: 'entity:hero:sprite' },
    { ...illustration, slot: 'map:room:layer:private' },
    { ...illustration, url: 'https://private.invalid/art' },
  ])
    assert.deepEqual(canvasSceneArt(projection, [privateSprite], invalid), []);
  assert.deepEqual(canvasSceneArt({ ...projection, map: { id: 'room' } }, [], illustration), []);
  assert.deepEqual(
    canvasSceneArt(
      { ...projection, map: { ...projection.map, spatialGrounding: {} } },
      [],
      illustration,
    ),
    [],
  );
  assert.deepEqual(
    canvasSceneArt(
      { ...projection, map: { id: 'other', backgroundMode: 'schematic' } },
      [],
      illustration,
    ),
    [],
  );
  const authorized = { ...illustration, revisionId: 'new-revision' };
  assert.deepEqual(
    canvasSceneArt({ ...projection, artBindings: [authorized] }, [authorized], illustration),
    [authorized],
  );
  assert.deepEqual(canvasSceneArt(projection, [], null), [], 'Withdrawal removes the backdrop');
});

test('all gameplay scenes keep the same interactive canvas with grid and state-driven tokens', async () => {
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  const canvas = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(page, /LocationIllustration/);
  assert.match(page, /<GameCanvas[\s\S]*illustration=\{sceneMedia.illustration\}/);
  assert.match(canvas, /canvasSceneArt\(state.projection, state.art, state.illustration\)/);
  assert.match(canvas, /for \(const entity of p.entities\)/);
  assert.match(canvas, /state.onMove\(interaction.target\)/);
  assert.match(canvas, /state.onSelectNpc\(drawnNpc\)/);
  assert.match(canvas, /boundary, grid, objects/);
  assert.match(canvas, /background.attribution/);
  assert.match(canvas, /aria-label=\{itemText\('actions'\)\}/);
  assert.match(canvas, /aria-haspopup="dialog"/);
  assert.match(
    canvas,
    /projection.entities\s*\.filter\(\(entity\) => entity.id !== projection.actorId\)/,
  );
  assert.match(canvas, /projection.map.exits.map\(\(exit\) => `exit:\$\{exit.id\}`\)/);
});

test('campaign illustration hook clears on map/campaign change and ignores late prior responses', async () => {
  const { transformSync } = await import('esbuild');
  const source = await readFile(
    new URL('../../apps/web/components/assets/use-campaign-art.ts', import.meta.url),
    'utf8',
  );
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  let value, deps, cleanup, effect, resolve;
  const pending = [];
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', code)(
    (name) =>
      ({
        react: {
          useState: (initial) => {
            value ??= initial;
            return [
              value,
              (next) => {
                value = next;
              },
            ];
          },
          useEffect: (fn, next) => {
            if (!deps || next.some((v, i) => v !== deps[i])) {
              cleanup?.();
              deps = next;
              effect = fn;
            }
          },
        },
        '@/lib/client': {
          api: () =>
            new Promise((r) => {
              resolve = r;
              pending.push(r);
            }),
        },
        './types': { artPreviewUrl },
      })[name],
    module,
    module.exports,
    () => 1,
    () => {},
  );
  const render = (campaign, map) => {
    const result = module.exports.useCampaignArt(campaign, map);
    if (effect) {
      const run = effect;
      effect = null;
      cleanup = run();
    }
    return result;
  };
  const illustration = { ...entry('map:room:background'), mapId: 'room' };
  render('first', 'room');
  resolve({ bindings: [], sceneIllustration: illustration });
  await Promise.resolve();
  assert.equal(render('first', 'room').illustration.mapId, 'room');
  assert.equal(render('second', 'room').illustration, null);
  const late = resolve;
  render('second', 'other');
  late({ bindings: [], sceneIllustration: illustration });
  await Promise.resolve();
  assert.equal(render('second', 'other').illustration, null);
  resolve({ bindings: [], sceneIllustration: illustration });
  await Promise.resolve();
  assert.equal(render('second', 'other').illustration, null);
  assert.equal(pending.length, 3);
  cleanup();
});

test('art browsing narrows only authorized results without inventing reuse permissions', async () => {
  const { browseArt, canSelectArt } =
    await import('../../apps/web/components/assets/browse-art.ts');
  const art = (id, title, kind, camera, tags = []) => ({
    id,
    canReuse: true,
    width: 1536,
    height: 1024,
    metadata: { title, kind, camera, tags, variant: 'default' },
  });
  const list = [
    art('one', 'Observatory at dusk', 'background', 'top-down', ['sky']),
    art('two', 'Keeper', 'portrait', 'portrait', ['sky']),
    art('three', 'Open sky', 'background', 'unrestricted', ['day']),
  ];
  const filters = {
    query: '',
    kind: '',
    camera: '',
    tags: [],
    variant: '',
    minWidth: 1,
    minHeight: 1,
  };
  assert.deepEqual(browseArt(list, filters), list);
  assert.deepEqual(
    browseArt(list, { ...filters, query: 'OBSERVATORY sky' }).map((x) => x.id),
    ['one'],
  );
  assert.deepEqual(
    browseArt(list, { ...filters, kind: 'background', camera: 'top-down' }).map((x) => x.id),
    ['one', 'three'],
  );
  assert.deepEqual(
    browseArt(list, { ...filters, tags: ['sky'], variant: 'DEFAULT', minWidth: 1500 }).map(
      (x) => x.id,
    ),
    ['one', 'two'],
  );
  assert.deepEqual(browseArt(list, { ...filters, query: 'not in library' }), []);
  assert.deepEqual(browseArt(list, { ...filters, minHeight: 2048 }), []);
  assert.equal(canSelectArt(list[0], 'background', 'top-down'), true);
  assert.equal(canSelectArt(list[2], 'background', 'top-down'), true);
  assert.equal(canSelectArt(list[1], 'background', 'top-down'), false);
  assert.equal(canSelectArt({ ...list[0], canReuse: false }, 'background', 'top-down'), false);
});

test('art layout preserves immutable registration, rights controls and safe preview routes', async () => {
  const library = await readFile(
    new URL('../../apps/web/components/assets/asset-library.tsx', import.meta.url),
    'utf8',
  );
  const registration = await readFile(
    new URL('../../apps/web/components/assets/register-art.tsx', import.meta.url),
    'utf8',
  );
  const layout = await readFile(
    new URL('../../apps/web/components/assets/library-layout.module.css', import.meta.url),
    'utf8',
  );
  assert.match(library, /data-art-inspector/);
  assert.match(
    library,
    /current\.owned &&\s*\(selected\?\.id === current\.id \? \(\s*<AssetGrants/,
  );
  assert.match(library, /artPreviewUrl\(current\.url\)/);
  assert.match(library, /canSelectArt\(revision, requiredKind, requiredCamera\)/);
  assert.match(library, /generation\.current\+\+/);
  assert.match(registration, /element\?\.showModal\(\)/);
  assert.match(registration, /expectedFamilyRevision: base\.revision/);
  assert.match(registration, /operationId: retry\.current\.operationId/);
  assert.match(registration, /allowAuthorReuse: allowReuse/);
  assert.match(registration, /setAttested\(false\)/);
  assert.match(layout, /\.registrationGrid\s*\{[^}]*grid-template-columns:/);
  assert.match(layout, /max-width: 700px/);
});
