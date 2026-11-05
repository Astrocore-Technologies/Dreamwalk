import test from 'node:test';
import assert from 'node:assert/strict';
import {
  purgeLivingNpcReferences,
  redactGameHeroIdentity,
  redactTurnControlState,
  redactGameOperationSpeech,
} from '../../scripts/game-data-requests.mjs';
import { forceMockNpcTestEnvironment } from '../../scripts/mock-npc-test-env.mjs';
import { redactNarrativeContent } from '../../scripts/narrative-data-requests.mjs';

test('account erasure clears paraphrased fictional thoughts even without literal actor or evidence IDs', () => {
  for (const redact of [
    (state) => purgeLivingNpcReferences(state, 'erased-player'),
    redactNarrativeContent,
  ]) {
    const state = fixture();
    const memory = state.npcBrains.keeper.living;
    memory.observations = [];
    memory.beliefs = [];
    memory.relationships = {};
    memory.obligations = [];
    memory.causes = [];
    memory.goal = { kind: 'patrol', revision: 1, evidenceIds: [] };
    memory.cognition = {
      innerThought: 'I still remember that visitor’s sensitive story.',
      motive: 'Remember the private conversation',
      audienceIds: ['other'],
    };
    memory.lastActionOutcome = { actionKind: 'wait', status: 'completed', tick: 1 };
    redact(state);
    assert.equal(memory.cognition, undefined);
    assert.equal(memory.lastActionOutcome, undefined);
    assert.doesNotMatch(JSON.stringify(state), /sensitive story|private conversation/);
  }
});

test('test processes cannot inherit approved external NPC credentials or budget', () => {
  const env = {
    NPC_AI_PROVIDER: 'http-json',
    NPC_AI_EXTERNAL_APPROVED: 'true',
    NPC_AI_API_KEY: 'test-secret-not-used',
    NPC_AI_CAP_MICROS: '10000',
    DATABASE_URL: 'preserved-local-test-url',
  };
  assert.deepEqual(forceMockNpcTestEnvironment(env), {
    NPC_AI_PROVIDER: 'mock',
    NPC_AI_EXTERNAL_APPROVED: 'false',
    DATABASE_URL: 'preserved-local-test-url',
  });
});

function fixture() {
  return {
    entities: { keeper: { path: [{ x: 8, y: 2 }], movementGeneration: 4, revision: 2 } },
    npcBrains: {
      keeper: {
        plan: [{ kind: 'move_to', target: { x: 8, y: 2 } }],
        cursor: 0,
        waitingForPath: true,
        generation: 3,
        living: {
          knowledgeRevision: 7,
          observations: [
            { id: 'seen', rootId: 'root-a', actorId: 'erased-player', audienceIds: ['other'] },
            { id: 'retold', rootId: 'root-a', sourceNpcId: 'helper', audienceIds: ['other'] },
            {
              id: 'other-fact',
              rootId: 'root-b',
              actorId: 'other',
              audienceIds: ['erased-player', 'other'],
            },
          ],
          beliefs: [
            { subjectId: 'erased-player', evidenceIds: ['seen'] },
            { subjectId: 'other', evidenceIds: ['other-fact'] },
          ],
          relationships: {
            'erased-player': { trust: -2, evidenceIds: ['seen'] },
            other: { trust: 1, evidenceIds: ['other-fact'] },
          },
          obligations: [
            {
              id: 'old-promise',
              toActorId: 'erased-player',
              itemId: 'token',
              status: 'accepted',
              evidenceIds: ['seen'],
            },
            ...Array.from({ length: 4 }, (_, i) => ({
              id: `kept-${i}`,
              toActorId: 'other',
              itemId: `item-${i}`,
              status: 'accepted',
              evidenceIds: ['other-fact'],
            })),
          ],
          causes: [
            { id: 'cause-a', observationId: 'retold' },
            { id: 'cause-b', observationId: 'other-fact' },
          ],
          goal: { kind: 'investigate', revision: 4, evidenceIds: ['seen'] },
          summary: { observationIds: ['seen', 'other-fact'] },
        },
      },
    },
    npcUtterances: [
      {
        id: 'u1',
        speakerId: 'erased-player',
        text: 'private words',
        audienceIds: ['other'],
        speakerKnownToIds: ['other'],
      },
      {
        id: 'u2',
        speakerId: 'other',
        text: 'erased-player was mentioned',
        audienceIds: ['other'],
        speakerKnownToIds: ['other'],
      },
      {
        id: 'u3',
        speakerId: 'other',
        text: 'unrelated words',
        audienceIds: ['other', 'erased-player'],
        speakerKnownToIds: ['other', 'erased-player'],
      },
    ],
    npcNotices: [
      { id: 'n1', npcId: 'keeper', audienceIds: ['erased-player'] },
      { id: 'n2', npcId: 'keeper', audienceIds: ['erased-player', 'other'] },
    ],
  };
}

