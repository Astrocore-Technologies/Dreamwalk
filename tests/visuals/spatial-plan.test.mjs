/** Pure geometry/public-canon checks; supplied model outputs are synthetic fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spatialFixture } from './spatial-fixtures.mjs';
const require = createRequire(import.meta.url);
const {
  validateSpatialPlan,
  authorizeSpatialPlan,
  spatialReadset,
} = require('../../apps/api/dist/visual-authoring/spatial-plan.js');
const {
  compilePlayableDraft,
  createStateFromPlayable,
  projectState: project,
} = require('../../packages/game-core/dist/index.js');
const {
  turnRulesSchema,
  narrativeConstraintsSchema,
} = require('../../packages/contracts/dist/index.js');
await test('spatial outputs determine geometry and public canon, not a renamed fixed template', () => {
  const library = validateSpatialPlan(spatialFixture()),
    garden = validateSpatialPlan(spatialFixture('greenhouse'));
  assert.equal(library.plan.maps[0].width, 14);
  assert.equal(garden.plan.maps[0].width, 18);
  assert.notDeepEqual(
    library.plan.maps[0].composition.layers,
    garden.plan.maps[0].composition.layers,
  );
  assert.equal(garden.plan.npcs[0].label, 'Elian');
  assert.equal(library.plan.npcs[0].label, 'Sera');
  const publicText = JSON.stringify([
    garden.plan.title,
    ...garden.plan.maps.map((m) => [
      m.label,
      m.description,
      ...m.composition.layers.map((l) => l.label),
    ]),
    garden.plan.npcs.map((n) => [n.label, n.publicProfile]),
    garden.plan.objects.map((o) => [o.label, o.publicProfile]),
    garden.plan.objectives,
  ]);
  for (const old of ['Mira', 'Rain room', 'Find the rain journal', 'brass ink', 'old observatory'])
    assert.equal(publicText.includes(old), false);
  assert.ok(garden.plan.maps.every((m) => m.composition.provenance === 'ai-generated-plan'));
});
await test('invalid bounds, duplicate identities, overlaps and unreachable exits are rejected', () => {
  const cases = [];
  let p = spatialFixture();
  p.rooms[1].id = 'atelier';
  cases.push(p);
  p = spatialFixture();
  p.furniture[0].x = 23;
  cases.push(p);
  p = spatialFixture();
  p.rooms[0].spawns[1] = p.rooms[0].spawns[0];
  cases.push(p);
  p = spatialFixture();
  p.npc.point = p.rooms[0].spawns[0];
  cases.push(p);
  p = spatialFixture();
  p.connection.door = { x: 2, y: 5 };
  cases.push(p);
  p = spatialFixture();
  p.furniture = [];
  p.rooms[0].blocked = Array.from({ length: 10 }, (_, i) => ({ x: 6, y: i + 1 }));
  cases.push(p);
  for (const value of cases) assert.throws(() => validateSpatialPlan(value));
});
await test('a stationary NPC cannot be the only passage through a wall', () => {
  const p = spatialFixture();
  p.furniture = [];
  p.npc.point = { x: 6, y: 5 };
  p.rooms[0].blocked = Array.from({ length: 10 }, (_, i) => ({ x: 6, y: i + 1 })).filter(
    (point) => point.y !== 5,
  );
  assert.throws(() => validateSpatialPlan(p), /occupied-exit-path/);
});
await test('author rules and private protected constraints are pinned server-side, public profiles survive projection', () => {
  const authority = {
    turnRules: turnRulesSchema.parse({ movement: 3, main: 2 }),
    narrativeConstraints: narrativeConstraintsSchema.parse({
      allowNewScenes: false,
      allowNewNpcs: false,
      protectedFacts: [{ id: 'private-author-fact', text: 'PRIVATE_AUTHOR_SENTINEL' }],
    }),
    roundPolicy: { maxRounds: 7, planningMs: 40000 },
  };
  const { plan } = authorizeSpatialPlan(spatialFixture(), authority);
  assert.deepEqual(plan.turnRules, authority.turnRules);
  assert.deepEqual(plan.narrativeConstraints, authority.narrativeConstraints);
  assert.deepEqual(plan.roundPolicy, authority.roundPolicy);
  const compiled = compilePlayableDraft(plan);
  assert.ok(compiled.playable);
  const state = createStateFromPlayable(compiled.playable, ['preview'], 1);
  state.entities.preview.x = 9;
  state.entities.preview.y = 5;
  let view = project(state, 'preview'),
    npc = view.entities.find((e) => e.id === 'alchemist');
  assert.ok(npc);
  assert.equal(npc.label, 'Sera');
  assert.equal(npc.publicProfile.role, 'cataloguer');
  assert.equal(npc.publicProfile.description, spatialFixture().npc.description);
  assert.equal(npc.publicProfile.appearance, spatialFixture().npc.appearance);
  assert.equal(JSON.stringify(view).includes('PRIVATE_AUTHOR_SENTINEL'), false);
  state.entities.preview.mapId = 'annex';
  state.entities.preview.x = 5;
  state.entities.preview.y = 4;
  view = project(state, 'preview');
  assert.equal(
    view.entities.find((e) => e.id === 'rain-journal').publicProfile.description,
    spatialFixture().item.description,
  );
  const readset = spatialReadset({
    id: 'project',
    revision: 1,
    source_hash: 'a'.repeat(64),
    plan_origin: 'ai-pending',
    brief: { name: 'Library', description: 'A public library brief' },
    public_grounding: { world: 'PUBLIC_WORLD', opening: 'PUBLIC_OPENING' },
    plan_authority: authority,
  });
  const packed = JSON.stringify(readset.context);
  assert.equal(packed.includes('PRIVATE_AUTHOR_SENTINEL'), false);
  assert.ok(packed.includes('PUBLIC_WORLD'));
  assert.ok(packed.includes('PUBLIC_OPENING'));
  assert.ok(readset.context.authorityHash);
  assert.throws(
    () =>
      authorizeSpatialPlan(spatialFixture(), {
        narrativeConstraints: narrativeConstraintsSchema.parse({ maxScenes: 1 }),
      }),
    /author-scene-limit/,
  );
  assert.throws(
    () =>
      authorizeSpatialPlan(spatialFixture(), {
        narrativeConstraints: narrativeConstraintsSchema.parse({ forbiddenRoles: ['cataloguer'] }),
      }),
    /author-forbidden-role/,
  );
});
