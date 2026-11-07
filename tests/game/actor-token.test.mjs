import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const load = (path) => {
  const exports = {};
  new Function(
    'exports',
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
  )(exports);
  return exports;
};
const { actorPortraitUrl } = load('../../apps/web/components/game/actor-portrait.ts');
const {
  tokenKind,
  portraitCrop,
  actorTokenKey,
  drawActorToken,
  TOKEN_COLORS,
  TOKEN_TEXTURE_SIDE,
  TOKEN_DISPLAY_SCALE,
} = load('../../apps/web/components/game/actor-token.ts');

/** Records canvas calls so the geometry can be asserted without a browser. */
function recordingContext() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  for (const name of [
    'clearRect',
    'save',
    'restore',
    'beginPath',
    'arc',
    'ellipse',
    'closePath',
    'clip',
    'drawImage',
    'fillRect',
    'fill',
    'stroke',
  ])
    ctx[name] = record(name);
  return { ctx, calls };
}

test('role colours: you, other players and NPCs are distinct', () => {
  const actor = 'me';
  assert.equal(tokenKind({ id: 'me', kind: 'player' }, actor), 'self');
  assert.equal(tokenKind({ id: 'other', kind: 'player' }, actor), 'player');
  assert.equal(tokenKind({ id: 'me', kind: 'npc' }, actor), 'npc');
  assert.equal(new Set(Object.values(TOKEN_COLORS).map((c) => c.ring)).size, 3);
});

test('portrait crop is one square, centred horizontally and biased upward when tall', () => {
  assert.deepEqual(portraitCrop(400, 400), { sx: 0, sy: 0, side: 400 });
  assert.deepEqual(portraitCrop(800, 400), { sx: 200, sy: 0, side: 400 });
  assert.deepEqual(portraitCrop(400, 800), { sx: 0, sy: 100, side: 400 });
  assert.equal(portraitCrop(0, 0).side, 1);
});

test('token cache key changes only with role or pinned portrait revision', () => {
  assert.equal(actorTokenKey('npc'), 'npc|bust');
  assert.equal(actorTokenKey('npc', 'rev-1'), 'npc|rev-1');
  assert.notEqual(actorTokenKey('npc', 'rev-1'), actorTokenKey('npc', 'rev-2'));
  assert.notEqual(actorTokenKey('self', 'rev-1'), actorTokenKey('player', 'rev-1'));
});

test('a portrait is clipped to the circle and cover-cropped; the ring is drawn above it', () => {
  const { ctx, calls } = recordingContext();
  const source = { tag: 'image' };
  drawActorToken(ctx, TOKEN_TEXTURE_SIDE, 'npc', { source, width: 400, height: 800 });
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf('clip') < names.indexOf('drawImage'), 'clipped before drawing');
  assert.ok(names.lastIndexOf('stroke') > names.indexOf('drawImage'), 'ring drawn after art');
  const draw = calls.find((c) => c[0] === 'drawImage');
  assert.equal(draw[1], source);
  assert.deepEqual(draw.slice(2, 6), [0, 100, 400, 400]);
  // The destination square lies inside the ring, centred in the frame.
  const [dx, dy, dw, dh] = draw.slice(6);
  assert.equal(dx, dy);
  assert.equal(dw, dh);
  assert.equal(dx * 2 + dw, TOKEN_TEXTURE_SIDE);
  const clip = calls.find((c) => c[0] === 'arc');
  assert.equal(clip[1], TOKEN_TEXTURE_SIDE / 2);
  assert.equal(clip[2], TOKEN_TEXTURE_SIDE / 2);
});

test('without a portrait a neutral bust is drawn with its head at the circle centre', () => {
  for (const portrait of [undefined, { source: {}, width: 0, height: 100 }]) {
    const { ctx, calls } = recordingContext();
    drawActorToken(ctx, TOKEN_TEXTURE_SIDE, 'self', portrait);
    assert.equal(
      calls.some((c) => c[0] === 'drawImage'),
      false,
    );
    assert.equal(
      calls.some((c) => c[0] === 'ellipse'),
      true,
      'shoulders',
    );
    const head = calls.filter((c) => c[0] === 'arc')[1];
    assert.equal(head[1], TOKEN_TEXTURE_SIDE / 2, 'horizontally centred');
    assert.ok(Math.abs(head[2] - TOKEN_TEXTURE_SIDE / 2) < TOKEN_TEXTURE_SIDE * 0.1, 'near middle');
  }
});

test('display scale enlarges the frame modestly without approaching a neighbouring cell centre', () => {
  assert.ok(TOKEN_DISPLAY_SCALE > 1);
  assert.ok(TOKEN_DISPLAY_SCALE <= 1.5);
});

test('player portraits use only the authorized per-actor endpoint for real player actor ids', () => {
  const actor = 'player-' + '12345678-1234-1234-1234-123456789abc';
  assert.equal(
    actorPortraitUrl('campaign-1', actor),
    '/api/v1/game/campaigns/campaign-1/actors/' + actor + '/portrait',
  );
  assert.equal(actorPortraitUrl(undefined, actor), undefined);
  for (const bad of ['keeper', 'player-../x', 'player-' + 'z'.repeat(36), '../player', ''])
    assert.equal(actorPortraitUrl('campaign-1', bad), undefined);
  // The campaign id is encoded, never interpolated raw into the path.
  assert.ok(!actorPortraitUrl('a/b?c', actor).includes('a/b?c'));
});