test('erasure removes companionship and invalidates its path even in legacy campaigns and archived evidence', () => {
  for (const agreement of [
    {
      actorId: 'erased-player',
      sourceObservationId: 'unrelated',
      utteranceId: 'unrelated-reply',
      crossings: [],
    },
    {
      actorId: 'other',
      sourceObservationId: 'cold-observation',
      utteranceId: 'unrelated-reply',
      crossings: [],
    },
    { actorId: 'other', sourceObservationId: 'unrelated', utteranceId: 'cold-root', crossings: [] },
  ]) {
    const s = fixture();
    s.npcBrains.keeper.living.companionship = agreement;
    const cleaned = purgeLivingNpcReferences(
      s,
      'erased-player',
      ['cold-root'],
      ['cold-observation'],
    );
    assert.equal(cleaned.npcBrains.keeper.living.companionship, undefined);
    assert.deepEqual(cleaned.npcBrains.keeper.plan, []);
    assert.deepEqual(cleaned.entities.keeper.path, []);
  }
});

test('erasure removes personal evidence and hearsay derivatives, retaining others commitments', () => {
  const state = purgeLivingNpcReferences(fixture(), 'erased-player');
  const brain = state.npcBrains.keeper,
    memory = brain.living;
  assert.equal(JSON.stringify(state).includes('erased-player'), false);
  assert.deepEqual(
    memory.observations.map((o) => o.id),
    ['other-fact'],
  );
  assert.deepEqual(memory.observations[0].audienceIds, ['other']);
  assert.deepEqual(Object.keys(memory.relationships), ['other']);
  assert.equal(memory.obligations.length, 4);
  assert.ok(memory.obligations.every((o) => o.status === 'accepted'));
  assert.deepEqual(
    memory.causes.map((c) => c.id),
    ['cause-b'],
  );
  assert.equal(memory.summary, undefined);
  assert.equal(memory.knowledgeRevision, 8);
  assert.equal(memory.goal.kind, 'patrol');
  assert.deepEqual(brain.plan, []);
  assert.equal(brain.waitingForPath, false);
  assert.deepEqual(state.entities.keeper.path, []);
  assert.equal(state.entities.keeper.movementGeneration, 5);
  assert.deepEqual(
    state.npcNotices.map((n) => n.id),
    ['n2'],
  );
});

test('repeated erasure is idempotent and old rulesets without living memory stay unchanged', () => {
  const state = purgeLivingNpcReferences(fixture(), 'erased-player');
  const once = structuredClone(state);
  assert.deepEqual(purgeLivingNpcReferences(state, 'erased-player'), once);
  const old = { entities: {}, npcBrains: { keeper: { facts: [], plan: [] } } };
  assert.deepEqual(purgeLivingNpcReferences(structuredClone(old), 'absent'), old);
  assert.deepEqual(purgeLivingNpcReferences({ erased: true }, 'absent'), { erased: true });
});

test('erasure follows a rumor root across NPCs and from cold archive references', () => {
  const state = fixture();
  state.npcBrains.helper = {
    living: {
      observations: [
        { id: 'heard-by-helper', rootId: 'root-a', sourceNpcId: 'keeper', audienceIds: [] },
        { id: 'old-cold-retelling', rootId: 'cold-root', sourceNpcId: 'keeper', audienceIds: [] },
      ],
      beliefs: [{ subjectId: 'other', evidenceIds: ['heard-by-helper'] }],
      relationships: { other: { trust: -1, evidenceIds: ['old-cold-retelling'] } },
      obligations: [],
      causes: [],
    },
  };
  purgeLivingNpcReferences(state, 'erased-player', ['cold-root']);
  assert.deepEqual(state.npcBrains.helper.living.observations, []);
  assert.deepEqual(state.npcBrains.helper.living.beliefs, []);
  assert.deepEqual(state.npcBrains.helper.living.relationships, {});
});

