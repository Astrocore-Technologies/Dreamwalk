import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prepareLegacyTurnState } from '../../apps/api/src/game/turn-conversion.ts';
const g = createRequire(import.meta.url)('../../packages/game-core/dist');
const fixture = () => {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  delete draft.turnRules;
  const result = g.compilePlayableDraft(draft);
  assert.deepEqual(result.errors, []);
  return g.createStateFromPlayable(result.playable, ['owner', 'guest'], 91);
};
test('explicit conversion keeps confirmed progress and secrets while stopping only future legacy motion', () => {
  const before = fixture();
  before.entities.owner.path = [{ x: 4, y: 3 }];
  before.entities.keeper.path = [{ x: 7, y: 4 }];
  before.npcBrains.keeper.waitingForPath = true;
  before.narrativePremise = {
    title: 'Fixture',
    summary: 'Saved progress',
    world: 'Private fixture canon',
    genre: 'mystery',
  };
  const item = Object.values(before.entities).find((entity) => entity.kind === 'item');
  item.ownerId = 'owner';
  const saved = structuredClone(before);
  const after = prepareLegacyTurnState(before, ['owner', 'guest'], { movement: 9 });
  assert.deepEqual(before, saved);
  assert.equal(after.turnController.phase, 'player');
  assert.equal(after.turnController.activeActorId, 'owner');
  assert.equal(after.turnController.resources.owner.movement, 9);
  assert.equal(after.seed, before.seed);
  assert.equal(after.tick, before.tick);
  for (const key of [
    'maps',
    'assetManifest',
    'artBindings',
    'narrativePremise',
    'narrativeCanon',
    'objectiveProgress',
    'encounters',
  ])
    assert.deepEqual(after[key], before[key]);
  for (const [id, entity] of Object.entries(before.entities)) {
    const result = structuredClone(after.entities[id]);
    if (entity.kind === 'player' || entity.kind === 'npc') {
      for (const field of [
        'path',
        'movementTrace',
        'movementGeneration',
        'maxVitality',
        'vitality',
      ]) {
        delete result[field];
      }
    }
    const original = structuredClone(entity);
    if (entity.kind === 'player' || entity.kind === 'npc') {
      for (const field of [
        'path',
        'movementTrace',
        'movementGeneration',
        'maxVitality',
        'vitality',
      ])
        delete original[field];
    }
    assert.deepEqual(result, original);
  }
  assert.deepEqual(after.entities.owner.path, []);
  assert.deepEqual(after.entities.keeper.path, []);
  assert.equal(after.entities[item.id].ownerId, 'owner');
  const brain = structuredClone(after.npcBrains.keeper),
    oldBrain = structuredClone(before.npcBrains.keeper);
  for (const field of ['waitingForPath', 'movementGeneration']) {
    delete brain[field];
    delete oldBrain[field];
  }
  assert.deepEqual(brain, oldBrain);
  assert.deepEqual(g.tick(after, 100).state, after);
  assert.deepEqual(g.stepLivingNpcs(after).state, after);
  assert.deepEqual(g.stepNpcPlan(after, 'keeper').state, after);
});
test('conversion rejects reinitialization, active encounters and unsupported legacy rules instead of resetting them', () => {
  const before = fixture();
  const converted = prepareLegacyTurnState(before, ['owner']);
  assert.throws(() => prepareLegacyTurnState(converted, ['owner']), /TURN_ALREADY_INITIALIZED/);
  assert.throws(
    () => prepareLegacyTurnState({ ...before, rulesetVersion: 'hybrid-v2' }, ['owner']),
    /TURN_RULESET_UPGRADE_REQUIRED/,
  );
  const encounter = structuredClone(before);
  encounter.encounters.active = { phase: 'planning' };
  assert.throws(
    () => prepareLegacyTurnState(encounter, ['owner']),
    /TURN_CONVERSION_ENCOUNTER_ACTIVE/,
  );
  assert.equal(before.turnController, undefined);
});
