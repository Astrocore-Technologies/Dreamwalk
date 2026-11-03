// Regression for preserving battlemap geometry when choosing NPC placeholders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { entityLayout } from '../../apps/web/components/game/scene-geometry.ts';
const require = createRequire(import.meta.url);
const g = require('../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
test('explicit NPC silhouettes preserve every creature footprint through compile and projection', () => {
  for (const tokenSize of c.tokenSizeSchema.options) {
    for (const npcPlaceholder of c.npcPlaceholderSchema.options) {
      const draft = g.createAuthoredDraft('courtyard');
      draft.maps = [
        {
          ...draft.maps[0],
          width: 24,
          height: 24,
          blocked: [],
          exits: [],
          spawns: [1, 2, 3, 4].map((x) => ({ x, y: 1 })),
        },
      ];
      draft.startMapId = draft.maps[0].id;
      draft.objects = [];
      draft.npcs = [
        {
          id: 'token',
          label: 'Explicit placeholder',
          mapId: draft.startMapId,
          x: 8,
          y: 8,
          visual: 'keeper',
          goal: 'help',
          tokenSize,
          npcPlaceholder,
        },
      ];
      const result = g.compilePlayableDraft(draft);
      assert.deepEqual(result.errors, []);
      const state = g.createStateFromPlayable(result.playable, ['alice']);
      state.entities.alice.x = 7;
      state.entities.alice.y = 7;
      const projected = c.gameProjectionSchema.parse(g.projectState(state, 'alice'));
      const npc = projected.entities.find((e) => e.id === 'token');
      assert.ok(npc);
      assert.equal(npc.tokenSize, tokenSize);
      assert.equal(npc.npcPlaceholder, npcPlaceholder);
      const without = { ...npc };
      delete without.npcPlaceholder;
      assert.deepEqual(
        entityLayout(npc, projected.entities),
        entityLayout(without, projected.entities),
      );
      assert.equal(entityLayout(npc, projected.entities).width, 48 * c.TOKEN_FOOTPRINT[tokenSize]);
      assert.equal(c.footprintCells(npc), c.footprintCells(without));
    }
  }
});