test('erasure removes paraphrased replies and their heard episodes transitively', () => {
  const state = fixture();
  state.npcUtterances.push({
    id: 'reply',
    speakerId: 'keeper',
    text: 'A paraphrase without the identifier',
    sourceObservationIds: ['seen'],
    audienceIds: ['other'],
    speakerKnownToIds: ['other'],
  });
  state.npcBrains.keeper.living.observations.push({
    id: 'heard-reply',
    rootId: 'reply',
    actorId: 'keeper',
    audienceIds: ['other'],
  });
  state.npcUtterances.push({
    id: 'reply-again',
    speakerId: 'helper',
    text: 'Retold paraphrase',
    sourceObservationIds: ['heard-reply'],
    audienceIds: ['other'],
    speakerKnownToIds: ['other'],
  });
  purgeLivingNpcReferences(state, 'erased-player');
  assert.deepEqual(
    state.npcUtterances.map((u) => u.id),
    ['u3'],
  );
  assert.equal(
    state.npcBrains.keeper.living.observations.some((o) => o.id === 'heard-reply'),
    false,
  );
});

test('retained operation replay removes erased speech even when speaker identity was hidden', () => {
  const response = {
    ok: true,
    revision: 12,
    projection: {
      npcUtterances: [
        { id: 'hidden-speaker', text: 'Personal words' },
        { id: 'visible-speaker', speakerId: 'erased-player', text: 'More personal words' },
        { id: 'kept', speakerId: 'other', text: 'Unrelated words' },
      ],
    },
  };
  assert.deepEqual(
    redactGameOperationSpeech(response, 'erased-player', new Set(['hidden-speaker'])),
    {
      ok: true,
      revision: 12,
      projection: { npcUtterances: [{ id: 'kept', speakerId: 'other', text: 'Unrelated words' }] },
    },
  );
});

test('erasure strips original promise speech but preserves another recipient commitment', () => {
  const state = fixture();
  const promise = state.npcBrains.keeper.living.obligations[1];
  promise.sourceUtteranceId = 'u1';
  promise.sourceUtterance = 'PERSONAL_REQUEST_WITHOUT_IDENTIFIER';
  promise.evidenceIds = ['seen'];
  const cleaned = purgeLivingNpcReferences(state, 'erased-player');
  const retained = cleaned.npcBrains.keeper.living.obligations.find((p) => p.id === promise.id);
  assert.equal(retained.status, 'accepted');
  assert.equal(retained.toActorId, 'other');
  assert.equal(retained.sourceUtterance, undefined);
  assert.equal(retained.sourceUtteranceId, undefined);
  assert.deepEqual(retained.evidenceIds, []);
  assert.ok(!JSON.stringify(cleaned).includes('PERSONAL_REQUEST_WITHOUT_IDENTIFIER'));
});

test('text-free compacted provenance still erases derived reply roots', () => {
  const state = {
    npcProvenance: {
      observations: [
        { id: 'old-input', rootId: 'input-root', eventId: 'event-input', actorId: 'erased-player' },
      ],
      utterances: [{ id: 'old-reply', speakerId: 'keeper', sourceObservationIds: ['old-input'] }],
    },
    npcBrains: {
      helper: {
        living: {
          observations: [
            {
              id: 'retelling',
              rootId: 'old-reply',
              eventId: 'later',
              actorId: 'keeper',
              audienceIds: ['other'],
            },
          ],
          beliefs: [],
          relationships: {},
          obligations: [],
          causes: [],
          goal: { kind: 'patrol' },
          knowledgeRevision: 1,
        },
        plan: [],
      },
    },
    npcUtterances: [
      {
        id: 'next-reply',
        speakerId: 'helper',
        sourceObservationIds: ['retelling'],
        text: 'paraphrase',
        audienceIds: ['other'],
      },
    ],
  };
  const cleaned = purgeLivingNpcReferences(state, 'erased-player');
  assert.deepEqual(cleaned.npcProvenance.observations, []);
  assert.deepEqual(cleaned.npcProvenance.utterances, []);
  assert.deepEqual(cleaned.npcBrains.helper.living.observations, []);
  assert.deepEqual(cleaned.npcUtterances, []);
});

