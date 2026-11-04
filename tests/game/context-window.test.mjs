/** Offline synthetic counting/transport only; no key, .env, network or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  measureTextContext,
  assertTextContext,
  contextWindow,
} from '../../apps/api/src/ai/text-context.ts';
import { estimateTextRequest } from '../../apps/api/src/generation/estimates.ts';
import { readOwnerGenerationConfig } from '../../apps/api/src/generation/config.ts';
import { OpenAiNpcProvider } from '../../apps/api/src/ai/openai-provider.ts';
import { packNpcContextWindow } from '../../apps/api/src/game/npc-context-budget.ts';
import {
  extendContextHistory,
  reuseFrozenContext,
} from '../../apps/api/src/game/context-history.ts';
import { requestEstimateOwnerProfile, ownerEnvironment } from '../images/owner-config-fixture.mjs';
const parsed = (change = {}) => {
  const p = requestEstimateOwnerProfile();
  Object.assign(p.text, { contextBudgetTokens: 256000, ...change });
  return readOwnerGenerationConfig(ownerEnvironment(p));
};
const config = (change) => ({
  enabled: true,
  apiKey: 'synthetic-only',
  model: 'synthetic-token-model',
  version: 'context-v1',
  maxInputBytes: 64000,
  maxModelInputTokens: 1050000,
  maxOutputTokens: 2048,
  maxResponseBytes: 128000,
  inputMicrosPerMillion: 250000,
  outputMicrosPerMillion: 750000,
  contextBudgetTokens: 256000,
  estimation: {
    kind: 'operator_heuristic',
    textTokensPerKiBUtf8: 1024,
    textProtocolTokens: 4096,
    marginBps: 2500,
    fixedMarginMicros: 1000,
  },
  ...change,
});
const noNetwork = async () => {
  assert.fail('No provider request is authorized');
};
// Deliberately fake deterministic model counter: never presented as a real GPT tokenizer.
const exactFixture = {
  id: 'synthetic-four-bytes-v1',
  precision: 'exact',
  supports: (model) => model === 'synthetic-token-model',
  countInput: (body) => Math.ceil(Buffer.byteLength(body) / 4),
};
test('requested context, model capacity and reply are independent; a smaller model visibly limits the window', () => {
  const p = parsed();
  assert.equal(p.text.contextTokens, 131072); // original synthetic fixture capability
  assert.equal(p.text.contextBudgetTokens, 256000);
  assert.equal(p.text.maxInputBytes, 4194304);
  const window = contextWindow(p.text);
  assert.equal(window.requestedContextTokens, 256000);
  assert.equal(window.effectiveContextTokens, 131072);
  assert.equal(window.reservedOutputTokens, p.text.maxOutputTokens);
  assert.doesNotThrow(() => parsed({ contextBudgetTokens: 512000 }));
  assert.throws(
    () => parsed({ contextBudgetTokens: Number.MAX_SAFE_INTEGER + 1 }),
    /OWNER_GENERATION_CONFIG_INVALID/,
  );
  assert.throws(
    () => parsed({ contextTokens: 1024, contextBudgetTokens: 1024, maxOutputTokens: 1024 }),
    /OWNER_GENERATION_CONFIG_INVALID/,
  );
});
test('130k UTF8 bytes grow toward the 256k estimated-token window without the old 64KiB gate', () => {
  const p = { ...parsed().text, contextTokens: 1050000, maxOutputTokens: 2048 };
  const first = estimateTextRequest('x'.repeat(130000), p, 'fixture');
  const later = estimateTextRequest('x'.repeat(200000), p, 'fixture');
  assert.equal(first.contextWindow.precision, 'conservative_estimate');
  assert.equal(first.serializedBytes, 130000);
  assert.equal(first.estimatedInputTokens, 134096);
  assert.ok(later.reserveMicros > first.reserveMicros);
  assert.equal(
    estimateTextRequest('x'.repeat(130000), { ...p, contextBudgetTokens: 200000 }, 'fixture')
      .reserveMicros,
    first.reserveMicros,
  );
  assert.throws(
    () => estimateTextRequest('x'.repeat(251000), p, 'fixture'),
    /TEXT_CONTEXT_WINDOW_EXCEEDED/,
  );
  assert.ok(
    estimateTextRequest('x'.repeat(249000), p, 'fixture').contextWindow.totalTokens < 256000,
  );
});
test('synthetic exact adapter counts the full large envelope; unsupported model falls back and no count endpoint is called', () => {
  const provider = new OpenAiNpcProvider(config(), noNetwork, exactFixture);
  const a = provider.prepareTextRequest('intent', {
    contextHash: 'a',
    history: 'x'.repeat(520000),
  });
  assert.ok(a.snapshot.serializedBytes > 520000);
  assert.ok(a.snapshot.contextWindow.inputTokens > 130000);
  assert.equal(a.snapshot.contextWindow.precision, 'exact');
  assert.equal(a.snapshot.contextWindow.counterId, exactFixture.id);
  assert.equal(provider.contextWindow().transportLimitBytes, 4194304);
  assert.ok(provider.contextFits('intent', { history: 'x'.repeat(800000) }));
  assert.equal(provider.contextFits('intent', { history: 'x'.repeat(1100000) }), false);
  const unsupported = new OpenAiNpcProvider(
    config({ model: 'different-model' }),
    noNetwork,
    exactFixture,
  );
  assert.equal(
    unsupported.prepareTextRequest('intent', { contextHash: 'x' }).snapshot.contextWindow.precision,
    'conservative_estimate',
  );
  const changed = new OpenAiNpcProvider(
    config({ contextBudgetTokens: 200000 }),
    noNetwork,
    exactFixture,
  );
  assert.notEqual(changed.version, provider.version);
});
test('separate reply reservation and model capability are enforced before transport; counter failures cannot be called exact', () => {
  const p = { ...parsed().text, contextTokens: 1050000, maxOutputTokens: 2048 };
  const normal = measureTextContext('x'.repeat(240000), p);
  assertTextContext(normal);
  assert.throws(
    () =>
      assertTextContext(measureTextContext('x'.repeat(240000), { ...p, maxOutputTokens: 20000 })),
    /TEXT_CONTEXT_WINDOW_EXCEEDED/,
  );
  assert.throws(
    () =>
      measureTextContext('x', p, {
        ...exactFixture,
        supports: () => true,
        countInput: () => Number.NaN,
      }),
    /TEXT_TOKEN_COUNT_INVALID/,
  );
  assert.throws(
    () =>
      measureTextContext('x', p, {
        ...exactFixture,
        supports: () => true,
        countInput: () => Number.MAX_SAFE_INTEGER,
      }),
    /TEXT_TOKEN_COUNT_INVALID/,
  );
  assert.throws(
    () => contextWindow(p, { model: p.model, contextWindowTokens: 100000, maxOutputTokens: 1024 }),
    /TEXT_CONTEXT_POLICY_INVALID/,
  );
});
test('overflow retains canon, rules, summary and latest records, never mutates or deletes saved history', () => {
  const provider = new OpenAiNpcProvider(config({ contextBudgetTokens: 32000 }), noNetwork);
  const input = {
    contextHash: 'semantic-canon-hash',
    rules: { protected: 'PINNED_CANON' },
    goal: { evidenceIds: ['0'] },
    obligations: [{ evidenceIds: ['3'] }],
    summary: { narrative: 'Existing grounded summary' },
    history: Array.from({ length: 80 }, (_, i) => ({
      id: i,
      text: ('record-' + i + ' ').repeat(120),
    })),
    currentUtterance: { text: 'LATEST_QUESTION' },
  };
  const original = structuredClone(input);
  const result = packNpcContextWindow(input, (c) => provider.contextFits('intent', c));
  assert.equal(result.budgetExceeded, false);
  assert.ok(result.contextSelection.omittedRecords > 0);
  assert.equal(result.history.at(-1).id, 79);
  assert.ok(result.history.some((record) => record.id === 0));
  assert.ok(result.history.some((record) => record.id === 3));
  assert.deepEqual(result.rules, input.rules);
  assert.deepEqual(result.summary, input.summary);
  assert.equal(result.contextHash, input.contextHash);
  assert.deepEqual(input, original);
  assert.ok(provider.contextFits('intent', result));
  const impossible = packNpcContextWindow(
    { ...input, rules: { protected: 'x'.repeat(40000) } },
    (c) => provider.contextFits('intent', c),
  );
  assert.equal(impossible.budgetExceeded, true);
  assert.equal(impossible.rules.protected.length, 40000);
});
test('director retrieval grows beyond hot turns, filters shared audience and excludes OOC sources without write or provider calls', async () => {
  const provider = new OpenAiNpcProvider(config(), noNetwork);
  const queries = [];
  const records = Array.from({ length: 160 }, (_, i) => ({
    sequence: i,
    ordinal: 0,
    kind: 'speech',
    authorId: 'player',
    text: 'history '.repeat(100),
  }));
  const db = {
    query: async (sql, args) => {
      queries.push({ sql, args });
      assert.match(sql, /SELECT/);
      return sql.includes('game_story_feed') ? [...records].reverse() : [];
    },
  };
  const ai = {
    contextWindow: () => provider.contextWindow(),
    packContext: (c, p) => packNpcContextWindow(c, (v) => provider.contextFits(p, v)),
  };
  const c = await extendContextHistory(
    db,
    ai,
    'campaign',
    {},
    'player',
    { contextHash: 'canon', sharedAudience: [{ id: 'friend' }], rules: 'CANON' },
    'narrative',
  );
  assert.equal(c.history.length, 160);
  assert.ok(Buffer.byteLength(JSON.stringify(c)) > 64000);
  const sharedHistory = queries.find((query) => query.sql.includes('game_story_feed'));
  assert.match(sharedHistory.sql, /f.channel='say'/);
  assert.match(sharedHistory.sql, /audience_ids @>/);
  assert.deepEqual(sharedHistory.args[1], ['player', 'friend']);
  assert.equal(c.directorStyle.style, 'natural');
  assert.equal(
    queries.some((q) => q.sql.includes('game_party_chat')),
    false,
  );
  assert.equal(c.contextHash, 'canon');
});

test('NPC history reuses owned observations only and excludes other-participant whispers and private facts', async () => {
  const g = await import('@dreamwalk/game-core');
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const state = g.createStateFromPlayable(compiled.playable, ['alice', 'bob']);
  const npcId = Object.keys(state.npcBrains)[0];
  const npc = state.entities[npcId];
  Object.assign(state.entities.alice, { mapId: npc.mapId, x: npc.x, y: npc.y + 1 });
  Object.assign(state.entities.bob, { mapId: npc.mapId, x: npc.x + 1, y: npc.y });
  const m = state.npcBrains[npcId].living;
  assert.ok(m);
  const records = [
    {
      id: 'public-old',
      rootId: 'p',
      eventId: 'ep',
      tick: 1,
      kind: 'said',
      actorId: 'alice',
      text: 'PUBLIC_ALLOWED',
      confidence: 'witnessed',
      disclosure: 'public',
      audienceIds: ['alice', npcId],
    },
    {
      id: 'whisper-bob',
      rootId: 'w',
      eventId: 'ew',
      tick: 2,
      kind: 'said',
      actorId: 'bob',
      text: 'BOB_WHISPER_SECRET',
      confidence: 'witnessed',
      disclosure: 'participants',
      audienceIds: ['bob', npcId],
    },
    {
      id: 'private-fact',
      rootId: 's',
      eventId: 'es',
      tick: 3,
      kind: 'authored_fact',
      definitionText: 'NPC_PRIVATE_SECRET',
      confidence: 'witnessed',
      disclosure: 'private',
      audienceIds: [npcId],
      revealCondition: 'never',
    },
  ];
  const db = {
    query: async (sql, args) => {
      assert.equal(args[1], npcId);
      assert.ok(args.at(-1) > 16);
      return records.map((payload) => ({ payload, candidate_count: 3 }));
    },
  };
  const provider = new OpenAiNpcProvider(config(), noNetwork);
  const ai = {
    contextWindow: () => provider.contextWindow(),
    packContext: (c, p) => packNpcContextWindow(c, (v) => provider.contextFits(p, v)),
  };
  const original = structuredClone(state);
  const context = await extendContextHistory(
    db,
    ai,
    'campaign',
    state,
    'alice',
    { contextHash: 'speech', audienceIds: ['alice', npcId] },
    'speech',
    npcId,
  );
  assert.match(JSON.stringify(context.history), /PUBLIC_ALLOWED/);
  assert.doesNotMatch(JSON.stringify(context), /BOB_WHISPER_SECRET|NPC_PRIVATE_SECRET/);
  assert.deepEqual(state, original);
});

test('Russian bytes are explicitly conservative estimates, not evidence of 130k real model tokens', () => {
  const p = { ...parsed().text, contextTokens: 1050000, maxOutputTokens: 2048 };
  const cyrillic = 'Я'.repeat(130000);
  assert.equal(Buffer.byteLength(cyrillic), 260000);
  const measured = measureTextContext(cyrillic, p);
  assert.equal(measured.precision, 'conservative_estimate');
  assert.equal(measured.inputTokens, 264096);
  assert.throws(() => assertTextContext(measured), /TEXT_CONTEXT_WINDOW_EXCEEDED/);
});

test('deferred speech refresh retains the previously quoted complete body only under the same canon/phase', () => {
  const previous = {
    contextHash: 'same-semantic-state',
    turnFence: { roundId: 'round', phaseEpoch: 3 },
    historyPolicy: 'permitted-only',
    history: [{ text: 'QUOTED_HISTORY' }],
    contextSelection: { omittedRecords: 9 },
  };
  const refresh = {
    contextHash: 'same-semantic-state',
    turnFence: { phaseEpoch: 3, roundId: 'round' },
    historyPolicy: undefined,
    mockProposal: { text: 'new fixture' },
  };
  assert.equal(reuseFrozenContext(previous, refresh, true), previous);
  assert.equal(reuseFrozenContext(previous, refresh, false), refresh);
  const changed = { ...refresh, contextHash: 'changed-canon' };
  assert.equal(reuseFrozenContext(previous, changed, true), changed);
  const nextPhase = { ...refresh, turnFence: { roundId: 'round', phaseEpoch: 4 } };
  assert.equal(reuseFrozenContext(previous, nextPhase, true), nextPhase);
  assert.equal(previous.history[0].text, 'QUOTED_HISTORY');
});

test('overflow of feed-shaped records without optional IDs keeps the latest record, not every anonymous record', () => {
  const history = Array.from({ length: 160 }, (_, sequence) => ({
    sequence,
    ordinal: 0,
    text: 'history '.repeat(100),
  }));
  const input = { contextHash: 'feed-canon', rules: 'PINNED', history };
  const original = structuredClone(input);
  // Leave bounded room beyond the full pinned-record envelope. A stale absolute
  // window can reject even the required latest record before packing is tested.
  const pinnedTokens = new OpenAiNpcProvider(config(), noNetwork).prepareTextRequest('narrative', {
    ...input,
    history: history.slice(-1),
  }).snapshot.contextWindow.totalTokens;
  const provider = new OpenAiNpcProvider(
    config({ contextBudgetTokens: pinnedTokens + 4096 }),
    noNetwork,
  );
  assert.equal(provider.contextFits('narrative', input), false);
  const packed = packNpcContextWindow(input, (context) =>
    provider.contextFits('narrative', context),
  );
  assert.equal(packed.budgetExceeded, false);
  assert.ok(packed.history.length < history.length);
  assert.ok(packed.history.length > 0);
  assert.equal(packed.history.at(-1).sequence, 159);
  assert.equal(packed.rules, 'PINNED');
  assert.equal(packed.contextHash, 'feed-canon');
  assert.deepEqual(input, original);
  assert.ok(provider.contextFits('narrative', packed));
});

test('256k is an example, not a product ceiling: larger windows follow model capability', () => {
  const p = {
    ...parsed().text,
    contextTokens: 1050000,
    contextBudgetTokens: 512000,
    maxOutputTokens: 2048,
  };
  const measurement = measureTextContext('x'.repeat(300000), p);
  assert.equal(assertTextContext(measurement).effectiveContextTokens, 512000);
  assert.equal(
    contextWindow({ ...p, contextBudgetTokens: 2000000 }).effectiveContextTokens,
    1050000,
  );
  assert.equal(
    contextWindow({ ...p, contextBudgetTokens: 2000000 }).requestedContextTokens,
    2000000,
  );
});
