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