test('narrative erasure clears paraphrased generated content while preserving shared topology and possessions', async () => {
  const { redactNarrativeContent } = await import('../../scripts/narrative-data-requests.mjs');
  const secret = 'PERSONAL_STORY_INPUT';
  const state = fixture();
  state.maps = {
    original: {
      id: 'original',
      label: 'Protected original',
      exits: [{ id: 'link', destinationMapId: 'scene-a', label: secret }],
    },
    'scene-a': {
      id: 'scene-a',
      label: secret,
      width: 10,
      height: 8,
      blocked: [{ x: 0, y: 0 }],
      exits: [],
    },
  };
  state.entities['support-a'] = {
    id: 'support-a',
    kind: 'npc',
    label: secret,
    mapId: 'scene-a',
    x: 4,
    y: 4,
    supportingNpc: {
      generated: true,
      roleId: 'director-secondary',
      roleLabel: secret,
      description: secret,
      appearance: secret,
      personalitySummary: secret,
    },
  };
  state.entities.key = { id: 'key', kind: 'item', ownerId: 'other-player' };
  state.narrativeCanon = {
    revision: 2,
    turns: [
      {
        id: 'a',
        actorId: 'erased-player',
        narration: secret,
        evidenceIds: ['private'],
        introducedScene: { id: 'scene-a', name: secret, description: secret },
        introducedNpc: { id: 'support-a', name: secret, roleLabel: secret },
      },
      { id: 'b', actorId: 'other-player', narration: secret, evidenceIds: ['a'] },
    ],
  };
  state.npcBrains.keeper.living.observations.push({
    id: 'paraphrase',
    text: secret,
    rootId: 'unknown-derived',
  });
  const clean = redactNarrativeContent(state);
  assert.equal(JSON.stringify(clean).includes(secret), false);
  assert.equal(clean.maps.original.label, 'Protected original');
  assert.deepEqual(clean.maps['scene-a'].blocked, [{ x: 0, y: 0 }]);
  assert.equal(clean.entities.key.ownerId, 'other-player');
  assert.equal(clean.entities['support-a'].id, 'support-a');
  assert.equal(clean.narrativeCanon.turns.length, 2);
  assert.equal(clean.narrativeCanon.revision, 2);
  assert.deepEqual(clean.npcBrains.keeper.living.observations, []);
});

test('retained other-player operation projections lose narrative text and generated labels too', async () => {
  const { redactNarrativeContent } = await import('../../scripts/narrative-data-requests.mjs');
  const result = {
    projection: {
      narrative: { revision: 3, turns: [{ id: 'turn', narration: 'PERSONAL_REPLAY_TEXT' }] },
      map: { id: 'scene-a', label: 'PERSONAL_REPLAY_TEXT' },
      npcUtterances: [{ id: 'derived', text: 'PERSONAL_REPLAY_TEXT' }],
      npcObligations: [
        { id: 'promise', sourceUtterance: 'PERSONAL_REPLAY_TEXT', status: 'accepted' },
      ],
    },
  };
  const clean = redactNarrativeContent(result);
  assert.equal(JSON.stringify(clean).includes('PERSONAL_REPLAY_TEXT'), false);
  assert.equal(clean.projection.npcObligations[0].status, 'accepted');
  assert.equal(clean.projection.narrative.revision, 3);
});

