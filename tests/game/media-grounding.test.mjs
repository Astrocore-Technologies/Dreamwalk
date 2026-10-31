import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservatoryState, addPlayer } from '@dreamwalk/game-core';
import { prepareSceneMedia } from '../../apps/api/src/game/media-preparation.ts';
function fixture() {
  const state = addPlayer(createObservatoryState(), 'player-a').state;
  state.entities['player-a'].x = 5;
  state.entities['player-a'].y = 4;
  state.narrativeSource = { versionId: 'source-v1', checksum: 'a'.repeat(64) };
  return state;
}
test('floor and portrait grounding ignores unrelated motion and bookkeeping but checks visibility each time', () => {
  const state = fixture();
  for (const input of [{ kind: 'background' }, { kind: 'portrait', entityId: 'keeper' }]) {
    const before = prepareSceneMedia(state, 'player-a', 'source-v1', input);
    const moved = structuredClone(state);
    moved.tick += 100;
    moved.revision += 3;
    moved.entities.keeper.x += 1;
    moved.entities.keeper.revision++;
    const after = prepareSceneMedia(moved, 'player-a', 'source-v1', input);
    assert.equal(after.groundingHash, before.groundingHash);
    assert.notDeepEqual(
      after.grounding.separateRuntimeLayers,
      before.grounding.separateRuntimeLayers,
    );
  }
  state.entities.keeper.mapId = 'roof';
  assert.throws(() =>
    prepareSceneMedia(state, 'player-a', 'source-v1', { kind: 'portrait', entityId: 'keeper' }),
  );
});
test('grounding invalidates canonical source, story, geometry and relevant subject changes', () => {
  const state = fixture(),
    input = { kind: 'portrait', entityId: 'keeper' };
  const baseline = prepareSceneMedia(state, 'player-a', 'source-v1', input).groundingHash;
  for (const mutate of [
    (s) => {
      s.narrativeSource.checksum = 'b'.repeat(64);
    },
    (s) => {
      s.narrativeCanon = { revision: 1, turns: [] };
    },
    (s) => {
      s.maps[s.entities['player-a'].mapId].revision++;
    },
    (s) => {
      s.maps[s.entities['player-a'].mapId].blocked.push({ x: 2, y: 2 });
    },
    (s) => {
      s.entities.keeper.label = 'Another resident';
    },
  ]) {
    const next = structuredClone(state);
    mutate(next);
    assert.notEqual(
      prepareSceneMedia(next, 'player-a', 'source-v1', input).groundingHash,
      baseline,
    );
  }
});
test('image prompt includes bounded immutable public premise, never private NPC or dialogue state', () => {
  const state = fixture();
  state.narrativePremise = {
    title: 'Tidal observatory',
    genre: 'mystery',
    summary: 'Blue brass floors under a drowned moon.',
    world: 'A city of salt and glass. '.repeat(30),
  };
  state.npcBrains = { keeper: { secret: 'PRIVATE_KEEPER_SECRET' } };
  state.npcUtterances = [{ text: 'PRIVATE_WHISPER_SECRET', audienceIds: ['keeper'] }];
  const prepared = prepareSceneMedia(state, 'player-a', 'source-v1', { kind: 'background' });
  assert.match(prepared.prompt, /Tidal observatory/);
  assert.match(prepared.prompt, /Blue brass floors/);
  assert.match(prepared.prompt, /salt and glass/);
  assert.equal(prepared.grounding.storyReference.world.excerpted, true);
  assert.ok(prepared.prompt.length <= 2000);
  assert.doesNotMatch(prepared.prompt, /PRIVATE_KEEPER_SECRET|PRIVATE_WHISPER_SECRET/);
  assert.match(prepared.prompt, /Omitted canon does not authorize invented objects/);
});
test('returning to an old scene uses its confirmed description beyond the recent sixteen turns', () => {
  const state = fixture(),
    mapId = state.entities['player-a'].mapId;
  state.narrativeCanon = {
    revision: 25,
    turns: [
      {
        id: 'old',
        sceneId: mapId,
        introducedScene: {
          id: mapId,
          name: 'Old room',
          description: 'Silver inlay follows the tidal calendar.',
        },
      },
      ...Array.from({ length: 24 }, (_, i) => ({
        id: `later-${i}`,
        sceneId: `elsewhere-${i}`,
        narration: 'UNRELATED_LATER_NARRATION',
        introducedScene: { id: `elsewhere-${i}`, name: 'Other', description: 'OTHER_ROOM_SECRET' },
      })),
    ],
  };
  const prepared = prepareSceneMedia(state, 'player-a', 'source-v1', { kind: 'background' });
  assert.match(prepared.prompt, /Silver inlay follows the tidal calendar/);
  assert.doesNotMatch(prepared.prompt, /UNRELATED_LATER_NARRATION|OTHER_ROOM_SECRET/);
});
test('maximum valid NPC card yields bounded visual-only portrait prompt and ignores nonvisual flavor', () => {
  const state = fixture();
  state.narrativePremise = {
    title: 'T'.repeat(120),
    genre: 'G'.repeat(50),
    summary: 'S'.repeat(4000),
    world: 'W'.repeat(12000),
  };
  state.narrativeCanon = {
    revision: 1,
    turns: [
      {
        sceneId: state.entities['player-a'].mapId,
        introducedScene: { description: 'L'.repeat(1000) },
      },
    ],
  };
  state.entities.keeper.label = 'N'.repeat(80);
  state.entities.keeper.supportingNpc = {
    generated: true,
    roleId: 'director-secondary',
    roleLabel: 'R'.repeat(120),
    description: 'NONVISUAL_DESCRIPTION'.padEnd(1000, 'x'),
    appearance: 'A'.repeat(500),
    personalitySummary: 'NONVISUAL_PERSONALITY'.padEnd(500, 'x'),
  };
  const input = { kind: 'portrait', entityId: 'keeper' };
  const before = prepareSceneMedia(state, 'player-a', 'source-v1', input);
  assert.ok(before.prompt.length <= 2000);
  assert.match(before.prompt, /A{500}/);
  assert.doesNotMatch(before.prompt, /NONVISUAL_DESCRIPTION|NONVISUAL_PERSONALITY/);
  state.entities.keeper.supportingNpc.description = 'Changed prose';
  state.entities.keeper.supportingNpc.personalitySummary = 'Changed temperament';
  assert.equal(
    prepareSceneMedia(state, 'player-a', 'source-v1', input).groundingHash,
    before.groundingHash,
  );
  state.entities.keeper.supportingNpc.appearance = 'Different coat';
  assert.notEqual(
    prepareSceneMedia(state, 'player-a', 'source-v1', input).groundingHash,
    before.groundingHash,
  );
});
