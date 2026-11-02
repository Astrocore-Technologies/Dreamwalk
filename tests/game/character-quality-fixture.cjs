const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');

const profiles = [
  {
    id: 'keeper',
    name: 'Северин',
    role: 'guard',
    motive: 'duty',
    response: 'refuse',
    stance: 'firm',
    cadence: 'brief',
    register: 'formal',
    humor: 'dry',
  },
  {
    id: 'mira',
    name: 'Мира',
    role: 'helper',
    motive: 'care',
    response: 'assist',
    stance: 'friendly',
    cadence: 'balanced',
    register: 'plain',
    humor: 'playful',
  },
  {
    id: 'orin',
    name: 'Орин',
    role: 'patrol',
    motive: 'discover',
    response: 'observe',
    stance: 'reserved',
    cadence: 'elaborate',
    register: 'formal',
    humor: 'none',
  },
];

function fixture() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  draft.npcs = profiles.map((p, index) => ({
    id: p.id,
    label: p.name,
    mapId: 'courtyard',
    x: 4 + index,
    y: index === 1 ? 4 : 5,
    visual: 'traveler',
    goal: p.response === 'assist' ? 'help' : 'patrol',
    patrolTarget: { x: 4 + index, y: index === 1 ? 4 : 5 },
    personality: {
      role: p.role,
      values: [p.motive === 'care' ? 'kindness' : 'caution'],
      taboos: ['disclose_private'],
      speechStyle: 'private-style-canary',
      biography: `private-biography-${p.id}`,
      characterization: {
        version: 1,
        motives: [{ kind: p.motive, priority: 5 }],
        reactions: [{ trigger: 'request', response: p.response, publicStance: p.stance }],
        publicVoice: { cadence: p.cadence, register: p.register, humor: p.humor },
        dialogueExamples: [{ situation: 'refusal', text: `private-example-${p.id}` }],
      },
    },
    initialFacts: [
      {
        id: `secret-${p.id}`,
        title: `Hidden ${p.id}`,
        text: `secret-canary-${p.id}`,
        disclosure: 'never',
      },
    ],
  }));
  draft.objects.find((o) => o.id === 'token').ownerNpcId = 'mira';
  Object.assign(
    draft.objects.find((o) => o.id === 'key'),
    { x: 5, y: 6 },
  );
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const state = g.createStateFromPlayable(compiled.playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.bob, { x: 2, y: 2 });
  return { draft, state };
}

function addressed(state, npcId) {
  const result = g.applyAction(state, 'alice', { kind: 'talk', targetId: npcId });
  assert.equal(result.error, undefined);
  return g.recordNpcEvents(state, result.state, result.events, `address-${npcId}`).state;
}

function evaluateCharacterQuality() {
  const checks = [];
  const check = (id, fn) => {
    fn();
    checks.push({ id, result: 'pass' });
  };
  let { state } = fixture();
  for (const p of profiles) state = addressed(state, p.id);
  check('three-distinct-authored-characters-survive-compilation', () => {
    assert.equal(
      new Set(
        profiles.map((p) =>
          JSON.stringify(state.npcBrains[p.id].living.personality.characterization),
        ),
      ).size,
      3,
    );
    for (const p of profiles) {
      const context = g.buildNpcDecisionContext(state, p.id);
      assert.equal(context.personality.characterization.motives[0].kind, p.motive);
      assert.ok(JSON.stringify(context).includes(`private-example-${p.id}`));
      for (const other of profiles.filter((v) => v.id !== p.id))
        assert.equal(JSON.stringify(context).includes(`secret-canary-${other.id}`), false);
    }
  });
  check('public-performance-is-distinct-and-does-not-copy-private-text', () => {
    const voices = profiles.map((p) => {
      const memory = state.npcBrains[p.id].living;
      const evidence = memory.observations
        .filter((o) => o.kind === 'addressed' && o.actorId === 'alice')
        .map((o) => o.id);
      const context = g.buildNpcPublicSpeechContext(state, p.id, [p.id, 'alice'], evidence);
      assert.equal(context.performance.cadence, p.cadence);
      assert.equal(context.performance.stance, p.stance);
      const serialized = JSON.stringify(context);
      for (const marker of [
        'secret-canary-',
        'private-example-',
        'private-biography-',
        'private-style-canary',
      ])
        assert.equal(serialized.includes(marker), false, marker);
      return context.performance;
    });
    assert.equal(new Set(voices.map((v) => JSON.stringify(v))).size, 3);
  });
  check('restart-retains-character-and-separate-knowledge', () => {
    const restored = JSON.parse(JSON.stringify(state));
    for (const p of profiles)
      assert.deepEqual(
        JSON.parse(JSON.stringify(g.buildNpcDecisionContext(restored, p.id))),
        JSON.parse(JSON.stringify(g.buildNpcDecisionContext(state, p.id))),
      );
    for (const player of ['alice', 'bob']) {
      const visible = JSON.stringify(g.projectState(restored, player));
      assert.equal(visible.includes('secret-canary-'), false);
      assert.equal(visible.includes('private-example-'), false);
    }
  });
  check('different-motives-produce-different-committed-behavior-and-kept-promise', () => {
    let next = g.stepLivingNpcs(JSON.parse(JSON.stringify(state))).state;
    assert.equal(next.npcBrains.keeper.living.obligations.length, 0);
    assert.equal(next.npcBrains.orin.living.obligations.length, 0);
    assert.equal(next.npcBrains.mira.living.obligations.length, 1);
    assert.equal(next.npcBrains.mira.living.obligations[0].toActorId, 'alice');
    assert.equal(next.entities.token.ownerId, 'mira');
    next = JSON.parse(JSON.stringify(next));
    for (let i = 0; i < 30; i++) {
      const tick = g.tick(next);
      next = g.recordNpcEvents(next, tick.state, tick.events, `quality-tick-${i}`).state;
      next = g.stepLivingNpcs(next).state;
      for (const p of profiles) {
        const step = g.stepNpcPlan(next, p.id);
        next = g.recordNpcEvents(next, step.state, step.events, `quality-step-${i}-${p.id}`).state;
      }
    }
    assert.equal(next.entities.token.ownerId, 'alice');
    assert.equal(next.entities.alice.inventory.filter((id) => id === 'token').length, 1);
    assert.equal(next.npcBrains.mira.living.obligations[0].status, 'fulfilled');
    assert.equal(next.npcBrains.mira.living.relationships.bob, undefined);
  });
  check('an-unconfirmed-player-attempt-does-not-become-fact', () => {
    const original = JSON.stringify(state);
    const proposal = g.proposePlayerTextIntent(state, 'alice', 'take key');
    assert.ok(proposal);
    assert.equal(JSON.stringify(state), original);
    assert.equal(g.confirmPlayerTextIntent(state, 'alice', proposal, false).error, 'FORBIDDEN');
  });
  check('private-fact-name-does-not-grant-disclosure', () => {
    for (const p of profiles) {
      const memory = state.npcBrains[p.id].living;
      const secret = memory.observations.filter((o) => o.kind === 'authored_fact').map((o) => o.id);
      const context = g.buildNpcPublicSpeechContext(
        state,
        p.id,
        [p.id, 'alice', 'bob'],
        secret,
        secret,
      );
      assert.equal(JSON.stringify(context).includes('secret-canary-'), false);
    }
  });
  return {
    schemaVersion: 1,
    mode: 'deterministic-no-provider',
    externalRequests: 0,
    costMicros: 0,
    naturalLanguageQuality: 'not_measured',
    checks,
  };
}

module.exports = { fixture, profiles, addressed, evaluateCharacterQuality };
