import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(
  new URL('../../apps/web/components/game/npc-silhouettes.ts', import.meta.url),
  'utf8',
);
const exports = {};
new Function(
  'exports',
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
)(exports);
const { npcSilhouetteKey, drawNpcSilhouette, NPC_PLACEHOLDERS, NPC_SILHOUETTE_VARIANTS } = exports;
test('neutral fallback, explicit category and ID-only stable variant selection', () => {
  assert.match(npcSilhouetteKey({ id: 'one', label: 'Woman' }), /^neutral:[0-2]$/);
  for (const npcPlaceholder of NPC_PLACEHOLDERS) {
    const variants = new Set();
    for (let i = 0; i < 100; i++) {
      const entity = { id: 'npc-' + i, npcPlaceholder };
      const key = npcSilhouetteKey(entity);
      assert.equal(
        key,
        npcSilhouetteKey({ ...entity, label: 'Changed', publicProfile: { appearance: 'Changed' } }),
      );
      assert.ok(key.startsWith(npcPlaceholder + ':'));
      variants.add(key);
    }
    assert.equal(variants.size, NPC_SILHOUETTE_VARIANTS);
  }
});
test('all 12 original vector tokens are distinct and finite; no external assets or generation', () => {
  const outputs = new Set();
  for (const category of NPC_PLACEHOLDERS)
    for (let variant = 0; variant < 3; variant++) {
      const calls = [];
      const graphics = new Proxy(
        {},
        {
          get:
            (_, method) =>
            (...args) => {
              for (const value of args)
                if (typeof value === 'number') assert.ok(Number.isFinite(value));
              calls.push([method, ...args]);
              return graphics;
            },
        },
      );
      drawNpcSilhouette(graphics, category, variant);
      outputs.add(JSON.stringify(calls));
    }
  assert.equal(outputs.size, 12);
  assert.doesNotMatch(source, /fetch\(|Assets\.load|Math\.random/);
});
test('bound art keeps precedence and placeholder textures are cleaned up', () => {
  const canvas = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(canvas, /boundTexture \|\|\s*\(entity.kind === 'npc'/);
  assert.match(canvas, /npcTextures\.get\(npcSilhouetteKey\(entity\)\)/);
  assert.match(canvas, /for \(const texture of npcTextures.values\(\)\) texture.destroy\(true\)/);
});
