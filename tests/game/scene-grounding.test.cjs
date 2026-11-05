// Synthetic context only; no provider dispatch, paid quote, or real campaign data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { sceneGroundingInstructions } = require('../../apps/api/dist/ai/scene-grounding');
const { startMapGroundingCompatible } = require('../../apps/api/dist/game/story-map-mode');
const g = require('../../packages/game-core/dist');

test('scene description is explicitly wider than the current committed position', () => {
  const state = g.createObservatoryState(['hero']);
  state.maps[state.entities.hero.mapId].description = 'The interior of a tower beside a shore.';
  const before = structuredClone(state);
  const context = g.buildNarrativeContext(state, 'hero', 'Look toward the tower.');
  assert.equal(context.currentScene.descriptionScope, 'whole_location');
  assert.equal(context.currentScene.positionEvidence, 'committed_state');
  assert.equal(context.currentScene.terrainAnalysisAvailable, false);
  assert.deepEqual(context.currentScene.actorPosition, {
    x: state.entities.hero.x,
    y: state.entities.hero.y,
  });
  assert.deepEqual(state, before, 'building context never repairs position by moving the actor');
});

test('narrator guidance follows present evidence and player agency without changing NPC knowledge', () => {
  for (const purpose of ['narrative', 'story_turn']) {
    const guidance = sceneGroundingInstructions(purpose);
    assert.match(guidance, /Opening prose is an initial premise/);
    assert.match(guidance, /committed actionOutcomes/);
    assert.match(guidance, /do not recite confirmation, validation or engine terminology/);
    assert.match(guidance, /Do not replace a technical disclaimer with invented success/);
    assert.match(guidance, /narrator knowledge does not become their knowledge/);
  }
  for (const purpose of ['speech', 'plan', 'intent'])
    assert.equal(sceneGroundingInstructions(purpose), '');
  assert.equal(sceneGroundingInstructions('story_turn', { mode: 'npc' }), '');
});

test('new image-aware starts cannot reuse schematic, mismatched or low-confidence layouts', () => {
  const image = { locationId: 'tower', revisionId: randomUUID(), sha256: 'a'.repeat(64) };
  const source = { mapImages: [image] };
  const compiled = { maps: { tower: { backgroundMode: 'schematic' } } };
  assert.equal(startMapGroundingCompatible(source, compiled), false);
  compiled.maps.tower.spatialGrounding = {
    imageRevisionId: image.revisionId,
    imageSha256: image.sha256,
    confidence: 0.95,
  };
  assert.equal(startMapGroundingCompatible(source, compiled), false);
  delete compiled.maps.tower.backgroundMode;
  assert.equal(startMapGroundingCompatible(source, compiled), true);
  compiled.maps.tower.spatialGrounding.imageSha256 = 'b'.repeat(64);
  assert.equal(startMapGroundingCompatible(source, compiled), false);
  compiled.maps.tower.spatialGrounding.imageSha256 = image.sha256;
  compiled.maps.tower.spatialGrounding.confidence = 0.84;
  assert.equal(startMapGroundingCompatible(source, compiled), false);
  assert.equal(
    startMapGroundingCompatible({ mapImages: [{ ...image, locationId: 'other' }] }, compiled),
    false,
  );
});

test('text-only reuse stays free, but a saved image cannot reuse an ungrounded schematic layout', () => {
  const compiled = { maps: { tower: { backgroundMode: 'schematic', spawns: [{ x: 3, y: 4 }] } } };
  const before = structuredClone(compiled);
  assert.equal(
    startMapGroundingCompatible(
      {
        omittedMapImages: [
          { locationId: 'tower', revisionId: randomUUID(), sha256: 'a'.repeat(64) },
        ],
      },
      compiled,
    ),
    false,
  );
  assert.equal(startMapGroundingCompatible({}, compiled), true);
  assert.deepEqual(compiled, before);
});
