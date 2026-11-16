const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');

function world(presence) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  if (presence) draft.npcs.find((npc) => npc.id === 'keeper').plannedPresence = presence;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  return state;
}
function arrive(state, point, targetId = 'keeper') {
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: '*Someone appears at the far end of the room.*',
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
  };
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const body = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action: null,
      reply: null,
      ...(segment.kind === 'attempt'
        ? {
            establishedEvents: [
              {
                description: 'A figure comes in.',
                entityIds: [targetId],
                effects: [{ kind: 'npc_arrival', targetId, point }],
              },
            ],
          }
        : {}),
    })),
    narrative: {
      narration: 'A figure comes in.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  return { context, result: g.applyStoryTurnProposal(state, 'alice', input, turnId, body) };
}

test('a character the story keeps out of the opening is hidden until the story brings them in', () => {
  const state = world({ mode: 'later', hint: 'comes in at dusk' });
  assert.equal(state.entities.keeper, undefined);
  assert.equal(state.npcBrains.keeper, undefined);
  assert.equal(state.offstage.keeper.mode, 'later');
  assert.equal(state.offstage.keeper.entity.x, undefined);
  assert.ok(!g.projectState(state, 'alice').entities.some((entity) => entity.id === 'keeper'));
  const { context } = arrive(state, { x: 9, y: 4 });
  assert.equal(context.establishedRoleplay.offstage[0].id, 'keeper');
  assert.equal(context.establishedRoleplay.offstage[0].arrivesWhen, 'comes in at dusk');
  // Nothing about off-stage characters leaks into the public projection.
  assert.ok(!JSON.stringify(g.projectState(state, 'alice')).includes('comes in at dusk'));
});

test('npc_arrival puts the character where the story says, snapped to free floor, with their brain', () => {
  const state = world({ mode: 'later' });
  const { result } = arrive(state, { x: 9, y: 4 });
  assert.equal(result.error, undefined);
  const keeper = result.state.entities.keeper;
  assert.ok(keeper && Number.isInteger(keeper.x) && Number.isInteger(keeper.y));
  assert.ok(Math.max(Math.abs(keeper.x - 9), Math.abs(keeper.y - 4)) <= 3);
  assert.ok(result.state.npcBrains.keeper);
  assert.equal(result.state.offstage?.keeper, undefined);
  assert.ok(
    g.projectState(result.state, 'alice').entities.some((entity) => entity.id === 'keeper'),
  );
});

test('a god or voice never arrives, and an unknown id is refused', () => {
  const beyond = world({ mode: 'beyond', hint: 'the god of this world' });
  assert.equal(beyond.entities.keeper, undefined);
  assert.equal(arrive(beyond, { x: 9, y: 4 }).context.establishedRoleplay.offstage, undefined);
  assert.equal(
    arrive(beyond, { x: 9, y: 4 }).context.establishedRoleplay.beyond[0].nature,
    'the god of this world',
  );
  assert.ok(arrive(beyond, { x: 9, y: 4 }).result.error);
  assert.ok(arrive(world(), { x: 9, y: 4 }, 'nobody').result.error);
});

test('free roleplay may bring a new character in far from the player, with no picture', () => {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  const mapId = state.entities.alice.mapId,
    map = state.maps[mapId];
  let far;
  for (let y = 1; y < map.height - 1 && !far; y++)
    for (let x = 1; x < map.width - 1 && !far; x++)
      if (
        Math.abs(x - 5) + Math.abs(y - 4) >= 6 &&
        g.walkable(state, mapId, { x, y }, undefined, true) &&
        g.findPath(state, mapId, state.entities.alice, { x, y }, 'alice') &&
        !map.exits.some((e) => e.x === x && e.y === y) &&
        !map.spawns.some((e) => e.x === x && e.y === y) &&
        !Object.values(state.entities).some((e) => e.mapId === mapId && e.x === x && e.y === y)
      )
        far = { x, y };
  assert.ok(far, 'the fixture has a free floor cell far from the player');
  const text = '*I notice a traveller far away on the path.*';
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
  };
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const seed = g.createMockNarrativeProposal(state, 'alice', text, turnId, 'en');
  const body = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action: null,
      reply: null,
      ...(segment.kind === 'attempt' ? { establishedEvents: [] } : {}),
    })),
    narrative: {
      narration: 'A traveller walks the far path.',
      newScene: null,
      newNpc: {
        ...seed.newNpc,
        name: 'Far Traveller',
        roleLabel: 'Traveller',
        placement: 'current',
        spawn: far,
        knownEntityIds: [],
      },
      evidenceIds: [],
    },
  };
  const result = g.applyStoryTurnProposal(state, 'alice', input, turnId, body);
  assert.equal(result.error, undefined);
  const npc = result.state.entities[`support-${turnId}`];
  assert.ok(npc && npc.x === far.x && npc.y === far.y);
  assert.equal(npc.supportingNpc.generated, true);
});
