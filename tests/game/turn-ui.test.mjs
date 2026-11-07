import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  committedPathSample,
  playerControlsAvailable,
  projectionTurnFence,
  spriteFeedback,
} from '../../apps/web/components/game/turn-ui.ts';

test('player controls follow the authoritative phase while legacy projections remain compatible', () => {
  assert.equal(playerControlsAvailable({}), true);
  const turn = {
    roundId: 'round-a',
    phaseEpoch: 3,
    phase: 'player',
    ownTurn: true,
    pendingResolution: false,
  };
  assert.equal(playerControlsAvailable({ turn }), true);
  for (const change of [
    { ownTurn: false },
    { phase: 'world' },
    { phase: 'reaction' },
    { pendingResolution: true },
  ])
    assert.equal(playerControlsAvailable({ turn: { ...turn, ...change } }), false);
  assert.deepEqual(projectionTurnFence({ turn }), {
    roundId: 'round-a',
    phaseEpoch: 3,
    rulesetVersion: 1,
  });
  assert.equal(projectionTurnFence({}), undefined);
});

test('committed movement animation follows bends instead of cutting through furniture', () => {
  const path = [
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ];
  assert.deepEqual(committedPathSample(path, 65), { x: 1, y: 1.5, moving: true, direction: 0 });
  assert.deepEqual(committedPathSample(path, 195), { x: 1.5, y: 2, moving: true, direction: 2 });
  assert.deepEqual(committedPathSample(path, 10000), { x: 3, y: 2, moving: false, direction: 0 });
  assert.equal(committedPathSample([], 0), null);
  assert.equal(committedPathSample(path, -100).x, 1);
  assert.deepEqual(path, [
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ]);
});

test('procedural recoil is temporary and never leaves a persistent sprite displacement', () => {
  for (const kind of ['hit', 'push']) {
    const first = spriteFeedback(kind, 0, 1, 0),
      last = spriteFeedback(kind, 2000, 1, 0);
    for (const part of [first, last])
      for (const value of Object.values(part)) assert.ok(Math.abs(value) < 1e-9);
    const middle = spriteFeedback(kind, 130, 1, -1);
    assert.ok(Object.values(middle).some((value) => Math.abs(value) > 0.01));
    assert.ok(
      Math.abs(middle.x) <= 10 && Math.abs(middle.y) <= 10 && Math.abs(middle.rotation) < 0.1,
    );
  }
});

test('turn UI messages supply complete Russian, English and Ukrainian copy', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/turn-messages.ts', import.meta.url),
    'utf8',
  );
  const { transpile } = await import('typescript');
  const js = transpile(source.replace("'use client';", '').replace(/import.*useT.*;\n/, ''));
  const module = { exports: {} };
  new Function('exports', 'module', js)(module.exports, module);
  const rows = module.exports.turnMessages;
  assert.ok(Object.keys(rows).length >= 30);
  for (const [key, values] of Object.entries(rows)) {
    assert.equal(values.length, 3, key);
    for (const value of values) assert.ok(typeof value === 'string' && value.trim(), key);
  }
});

test('NPC lifecycle is explicit and legacy zero vitality is unconscious, never inferred dead', async () => {
  const { publicLifeState, npcUnavailable } =
    await import('../../apps/web/components/game/turn-ui.ts');
  assert.equal(publicLifeState({}), 'conscious');
  assert.equal(publicLifeState({ vitality: 0 }), 'unconscious');
  assert.equal(publicLifeState({ lifeState: 'dead', vitality: 6 }), 'dead');
  assert.equal(publicLifeState({ lifeState: 'conscious', vitality: 0 }), 'conscious');
  for (const lifeState of ['unconscious', 'dead']) {
    assert.equal(npcUnavailable({ kind: 'npc', lifeState }), true);
    assert.equal(npcUnavailable({ kind: 'player', lifeState }), false);
  }
  const { storyTargetValid } = await import('../../apps/web/components/game/story-turn-guards.ts');
  for (const state of [{ lifeState: 'dead' }, { lifeState: 'unconscious' }, { vitality: 0 }]) {
    const projection = { entities: [{ id: 'keeper', kind: 'npc', ...state }] };
    assert.equal(storyTargetValid(projection, 'say', 'keeper'), false);
    assert.equal(storyTargetValid(projection, 'whisper', 'keeper'), false);
    assert.equal(storyTargetValid(projection, 'say'), true);
  }
});

test('unavailable NPCs remain inspectable on the map with localized lifecycle and guarded actions', async () => {
  const read = (name) =>
    readFile(new URL(`../../apps/web/components/game/${name}`, import.meta.url), 'utf8');
  const menu = await read('map-actions.tsx');
  assert.match(menu, /disabled=\{disabled \|\| unavailable\}/);
  assert.equal((menu.match(/disabled=\{main \|\| unavailable\}/g) || []).length, 2);
  assert.match(menu, /onInspect\?\.\(e.id\)/);
  const canvas = await read('game-canvas.tsx');
  assert.match(canvas, /projection.entities.filter\(npcUnavailable\)/);
  // The badge opens the full card through the wrapper that also closes the compact art window.
  assert.match(canvas, /inspectNpc\?\.\(entity.id\)/);
  assert.match(canvas, /onInspectNpc\(id\)/);
  assert.match(canvas, /record.sprite.tint = npcUnavailable\(entity\)/);
  assert.match(canvas, /present.add\(entity.id\)/);
  const inspection = await read('npc-public-inspection.tsx');
  assert.match(inspection, /disabled=\{disabled \|\| lifeState !== 'conscious'\}/);
  assert.match(inspection, /data-life-state=\{lifeState\}/);
});

test('author and moderator previews label every lifecycle observation in all UI locales', async () => {
  const { translate } = await import('../../apps/web/lib/locales.ts');
  const source = await readFile(
    new URL('../../apps/web/components/studio/living-npc-preview.tsx', import.meta.url),
    'utf8',
  );
  const labels = {
    died: 'Замечена смерть персонажа',
    lost_consciousness: 'Замечена потеря сознания',
    regained_consciousness: 'Персонаж пришёл в сознание',
    revived: 'Персонаж вернулся к жизни',
    life_state_seen: 'Замечено состояние персонажа',
  };
  for (const [kind, label] of Object.entries(labels)) {
    assert.ok(source.includes(`${kind}: '${label}'`));
    assert.equal(translate('ru', label), label);
    for (const locale of ['en', 'uk']) assert.notEqual(translate(locale, label), label);
  }
  const moderator = await readFile(
    new URL('../../apps/web/components/studio/moderator-npc-preview.tsx', import.meta.url),
    'utf8',
  );
  assert.match(moderator, /import \{ observationLabels \} from '.\/living-npc-preview'/);
});

test('long committed paths finish promptly without replacing their geometry by a straight line', () => {
  const path = Array.from({ length: 61 }, (_, i) => ({
    x: i <= 30 ? i : 30,
    y: i <= 30 ? 0 : i - 30,
  }));
  assert.deepEqual(committedPathSample(path, 900), { x: 30, y: 0, moving: true, direction: 0 });
  assert.deepEqual(committedPathSample(path, 1800), { x: 30, y: 30, moving: false, direction: 0 });
});
