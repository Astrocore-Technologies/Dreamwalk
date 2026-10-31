import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraAxis } from '../../apps/web/components/game/camera-geometry.ts';
import { labelEditPatch } from '../../apps/web/components/studio/label-edit.ts';
import { localizedProjection } from '../../apps/web/components/game/localized-projection.ts';
import { readFile } from 'node:fs/promises';
import {
  sceneCells,
  drawBundledScene,
  drawJournal,
} from '../../apps/web/components/game/bundled-scene.ts';
test('bundled scene dressing is explicit, bounded and never occupies blocked geometry', () => {
  const base = { width: 3, height: 2, blocked: [{ x: 1, y: 1 }] };
  assert.deepEqual(sceneCells(base), []);
  assert.deepEqual(sceneCells({ ...base, sceneProfile: 'invented' }), []);
  for (const sceneProfile of ['observatory-interior-v1', 'observatory-roof-v1']) {
    const cells = sceneCells({ ...base, sceneProfile });
    assert.equal(cells.length, 5);
    assert.ok(
      cells.every(({ x, y }) => x >= 0 && x < 3 && y >= 0 && y < 2 && !(x === 1 && y === 1)),
    );
  }
});
test('original vector drawing has no provider/network dependency and cleans on each map draw', () => {
  const calls = [];
  const graphics = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) => {
          calls.push([name, args]);
          return graphics;
        },
    },
  );
  drawBundledScene(
    graphics,
    { width: 4, height: 4, blocked: [], sceneProfile: 'observatory-roof-v1' },
    48,
  );
  assert.equal(calls[0][0], 'clear');
  assert.equal(calls.filter(([name]) => name === 'roundRect').length, 16);
  calls.length = 0;
  drawJournal(graphics);
  assert.ok(calls.some(([name]) => name === 'roundRect'));
  assert.ok(calls.some(([name]) => name === 'circle'));
});
test('objective UI consumes server progress and gates all epilogue rendering on achieved', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/campaign-objectives.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /objective\.status === 'achieved'/);
  assert.match(source, /achieved &&/);
  assert.match(source, /translations\?\.\[locale\]/);
  assert.doesNotMatch(source, /fetch\(|api\(|setInterval|completion\.conditions|inventory/);
});

test('curated scene labels localize visible presentation without mutating world IDs or original speech', () => {
  const p = {
    actorId: 'player',
    tick: 5,
    revision: 8,
    map: {
      id: 'observatory',
      label: 'Hall',
      labelTranslations: { ru: 'Зал', uk: 'Зала' },
      blocked: [{ x: 1, y: 2 }],
      exits: [
        {
          id: 'roof-exit',
          label: 'Roof',
          labelTranslations: { ru: 'Крыша' },
          destinationMapId: 'roof',
        },
      ],
    },
    entities: [
      { id: 'journal', label: 'Journal', labelTranslations: { ru: 'Журнал' }, x: 7, y: 4 },
    ],
    inventory: [{ id: 'key', label: 'Key', labelTranslations: { ru: 'Ключ' } }],
    npcUtterances: [{ text: 'Original public speech' }],
  };
  const before = structuredClone(p);
  const ru = localizedProjection(p, 'ru');
  assert.equal(ru.map.label, 'Зал');
  assert.equal(ru.map.exits[0].label, 'Крыша');
  assert.equal(ru.entities[0].label, 'Журнал');
  assert.equal(ru.inventory[0].label, 'Ключ');
  assert.equal(ru.entities[0].id, 'journal');
  assert.equal(ru.entities[0].x, 7);
  assert.equal(ru.npcUtterances, p.npcUtterances);
  assert.equal(ru.map.blocked, p.map.blocked);
  assert.deepEqual(p, before);
  assert.equal(localizedProjection(p, 'en').map.label, 'Hall');
  assert.equal(localizedProjection(null, 'uk'), null);
});

test('author source rename clears stale curated variants while movement preserves them', () => {
  const source = { label: 'Journal', labelTranslations: { ru: 'Журнал' }, x: 2 };
  const renamed = { ...source, ...labelEditPatch(source.label, { label: 'Notebook' }) };
  assert.equal(renamed.labelTranslations, undefined);
  assert.equal(renamed.label, 'Notebook');
  const moved = { ...source, ...labelEditPatch(source.label, { x: 3 }) };
  assert.deepEqual(moved.labelTranslations, { ru: 'Журнал' });
  const unchanged = { label: 'Journal' };
  assert.equal(labelEditPatch(source.label, unchanged), unchanged);
  assert.deepEqual(source.labelTranslations, { ru: 'Журнал' });
});

test('game scene precedes expanded objective text while private hero stays in the HUD', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  const canvas = source.indexOf('<GameCanvas');
  const objective = source.indexOf('<CampaignObjectives');
  const sidebar = source.indexOf('<aside className={styles.hud}>');
  const hero = source.indexOf('<CampaignHero');
  assert.ok(canvas > 0 && objective > canvas);
  assert.ok(sidebar > objective && hero > sidebar);
});

test('camera centers small maps and clamps large maps at every edge without changing hit coordinates', () => {
  assert.equal(cameraAxis(1000, 768, 100, 1), 116);
  assert.equal(cameraAxis(1000, 768, 700, 1), 116);
  assert.equal(cameraAxis(400, 768, 10, 1), 0);
  assert.equal(cameraAxis(400, 768, 750, 1), -368);
  assert.equal(cameraAxis(400, 768, 384, 1), -184);
  assert.equal(cameraAxis(800, 768, 10, 0.6), (800 - 768 * 0.6) / 2);
  assert.equal(cameraAxis(400, 768, 750, 1.5), 400 - 768 * 1.5);
  for (const viewport of [0, 390, 810, 1400])
    for (const zoom of [0.6, 1, 1.5]) {
      const offset = cameraAxis(viewport, 768, 400, zoom);
      const screenPoint = 320 * zoom + offset;
      assert.ok(Math.abs((screenPoint - offset) / zoom - 320) < 0.000001);
      if (768 * zoom >= viewport) assert.ok(offset <= 0 && offset >= viewport - 768 * zoom);
      else assert.equal(offset, (viewport - 768 * zoom) / 2);
    }
});
