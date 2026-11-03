import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BATTLEMAP_CELLS,
  footprintCells,
  TOKEN_FOOTPRINT,
  tokenSizeSchema,
  gamePublicEntitySchema,
  deriveMapImageFraming,
} from '../../packages/contracts/dist/index.js';
import { createAuthoredDraft, compilePlayableDraft } from '../../packages/game-core/dist/index.js';
import { entityLayout, containsScenePoint } from '../../apps/web/components/game/scene-geometry.ts';

test('all new manual maps use the same 24-cell square and existing 1024-square profile', () => {
  for (const template of ['observatory', 'courtyard']) {
    const draft = createAuthoredDraft(template);
    for (const map of draft.maps) {
      assert.equal(map.width, BATTLEMAP_CELLS);
      assert.equal(map.height, BATTLEMAP_CELLS);
      assert.equal(deriveMapImageFraming(map.id, map.width, map.height).size, '1024x1024');
    }
    assert.deepEqual(compilePlayableDraft(draft).errors, []);
  }
});
test('size is validated explicit metadata, not raster dimensions; legacy actors default medium', () => {
  const base = { id: 'goblin', kind: 'npc', x: 4, y: 6, mapId: 'room', revision: 0 };
  for (const size of tokenSizeSchema.options) {
    const entity = gamePublicEntitySchema.parse({ ...base, tokenSize: size });
    for (const aspect of [0.1, 1, 10, NaN, Infinity]) {
      const box = entityLayout(entity, [entity], 48, aspect, true);
      assert.ok(box.width <= 48 * TOKEN_FOOTPRINT[size]);
      assert.ok(box.height <= 48 * TOKEN_FOOTPRINT[size]);
      assert.ok(
        containsScenePoint(box, {
          x: (4 + footprintCells(entity) / 2) * 48,
          y: (6 + footprintCells(entity) / 2) * 48,
        }),
      );
    }
  }
  assert.deepEqual(
    entityLayout(base, [base]),
    entityLayout({ ...base, tokenSize: 'medium' }, [base]),
  );
  assert.ok(
    entityLayout({ ...base, tokenSize: 'small' }, [base]).width < entityLayout(base, [base]).width,
  );
  assert.ok(entityLayout({ ...base, tokenSize: 'large' }, [base]).width > 48);
  assert.equal(gamePublicEntitySchema.safeParse({ ...base, tokenSize: 'infinite' }).success, false);
});
test('compiled NPC metadata survives while saved legacy map coordinates and collision are unchanged', () => {
  const draft = createAuthoredDraft();
  draft.npcs[0].tokenSize = 'small';
  const compiled = compilePlayableDraft(draft).playable;
  assert.equal(compiled.entities.keeper.tokenSize, 'small');
  const legacy = structuredClone(draft);
  legacy.maps[0].width = 12;
  legacy.maps[0].height = 10;
  const before = structuredClone(legacy.maps);
  compilePlayableDraft(legacy);
  assert.deepEqual(legacy.maps, before);
});
test('grid always renders above artwork and below tokens, never a user toggle', () => {
  const source = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /boundary, grid, objects/);
  assert.match(source, /cell <= edge/);
  assert.match(source, /dataset.battlemapGrid/);
  assert.doesNotMatch(source, /gridVisible|showGrid|setShowGrid/);
});

test('visible large NPC selection covers every occupied cell, not only its anchor', async () => {
  const { sceneClick } = await import('../../apps/web/components/game/scene-input.ts');
  const npc = { id: 'giant', kind: 'npc', tokenSize: 'huge', x: 3, y: 4 };
  const p = { map: { width: 24, height: 24, blocked: [] }, entities: [npc] };
  assert.deepEqual(sceneClick(p, 5, 6), { kind: 'npc', npcId: 'giant' });
  assert.deepEqual(sceneClick(p, 6, 6), { kind: 'move', target: { x: 6, y: 6 } });
});

test('new/imported maps cannot bypass fixed extent while old geometry stays editable', async () => {
  const { fixedMapExtentsAllowed } = await import('../../packages/contracts/dist/index.js');
  const old = { id: 'legacy', width: 12, height: 8 };
  assert.equal(fixedMapExtentsAllowed([old]), false);
  assert.equal(fixedMapExtentsAllowed([old], [old]), true);
  assert.equal(fixedMapExtentsAllowed([{ ...old, width: 16 }], [old]), false);
  assert.equal(fixedMapExtentsAllowed([{ id: 'new', width: 24, height: 24 }]), true);
  assert.equal(fixedMapExtentsAllowed([{ ...old, id: 'new' }], [old]), false);
});