test('confirmed erasure removes turn membership, pending reactions, deferred refs and private visual metadata', async () => {
  const g = await import('@dreamwalk/game-core');
  let state = g.initializeTurnController(g.createObservatoryState(['erased-player', 'other']), [
    'erased-player',
    'other',
  ]).state;
  Object.assign(state.entities['erased-player'], {
    x: 2,
    y: 3,
    label: 'PRIVATE_HERO_NAME',
    characterPackageVersionId: 'PRIVATE_PACK',
    feedback: { kind: 'hit', sequence: 7, dx: 1, dy: 0 },
    movementTrace: {
      sequence: 6,
      points: [
        { x: 2, y: 2 },
        { x: 2, y: 3 },
      ],
    },
  });
  Object.assign(state.entities.other, { x: 3, y: 3 });
  state.turnController.resources.other.additional = 0;
  state = g.applyTurnAction(
    state,
    'erased-player',
    { kind: 'hit', targetId: 'other' },
    g.turnFence(state),
  ).state;
  assert.equal(state.turnController.phase, 'reaction');
  state.turnController.deferredSpeech = [
    {
      id: 'private-queue',
      actorId: 'erased-player',
      recipientId: 'keeper',
      utteranceId: 'private-source',
      channel: 'whisper',
      audienceIds: ['erased-player', 'keeper'],
      sequence: 1,
      roundId: 'round-1',
      phaseEpoch: 1,
    },
  ];
  state.artBindings = [
    { slot: 'entity:erased-player:sprite', revisionId: 'private-face' },
    { slot: 'entity:other:sprite', revisionId: 'other-face' },
  ];
  const cleaned = redactGameHeroIdentity(state, 'erased-player');
  assert.deepEqual(cleaned.turnController.actorOrder, ['other']);
  assert.equal(cleaned.turnController.activeActorId, 'other');
  assert.equal(cleaned.turnController.resources['erased-player'], undefined);
  assert.equal(cleaned.turnController.resources.other.additional, 0);
  assert.equal(cleaned.entities.other.x, 3);
  assert.equal(cleaned.turnController.pendingResolution, undefined);
  assert.equal(cleaned.turnController.reaction, undefined);
  assert.deepEqual(cleaned.turnController.deferredSpeech, []);
  assert.deepEqual(cleaned.artBindings, [
    { slot: 'entity:other:sprite', revisionId: 'other-face' },
  ]);
  assert.equal(cleaned.entities['erased-player'].feedback, undefined);
  assert.equal(cleaned.entities['erased-player'].movementTrace, undefined);
  assert.equal(cleaned.entities['erased-player'].label, undefined);
  assert.equal(cleaned.entities['erased-player'].characterPackageVersionId, undefined);
});

test('erasure cancels dangling deferred jobs and removes erased turn metadata from retained projections', async () => {
  const g = await import('@dreamwalk/game-core');
  const state = g.initializeTurnController(g.createObservatoryState(['erased-player', 'other']), [
    'erased-player',
    'other',
  ]).state;
  state.turnController.deferredSpeech = [
    {
      id: 'other-queue',
      actorId: 'other',
      recipientId: 'keeper',
      utteranceId: 'safe-source',
      channel: 'say',
      audienceIds: ['other', 'keeper'],
      sequence: 2,
      roundId: 'round-1',
      phaseEpoch: 1,
    },
  ];
  const epoch = state.turnController.phaseEpoch;
  redactTurnControlState(state, 'erased-player', { cancelAllDeferred: true });
  assert.deepEqual(state.turnController.deferredSpeech, []);
  assert.ok(state.turnController.phaseEpoch > epoch);
  const retained = {
    projection: {
      actorId: 'other',
      turn: {
        activeActorId: 'erased-player',
        actorOrder: ['erased-player', 'other'],
        phase: 'player',
      },
      entities: [
        { id: 'other', kind: 'player', feedback: { kind: 'push', sequence: 8, dx: 1, dy: 0 } },
      ],
    },
  };
  redactGameHeroIdentity(retained, 'erased-player');
  assert.equal(retained.projection.turn, undefined);
  assert.equal(retained.projection.entities[0].feedback, undefined);
});

test('erasing a speaker removes their retained subjective relationship and text fingerprints', () => {
  const state = fixture();
  const relation = state.npcBrains.keeper.living.relationships['erased-player'];
  relation.evidenceIds = [];
  relation.social = {
    audienceIds: ['erased-player', 'keeper'],
    lastObservedTick: 42,
    recentTextKeys: ['derived-private-key'],
  };
  relation.character = { affinity: 3, respect: 2, fear: 0 };
  purgeLivingNpcReferences(state, 'erased-player');
  assert.equal(state.npcBrains.keeper.living.relationships['erased-player'], undefined);
  assert.doesNotMatch(JSON.stringify(state), /derived-private-key/);
});

test('erasing a former listener narrows cumulative social audience without making it public', () => {
  const state = fixture();
  state.npcBrains.keeper.living.relationships.other.evidenceIds = [];
  state.npcBrains.keeper.living.relationships.other.social = {
    audienceIds: ['erased-player'],
    lastObservedTick: 4,
    recentTextKeys: [],
  };
  purgeLivingNpcReferences(state, 'erased-player');
  assert.deepEqual(state.npcBrains.keeper.living.relationships.other.social.audienceIds, []);
});
