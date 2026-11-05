const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const {
  npcThoughtAudience,
  stampNpcThoughtAudience,
  projectNpcInnerThought,
} = require('../../apps/api/dist/game/npc-thought-access');
const thought = {
  motive: 'Watch the room',
  belief: 'They may need time',
  intent: 'Wait',
  innerThought: 'I will watch the doorway for a moment.',
  reconsiderAfterRounds: 1,
  roundId: 'round-1',
  roundNumber: 1,
  tick: 0,
  knowledgeRevision: 1,
};
function world() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, {
    x: state.entities.keeper.x,
    y: state.entities.keeper.y + 1,
  });
  Object.assign(state.entities.bob, { x: state.entities.keeper.x + 1, y: state.entities.keeper.y });
  state.npcBrains.keeper.living.cognition = { ...thought };
  return state;
}
const observation = (id, disclosure, audienceIds = []) => ({
  id,
  disclosure,
  audienceIds,
  kind: 'said',
  text: `Private content ${id}`,
});

test('public fictional thought allows both players; all other private state remains excluded', () => {
  const s = world();
  const context = { observations: [observation('public', 'public')], history: [] };
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'plan', context), ['alice', 'bob']);
  const stamped = stampNpcThoughtAudience(s, 'keeper', 'plan', context);
  assert.equal(s.npcBrains.keeper.living.cognition.audienceIds, undefined);
  assert.deepEqual(projectNpcInnerThought(stamped, 'alice', 'keeper'), {
    npcId: 'keeper',
    thought: {
      text: thought.innerThought,
      roundId: 'round-1',
      roundNumber: 1,
      tick: 0,
    },
  });
  assert.equal(
    JSON.stringify(g.projectState(stamped, 'alice')).includes(thought.innerThought),
    false,
  );
  assert.equal(
    JSON.stringify(projectNpcInnerThought(stamped, 'alice', 'keeper')).includes(thought.motive),
    false,
  );
});

test('thought from one whisper is readable only by that participant, never by owner privilege', () => {
  const s = world();
  const context = { observations: [observation('whisper', 'participants', ['alice', 'keeper'])] };
  const stamped = stampNpcThoughtAudience(s, 'keeper', 'plan', context);
  assert.deepEqual(stamped.npcBrains.keeper.living.cognition.audienceIds, ['alice']);
  assert.equal(
    projectNpcInnerThought(stamped, 'alice', 'keeper').thought.text,
    thought.innerThought,
  );
  assert.throws(() => projectNpcInnerThought(stamped, 'bob', 'keeper'), /FORBIDDEN/);
});

test('mixed whispers, private facts, malformed source records and unresolved evidence fail closed', () => {
  const s = world();
  for (const context of [
    {
      observations: [
        observation('a', 'participants', ['alice', 'keeper']),
        observation('b', 'participants', ['bob', 'keeper']),
      ],
    },
    { observations: [observation('secret', 'private', ['keeper'])] },
    { observations: [{ id: 'missing-disclosure', text: 'not authorized' }] },
    { summary: { narrative: 'Derived text', observationIds: ['unavailable-source'] } },
    { relationships: { alice: { evidenceIds: ['unavailable-source'] } } },
    { previousCognition: { ...thought } },
  ])
    assert.deepEqual(npcThoughtAudience(s, 'keeper', 'plan', context), []);
});

test('packed and archived inputs plus previous thought preserve the most restrictive source ACL', () => {
  const s = world();
  const whisper = observation('old-whisper', 'participants', ['alice', 'keeper']);
  const context = {
    observations: [],
    archivedEpisodes: [whisper],
    summary: { observationIds: ['old-whisper'] },
    previousCognition: { ...thought, audienceIds: ['alice'] },
    textContextCandidate: { history: [whisper] },
  };
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'plan', context), ['alice']);
  context.textContextCandidate.history.push(observation('b', 'participants', ['bob', 'keeper']));
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'plan', context), []);
});

test('safe speech thought inherits only the already authorized speech audience', () => {
  const s = world();
  const context = {
    audienceIds: ['keeper', 'alice'],
    claims: [{ observationId: 'authorized', untrustedUtterance: 'Hello' }],
  };
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'speech', context), ['alice']);
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'speech', {}), []);
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'story_turn', context), []);
});

test('private authored personality and lore require source-author access, not campaign ownership', () => {
  const s = world();
  for (const context of [
    { personality: { biography: 'A private backstory secret.' }, observations: [] },
    { observations: [{ ...observation('lore', 'private', ['keeper']), kind: 'authored_fact' }] },
    {
      previousCognition: { ...thought, audienceIds: ['alice', 'bob'], requiresSourceAuthor: true },
    },
  ]) {
    const stamped = stampNpcThoughtAudience(s, 'keeper', 'plan', context);
    assert.equal(stamped.npcBrains.keeper.living.cognition.requiresSourceAuthor, true);
    assert.throws(() => projectNpcInnerThought(stamped, 'alice', 'keeper'), /FORBIDDEN/);
    assert.equal(
      projectNpcInnerThought(stamped, 'alice', 'keeper', true).thought.text,
      thought.innerThought,
    );
  }
});

test('source author never bypasses another player private whisper or mixed audience', () => {
  const s = world();
  const context = {
    personality: { biography: 'Owned authored secret' },
    observations: [observation('bobs-whisper', 'participants', ['bob', 'keeper'])],
  };
  const stamped = stampNpcThoughtAudience(s, 'keeper', 'plan', context);
  assert.throws(() => projectNpcInnerThought(stamped, 'alice', 'keeper', true), /FORBIDDEN/);
  assert.throws(() => projectNpcInnerThought(stamped, 'bob', 'keeper', false), /FORBIDDEN/);
  assert.equal(
    projectNpcInnerThought(stamped, 'bob', 'keeper', true).thought.text,
    thought.innerThought,
  );
});

test('missing legacy ACL and no-longer-visible NPC never expose stored thought', () => {
  const s = world();
  assert.throws(() => projectNpcInnerThought(s, 'alice', 'keeper'), /FORBIDDEN/);
  s.npcBrains.keeper.living.cognition.audienceIds = ['alice'];
  s.entities.keeper.mapId = 'unseen-map';
  assert.throws(() => projectNpcInnerThought(s, 'alice', 'keeper'), /FORBIDDEN/);
  assert.throws(() => projectNpcInnerThought(s, 'another-player', 'keeper'), /FORBIDDEN/);
});

test('cumulative social feelings retain their whisper audience after source IDs leave the window', () => {
  const s = world();
  const context = {
    observations: [observation('new-public', 'public')],
    relationships: {
      alice: {
        trust: 0,
        evidenceIds: ['new-public'],
        character: { affinity: 2, respect: 1, fear: 0 },
        social: {
          audienceIds: ['alice', 'keeper'],
          lastObservedTick: 50,
          recentTextKeys: ['opaque-fingerprint'],
        },
      },
    },
  };
  assert.deepEqual(npcThoughtAudience(s, 'keeper', 'plan', context), ['alice']);
  const stamped = stampNpcThoughtAudience(s, 'keeper', 'plan', context);
  assert.throws(() => projectNpcInnerThought(stamped, 'bob', 'keeper'), /FORBIDDEN/);
});
