import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneClick } from '../../apps/web/components/game/scene-input.ts';
import { mapCoordinateAt } from '../../apps/web/components/game/map-coordinates.ts';
import { canvasSceneArt } from '../../apps/web/components/assets/art-visibility.ts';

const source = (name) =>
  readFileSync(new URL(`../../apps/web/components/${name}`, import.meta.url), 'utf8');
const projection = {
  actorId: 'hero',
  map: { id: 'hall', spatialMode: 'location_only', width: 24, height: 24, blocked: [], exits: [] },
  entities: [{ id: 'hero', kind: 'player', spatialMode: 'location_only', sceneId: 'arrival' }],
};

test('location-only map never interprets a pixel as a movement or targeting cell', () => {
  for (const [x, y] of [
    [0, 0],
    [3, 4],
    [23, 23],
    [NaN, 0],
  ]) {
    assert.equal(sceneClick(projection, x, y), null);
    assert.equal(mapCoordinateAt({ x, y }, projection.map, 48), null);
  }
});

test('location-only scene mounts outside the positioned renderer and retains the whole image', () => {
  const canvas = source('game/game-canvas.tsx');
  assert.match(canvas, /map\.spatialMode === 'location_only'[\s\S]*?<LocationOnlyScene/);
  assert.ok(canvas.indexOf('<LocationOnlyScene') < canvas.indexOf('<PositionedGameCanvas'));
  const scene = source('game/location-only-scene.tsx');
  assert.match(scene, /src=\{imageUrl\}/);
  assert.match(scene, /role="status"/);
  assert.doesNotMatch(
    scene,
    /onMove|onApproach|onStop|mapCoordinate|entityLayout|pixi|movementTrace|map\.width|map\.height/,
  );
  const css = source('game/game.module.css');
  assert.match(css, /\.locationMap img\s*\{[^}]*height: auto;[^}]*object-fit: contain;/);
});

test('participants come only from public projection, separate from the image and preserve NPC/inventory actions', () => {
  const scene = source('game/location-only-scene.tsx');
  assert.match(scene, /participants = projection\.entities\.filter/);
  assert.doesNotMatch(scene, /projection\.map\.scenePresence|participantIds|knownIds/);
  assert.ok(scene.indexOf('</figure>') < scene.indexOf('participants.map'));
  for (const marker of ['onSelectNpc(entity.id)', 'onInspectNpc(entity.id)', '<InventoryPanel'])
    assert.ok(scene.includes(marker));
  assert.match(scene, /disabled=\{disabled \|\| npcUnavailable\(entity\)\}/);
  assert.doesNotMatch(scene, /entity\.label \|\| entity\.id/);
});

test('server-authorized location image is retained without a schematic declaration and rejects other maps', () => {
  const illustration = {
    mapId: 'hall',
    slot: 'map:hall:background',
    url: '/api/assets/example',
    revisionId: 'revision',
    sha256: 'a'.repeat(64),
    width: 1200,
    height: 800,
  };
  const approved = {
    ...illustration,
    url: '/api/v1/asset-library/revisions/123e4567-e89b-42d3-a456-426614174000/file',
  };
  assert.deepEqual(canvasSceneArt(projection, [], approved), [approved]);
  assert.deepEqual(canvasSceneArt(projection, [], { ...approved, mapId: 'elsewhere' }), []);
  assert.deepEqual(
    canvasSceneArt(projection, [], { ...approved, url: 'https://external.invalid/a.png' }),
    [],
  );
});
