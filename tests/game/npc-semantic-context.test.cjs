const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
function world() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  return g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
}
test('decision fingerprint ignores only the affect scheduler timestamp', () => {
  const state = world();
  state.npcBrains.keeper.living.affect.lastUpdatedTick = 80;
  const before = g.buildNpcDecisionContext(state, 'keeper');
  state.npcBrains.keeper.living.affect.lastUpdatedTick = 120;
  assert.deepEqual(g.buildNpcDecisionContext(state, 'keeper'), before);
  assert.equal('lastUpdatedTick' in before.affect, false);
  // Generic provenance hashing is deliberately NOT weakened.
  assert.notEqual(
    g.npcContextFingerprint({ lastUpdatedTick: 80 }),
    g.npcContextFingerprint({ lastUpdatedTick: 120 }),
  );
  for (const [field, value] of Object.entries({
    fatigue: 9,
    attention: 3,
    alertness: 8,
    mood: 'angry',
  })) {
    const changed = structuredClone(state);
    changed.npcBrains.keeper.living.affect[field] = value;
    assert.notEqual(
      g.buildNpcDecisionContext(changed, 'keeper').contextHash,
      before.contextHash,
      field,
    );
  }
  for (const change of [
    (s) => s.npcBrains.keeper.living.knowledgeRevision++,
    (s) => s.entities.keeper.x++,
    (s) => {
      s.entities.bob.mapId = s.entities.keeper.mapId;
      s.entities.bob.x = s.entities.keeper.x;
      s.entities.bob.y = s.entities.keeper.y;
    },
  ]) {
    const changed = structuredClone(state);
    change(changed);
    assert.notEqual(g.buildNpcDecisionContext(changed, 'keeper').contextHash, before.contextHash);
  }
});
test('actual provider request explains whole-audience disclosure without granting permission', async () => {
  const state = world();
  const context = g.buildNpcDecisionContext(state, 'keeper');
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic',
      model: 'fixture',
      version: 'fixture',
      maxInputBytes: 64000,
      maxOutputTokens: 100,
      maxResponseBytes: 64000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(body.instructions, /participants-only observation/);
      assert.match(
        body.instructions,
        /say reaches all communicationPolicy.publicAudienceIds, not just targetId/,
      );
      assert.match(body.instructions, /planner cannot create disclosure permission/);
      assert.deepEqual(
        JSON.parse(body.input).context.communicationPolicy,
        context.communicationPolicy,
      );
      return new Response(
        JSON.stringify({
          id: 'synthetic-response',
          status: 'completed',
          usage: { input_tokens: 20, output_tokens: 10 },
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    actions: [
                      {
                        kind: 'wait',
                        targetId: null,
                        itemId: null,
                        target: null,
                        channel: null,
                        observationIds: null,
                      },
                    ],
                    beliefRevisions: [],
                  }),
                },
              ],
            },
          ],
        }),
      );
    },
  );
  const result = await provider.generate({
    jobId: 'synthetic',
    purpose: 'plan',
    context: {
      ...context,
      mockProposal: {
        contextRevision: state.revision,
        mapRevision: 1,
        entityRevision: state.entities.keeper.revision,
        brainGeneration: 1,
        deadlineTick: state.tick + 100,
        actions: [{ kind: 'wait' }],
        targetRevisions: {},
      },
    },
    signal: new AbortController().signal,
    maxCostMicros: 100000,
  });
  assert.deepEqual(result.proposal.actions, [{ kind: 'wait' }]);
});
