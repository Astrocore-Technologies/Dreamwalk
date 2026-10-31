import test from 'node:test';
import assert from 'node:assert/strict';
import { packNpcContext } from '../../apps/api/src/game/npc-context-budget.ts';
test('context packing trims whole optional episodes while preserving question and obligation evidence', () => {
  const input = {
    npcId: 'keeper',
    goal: { evidenceIds: ['critical'] },
    obligations: [{ id: 'promise', evidenceIds: ['promise-evidence'] }],
    observations: [
      { id: 'critical', kind: 'item_taken', text: 'critical fact' },
      { id: 'promise-evidence', kind: 'addressed', text: 'accepted promise' },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `old-${i}`,
        kind: 'noise',
        text: 'x'.repeat(200),
      })),
      { id: 'question', kind: 'said', text: 'current untrusted question' },
    ],
    archivedEpisodes: Array.from({ length: 16 }, (_, i) => ({
      id: `cold-${i}`,
      text: 'y'.repeat(300),
    })),
    beliefs: [{ evidenceIds: ['critical'] }, { evidenceIds: ['old-11'] }],
    summary: { narrative: 'optional'.repeat(50) },
  };
  const packed = packNpcContext(input, 1200);
  assert.equal(packed.budgetExceeded, false);
  assert.ok(packed.observations.some((o) => o.id === 'critical'));
  assert.ok(packed.observations.some((o) => o.id === 'promise-evidence'));
  assert.ok(packed.observations.some((o) => o.id === 'question'));
  assert.equal(packed.archivedEpisodes.length, 0);
  assert.ok(
    packed.beliefs.every((b) =>
      b.evidenceIds.every((id) => packed.observations.some((o) => o.id === id)),
    ),
  );
  assert.deepEqual(packed, packNpcContext(input, 1200));
  assert.equal(input.archivedEpisodes.length, 16);
});
test('speech packing keeps asked facts and literal current question; inadequate allowance fails closed', () => {
  const input = {
    npcId: 'keeper',
    requestedFactIds: ['asked'],
    claims: [
      { observationId: 'optional', untrustedUtterance: 'old'.repeat(100) },
      { observationId: 'asked', authoredFact: { text: 'approved answer' } },
      { observationId: 'current', untrustedUtterance: 'QUESTION '.repeat(100) },
    ],
  };
  const packed = packNpcContext(input, 200);
  assert.equal(packed.budgetExceeded, true);
  assert.ok(packed.claims.some((c) => c.observationId === 'asked'));
  assert.equal(
    packed.claims.find((c) => c.observationId === 'current').untrustedUtterance,
    input.claims[2].untrustedUtterance,
  );
  assert.ok(!packed.claims.some((c) => c.observationId === 'optional'));
});
test('explicit reply marker protects its authorized claim even when facts and later utterances reorder the window', () => {
  const trigger = {
    observationId: 'exact-question',
    kind: 'said',
    untrustedUtterance: 'What phrase did I tell you?',
  };
  const input = {
    replyToObservationId: trigger.observationId,
    currentUtterance: trigger,
    requestedFactIds: [],
    claims: [
      trigger,
      ...Array.from({ length: 12 }, (_, i) => ({
        observationId: `other-${i}`,
        untrustedUtterance: 'x'.repeat(i === 11 ? 1500 : 150),
      })),
    ],
  };
  const result = packNpcContext(input, 700);
  assert.equal(result.budgetExceeded, false);
  assert.ok(result.claims.some((c) => c.observationId === trigger.observationId));
  assert.deepEqual(result.currentUtterance, trigger);
  const changed = packNpcContext({ ...input, replyToObservationId: 'other-1' }, 700);
  assert.notEqual(result.contextHash, changed.contextHash);
});

test('oversized bound utterance fails the context budget without truncating required evidence', () => {
  const trigger = { observationId: 'bound-question', untrustedUtterance: 'Q'.repeat(2000) };
  const packed = packNpcContext(
    { replyToObservationId: trigger.observationId, currentUtterance: trigger, claims: [trigger] },
    500,
  );
  assert.equal(packed.budgetExceeded, true);
  assert.deepEqual(packed.claims, [trigger]);
  assert.deepEqual(packed.currentUtterance, trigger);
});
