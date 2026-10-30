import test from 'node:test';
import assert from 'node:assert/strict';
import {
  purgeLivingNpcReferences,
  redactGameOperationSpeech,
} from '../../scripts/game-data-requests.mjs';
import { forceMockNpcTestEnvironment } from '../../scripts/mock-npc-test-env.mjs';

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
