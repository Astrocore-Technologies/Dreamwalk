import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qualityAssessment,
  newAuthorizedJob,
  speechQualityTurn,
  narrativeQualityTurn,
  linkQualityReceipts,
} from '../scripts/live-story/quality-report.mjs';

test('per-question speech evidence records only new target replies, with no phrase-based grading', () => {
  for (const alias of ['Медный сад', 'Azure lantern', 'Тиха ріка']) {
    const before = [{ id: 'old', speakerId: 'npc-a', tick: 1, text: 'An earlier reply' }];
    const result = speechQualityTurn({
      input: `What did we call ${alias}?`,
      npc: { id: 'npc-a', label: 'Neri', supportingNpc: { roleLabel: 'Restorer' } },
      before,
      after: [
        ...before,
        { id: 'other', speakerId: 'npc-b', tick: 2, text: 'Other NPC answer' },
        {
          id: 'new',
          speakerId: 'npc-a',
          tick: 3,
          text: `You called it ${alias}.`,
          sourceObservationIds: ['PRIVATE'],
          audienceIds: ['PRIVATE'],
        },
      ],
      decisionRequestId: 'decision',
      operationId: 'operation',
      job: { jobId: 'job' },
    });
    assert.equal(result.input, `What did we call ${alias}?`);
    assert.deepEqual(result.outputs, [
      { id: 'new', tick: 3, text: `You called it ${alias}.`, code: null },
    ]);
    assert.equal(result.semanticGrade, 'unreviewed');
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(result.decisionRequestId, 'decision');
  }
});
test('missing or ambiguous job correlation stays unresolved instead of guessing by order', () => {
  assert.equal(newAuthorizedJob([], [{ id: 'a', purpose: 'speech' }], 'speech').jobId, 'a');
  assert.equal(
    newAuthorizedJob([{ id: 'a' }], [{ id: 'a', purpose: 'speech' }], 'speech').jobId,
    null,
  );
  assert.equal(
    newAuthorizedJob(
      [],
      [
        { id: 'a', purpose: 'speech' },
        { id: 'b', purpose: 'speech' },
      ],
      'speech',
    ).jobId,
    null,
  );
  assert.equal(newAuthorizedJob([], [{ id: 'a', purpose: 'narrative' }], 'speech').jobId, null);
});
test('receipt linkage requires one exact job ID and excludes unrelated ledger material', () => {
  const [result] = linkQualityReceipts(
    [{ jobId: 'j', semanticGrade: 'unreviewed' }],
    [
      { jobId: 'other', state: 'known' },
      {
        jobId: 'j',
        state: 'known',
        responseId: 'response',
        costMicros: 2,
        rawHeaders: 'SECRET',
        prompt: 'SECRET',
      },
    ],
  );
  assert.equal(result.receiptLink, 'exact_job_id');
  assert.equal(result.receipt.responseId, 'response');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(linkQualityReceipts([{ jobId: 'missing' }], [])[0].receipt, null);
  assert.equal(
    linkQualityReceipts([{ jobId: 'j' }], [{ jobId: 'j' }, { jobId: 'j' }])[0].receipt,
    null,
  );
});
test('director input and confirmed IDs are retained, semantic evaluation remains separate', () => {
  const turn = narrativeQualityTurn({
    input: 'Investigate the existing signal',
    result: {
      id: 'turn',
      operationId: 'op',
      sceneId: 'scene',
      npcId: 'npc',
      narration: 'A new passage is open.',
    },
    job: { jobId: 'j' },
  });
  assert.equal(turn.input, 'Investigate the existing signal');
  assert.equal(turn.decisionRequestId, 'turn');
  assert.equal(turn.semanticGrade, 'unreviewed');
  assert.equal(qualityAssessment(true).status, 'not_evaluated_fixture');
  assert.equal(qualityAssessment(false).status, 'pending_human_review');
  assert.ok(qualityAssessment(false).dimensions.includes('actionable_next_step'));
});
