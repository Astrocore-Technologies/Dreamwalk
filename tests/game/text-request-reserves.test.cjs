/** Pure/memory-only tests: synthetic keys and fake transports, no app, filesystem secrets, or database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
// Stub eager bootstrap parsing without reading the real environment or changing the Node test harness.
const configModule = require.resolve('../../apps/api/dist/config.js');
require.cache[configModule] = {
  id: configModule,
  filename: configModule,
  loaded: true,
  exports: {
    config: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect',
      AI_PROVIDER: 'mock',
      GLOBAL_SPEND_CAP: 0,
      ASSET_DIR: '.local/no-unit-assets',
    },
    readConfig() {
      throw Error('Unit must not read environment');
    },
  },
};
const {
  OpenAiNpcProvider,
  buildOpenAiNpcRequestBody,
  prepareOpenAiNpcTextRequest,
} = require('../../apps/api/dist/ai/openai-provider.js');
const {
  BoundedAuthoringTextProvider,
  buildAuthoringTextRequestBody,
} = require('../../apps/api/dist/live-test/authoring-provider.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { GenerationProvider } = require('../../apps/api/dist/generation/provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const estimation = {
  kind: 'operator_heuristic',
  textTokensPerKiBUtf8: 1024,
  textProtocolTokens: 4096,
  marginBps: 2500,
  fixedMarginMicros: 17,
};
const pricing = {
  source: 'https://developers.openai.com/api/docs/pricing',
  reviewedAt: '2000-01-01T00:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
};
const config = (extra = {}) => ({
  enabled: true,
  apiKey: 'synthetic-only',
  model: 'synthetic-model',
  version: 'synthetic-v1',
  maxInputBytes: 64000,
  maxModelInputTokens: 1050000,
  maxOutputTokens: 2048,
  maxResponseBytes: 128000,
  inputMicrosPerMillion: 250000,
  outputMicrosPerMillion: 750000,
  estimation: { ...estimation },
  pricing: { ...pricing },
  ...extra,
});
const profile = (extra = {}) => ({
  model: 'synthetic-model',
  contextTokens: 1050000,
  maxInputBytes: 64000,
  maxOutputTokens: 2048,
  inputMicrosPerMillion: 250000,
  outputMicrosPerMillion: 750000,
  upperMicros: 264036,
  estimation: { ...estimation },
  pricing: { ...pricing },
  ...extra,
});
const definition = (
  instructions = 'Return one compact layout.',
  schema = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
) => ({ version: 'synthetic-layout-v1', instructions, schema, validateProposal: (x) => x });
const response = (proposal = { text: 'Hello' }, input = 50, output = 10) =>
  new Response(
    JSON.stringify({
      id: 'synthetic-response',
      status: 'completed',
      service_tier: 'default',
      usage: { input_tokens: input, output_tokens: output },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] },
      ],
    }),
    { headers: { 'x-request-id': 'req_synthetic' } },
  );
const request = (context = { contextHash: 'synthetic-context', replyLocale: 'en' }) => ({
  jobId: randomUUID(),
  purpose: 'speech',
  context,
  signal: new AbortController().signal,
  maxCostMicros: 264036,
});

test('NPC planning includes complete instructions/schema/protocol/output and does not price model capacity', () => {
  const c = config(),
    context = {
      contextHash: 'synthetic',
      replyLocale: 'uk',
      privateCanary: 'PRIVATE_NOT_IN_SNAPSHOT',
      mockProposal: { mustNeverBeSent: true },
    };
  const provider = new OpenAiNpcProvider(c, async () => {
    throw Error('no transport');
  });
  const prepared = provider.prepareTextRequest('speech', context);
  assert.equal(prepared.body, buildOpenAiNpcRequestBody(c, 'speech', context));
  assert.equal(
    prepared.body,
    buildOpenAiNpcRequestBody(
      c,
      'speech',
      Object.fromEntries(Object.entries(context).filter(([k]) => k !== 'mockProposal')),
    ),
  );
  assert.ok(prepared.body.includes('Output language: Ukrainian'));
  assert.ok(prepared.body.includes('json_schema'));
  assert.equal(prepared.body.includes('mustNeverBeSent'), false);
  const reordered = Object.fromEntries(Object.entries(context).reverse());
  assert.equal(
    provider.prepareTextRequest('speech', reordered).snapshot.bodySha256,
    prepared.snapshot.bodySha256,
  );
  assert.equal(prepared.snapshot.serializedBytes, Buffer.byteLength(prepared.body));
  assert.equal(
    prepared.snapshot.bodySha256,
    createHash('sha256').update(prepared.body).digest('hex'),
  );
  assert.equal(prepared.snapshot.protocolTokenAllowance, 4096);
  assert.equal(prepared.snapshot.maxOutputTokens, 2048);
  assert.ok(prepared.snapshot.reserveMicros > prepared.snapshot.estimatedTotalMicros);
  assert.equal(prepared.snapshot.providerEnforcesQuotedCap, false);
  assert.equal(JSON.stringify(prepared.snapshot).includes('PRIVATE_NOT_IN_SNAPSHOT'), false);
  const smallerCapacity = prepareOpenAiNpcTextRequest(
    { ...c, maxModelInputTokens: 500000 },
    'speech',
    context,
    provider.version,
  );
  assert.equal(smallerCapacity.snapshot.reserveMicros, prepared.snapshot.reserveMicros);
  assert.ok(prepared.snapshot.reserveMicros < 264036 / 4);
  const story = provider.prepareTextRequest('story_turn', { ...context, mode: 'director' });
  assert.ok(story.snapshot.reserveMicros > prepared.snapshot.reserveMicros);
  const longer = provider.prepareTextRequest('speech', {
    ...context,
    message: '"\\🪐'.repeat(1000),
  });
  assert.ok(longer.snapshot.reserveMicros > prepared.snapshot.reserveMicros);
});
test('context packing follows low-ratio operator estimates and larger margins reduce packing', () => {
  const cfg = config({ estimation: { ...estimation, textTokensPerKiBUtf8: 1 } });
  const provider = new OpenAiNpcProvider(cfg, async () => {
    throw Error('no transport');
  });
  const empty = provider.prepareTextRequest('speech', { contextHash: 'c' }).snapshot;
  const budget = empty.reserveMicros + 100;
  const allowance = provider.contextBudgetBytes(budget);
  assert.ok(allowance > 1000);
  const context = {
    contextHash: 'c',
    replyLocale: 'en',
    text: 'x'.repeat(Math.max(0, allowance - 100)),
  };
  assert.ok(provider.prepareTextRequest('speech', context).snapshot.reserveMicros <= budget);
  const normal = new OpenAiNpcProvider(config(), async () => {
    throw Error('no transport');
  });
  const higher = new OpenAiNpcProvider(
    config({ estimation: { ...estimation, marginBps: 9000 } }),
    async () => {
      throw Error('no transport');
    },
  );
  const cap = normal.prepareTextRequest('story_turn', {
    contextHash: 'c',
    mode: 'director',
    text: 'x'.repeat(8000),
  }).snapshot.reserveMicros;
  assert.ok(higher.contextBudgetBytes(cap) < normal.contextBudgetBytes(cap));
  assert.equal(provider.contextBudgetBytes(0), 0);
});
test('NPC provider dispatches exactly the quoted body and pins original rates despite mutable caller config', async () => {
  const c = config();
  let calls = 0,
    body;
  const provider = new OpenAiNpcProvider(c, async (_url, init) => {
    calls++;
    body = init.body;
    return response();
  });
  const req = request({ contextHash: 'c', mockProposal: { ignored: true } });
  const prepared = provider.prepareTextRequest(req.purpose, req.context);
  c.model = 'mutated';
  c.inputMicrosPerMillion = 999999;
  c.estimation.marginBps = 9000;
  const result = await provider.generate({
    ...req,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(body, prepared.body);
  assert.equal(result.usage.costMicros, 20);
  assert.equal(calls, 1);
  await assert.rejects(
    provider.generate({ ...req, maxCostMicros: prepared.snapshot.reserveMicros }),
    (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED' && !e.uncertain,
  );
  await assert.rejects(
    provider.generate({
      ...req,
      context: { contextHash: 'changed' },
      textReservationSnapshot: prepared.snapshot,
    }),
    (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED' && !e.uncertain,
  );
  await assert.rejects(
    provider.generate({
      ...req,
      textReservationSnapshot: { ...prepared.snapshot, inputMicrosPerMillion: 1 },
    }),
    (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
  );
  assert.equal(calls, 1);
  const changed = new OpenAiNpcProvider(config({ inputMicrosPerMillion: 300000 }), async () => {
    calls++;
    return response();
  });
  await assert.rejects(
    changed.generate({ ...req, textReservationSnapshot: prepared.snapshot }),
    (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
  );
  assert.equal(calls, 1);
});
test('operator token assumptions are not mistaken for actual provider token limits', async () => {
  const provider = new OpenAiNpcProvider(
    config({ estimation: { ...estimation, fixedMarginMicros: 100000 } }),
    async () => response({ text: 'Known usage' }, 30000, 10),
  );
  const req = request(),
    snapshot = provider.prepareTextRequest('speech', req.context).snapshot;
  assert.ok(30000 > snapshot.estimatedInputTokens);
  const result = await provider.generate({
    ...req,
    maxCostMicros: snapshot.reserveMicros,
    textReservationSnapshot: snapshot,
  });
  assert.equal(result.failureCode, undefined);
  assert.equal(result.usage.inputTokens, 30000);
});
test('authoring estimator and transport use identical complete body and snapshot excludes private content', async () => {
  let calls = 0,
    body;
  const p = profile(),
    def = definition('Return a layout. ' + 'bounded-instruction '.repeat(400));
  const provider = new BoundedAuthoringTextProvider(
    def,
    'synthetic',
    async (_url, init) => {
      calls++;
      body = init.body;
      return response({ title: 'A room' });
    },
    p,
  );
  const context = {
    brief: 'PRIVATE_AUTHOR_BRIEF',
    nested: { z: 1, a: 2 },
    ordered: [{ b: 2, a: 1 }],
  };
  const prepared = provider.prepareTextRequest(context);
  assert.equal(prepared.body, buildAuthoringTextRequestBody(def, p, context));
  const jsonbOrder = {
    ordered: [{ a: 1, b: 2 }],
    nested: { a: 2, z: 1 },
    brief: 'PRIVATE_AUTHOR_BRIEF',
  };
  assert.equal(
    provider.prepareTextRequest(jsonbOrder).snapshot.bodySha256,
    prepared.snapshot.bodySha256,
  );
  assert.ok(prepared.snapshot.serializedBytes > Buffer.byteLength(JSON.stringify(context)) + 4000);
  assert.equal(JSON.stringify(prepared.snapshot).includes('PRIVATE_AUTHOR_BRIEF'), false);
  const small = new BoundedAuthoringTextProvider(
    definition(),
    'synthetic',
    async () => response({ title: 'A room' }),
    profile(),
  ).prepareTextRequest(context);
  assert.ok(prepared.snapshot.reserveMicros > small.snapshot.reserveMicros);
  p.inputMicrosPerMillion = 1000000;
  p.estimation.marginBps = 9000;
  const result = await provider.generate({
    jobId: 'synthetic-job',
    context,
    signal: new AbortController().signal,
    textReservationSnapshot: Object.fromEntries(Object.entries(prepared.snapshot).reverse()),
    maxCostMicros: prepared.snapshot.reserveMicros,
  });
  assert.equal(body, prepared.body);
  assert.equal(result.usage.costMicros, 20);
  assert.equal(calls, 1);
  await assert.rejects(
    provider.generate({
      jobId: 'synthetic-job',
      context,
      signal: new AbortController().signal,
      textReservationSnapshot: { ...prepared.snapshot, reserveMicros: 1 },
      maxCostMicros: 1,
    }),
    (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
  );
  assert.equal(calls, 1);
});
test('legacy adapters keep fixed reserve behavior and no snapshot requirement; 403 never retries', async () => {
  const c = config();
  delete c.estimation;
  delete c.pricing;
  let calls = 0;
  const provider = new OpenAiNpcProvider(c, async () => {
    calls++;
    return response();
  });
  assert.equal(provider.prepareTextRequest('speech', {}), undefined);
  await provider.generate(request());
  assert.equal(calls, 1);
  const legacyProfile = profile();
  delete legacyProfile.estimation;
  const author = new BoundedAuthoringTextProvider(
    definition(),
    'synthetic',
    async () => {
      calls++;
      return new Response('not inspected', {
        status: 403,
        headers: { 'x-request-id': 'req_only_once' },
      });
    },
    legacyProfile,
  );
  assert.equal(author.prepareTextRequest({}), undefined);
  await assert.rejects(
    author.generate({ jobId: 'id', context: {}, signal: new AbortController().signal }),
    (e) => e.code === 'PROVIDER_HTTP_403' && e.uncertain && e.requestId === 'req_only_once',
  );
  assert.equal(calls, 2);
});

const insertRow = (sql, values) => {
  const match = sql.match(/INSERT INTO \w+\(([^)]+)\)\s*VALUES\(([^)]+)\)/s);
  assert.ok(match, 'recognized parameterized insert');
  const cols = match[1].split(','),
    parts = match[2].split(',');
  const row = { created_at: new Date(0) };
  cols.forEach((col, i) => {
    const token = parts[i].trim();
    let value = token.startsWith('$')
      ? values[Number(token.slice(1)) - 1]
      : token.replace(/^'|'$/g, '');
    if (['context', 'request_meta', 'request_snapshot'].includes(col) && typeof value === 'string')
      value = JSON.parse(value);
    row[col] = value;
  });
  return row;
};
test('authoring quote persists exact reserve/rates/policy revision without storing raw body in snapshot', async () => {
  let row;
  const client = {
    query: async (sql, v = []) => {
      if (sql.startsWith('INSERT INTO live_authoring_text_quotes')) {
        row = insertRow(sql, v);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith('SELECT * FROM live_authoring_text_quotes'))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const database = { tx: (f) => f(client) };
  const live = {
    mode: 'owner',
    config: {},
    requireOwner: async () => {},
    authorizeText: async () => ({}),
    assertActivePolicy: async () => ({ revision: 3, hash: 'policy-3', configFingerprint: 'cfg' }),
    textUpperMicros: () => 264036,
    textProfile: () => profile(),
  };
  const provider = new BoundedAuthoringTextProvider(
    definition(),
    'synthetic',
    async () => {
      throw Error('no transport');
    },
    profile(),
  );
  const engine = new AuthoringTextEngine(database, live, provider, definition());
  const input = {
    sessionId: randomUUID(),
    projectId: randomUUID(),
    projectRevision: 1,
    sourceHash: 'a'.repeat(64),
    readsetHash: 'b'.repeat(64),
    operationId: randomUUID(),
    context: { brief: 'PRIVATE_QUOTE' },
  };
  const quote = await engine.quote(randomUUID(), input, async () => {});
  assert.equal(quote.upperMicros, null);
  assert.equal(quote.reserveMicros, row.request_snapshot.reserveMicros);
  assert.ok(quote.reserveMicros < 264036);
  assert.equal(row.upper_micros, quote.reserveMicros);
  assert.equal(row.generation_policy_revision, 3);
  assert.equal(row.generation_policy_hash, 'policy-3');
  assert.equal(row.request_snapshot.inputMicrosPerMillion, 250000);
  assert.equal(JSON.stringify(row.request_snapshot).includes('PRIVATE_QUOTE'), false);
});
test('NPC queue reserves actual affordable request when remaining provider budget is below profile maximum', async () => {
  const inner = new OpenAiNpcProvider(config(), async () => {
    throw Error('no transport');
  });
  const context = { contextHash: 'small', replyLocale: 'en' };
  const snapshot = inner.prepareTextRequest('speech', context).snapshot;
  let planner, job;
  const budget = {
    cap_micros: '100000',
    reserved_micros: 0,
    spent_micros: 100000 - snapshot.reserveMicros - 1,
    unknown_micros: 0,
    blocked: false,
  };
  const live = {
    mode: 'owner',
    ownerConfig: { text: { estimation } },
    preparedAuthorizationId: async () => randomUUID(),
    acknowledgedTextCap: async () => 100000,
    configureTextCountAdapter: () => {},
    configureTextRequestPlanner: (f) => {
      planner = f;
    },
  };
  const provider = new GenerationProvider(inner, live);
  const client = {
    query: async (sql, v = []) => {
      if (sql.startsWith('SELECT * FROM npc_ai_jobs WHERE campaign_id'))
        return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM npc_ai_provider_budgets'))
        return { rows: [budget], rowCount: 1 };
      if (sql.startsWith('INSERT INTO npc_ai_jobs')) {
        job = insertRow(sql, v);
        return { rows: [job], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros+'))
        budget.reserved_micros += v[1];
      return { rows: [], rowCount: 0 };
    },
  };
  const engine = new NpcAiEngine({ tx: (f) => f(client) }, provider, {
    providerUpperMicros: 50000,
    providerCapMicros: 100000,
    externalApproved: true,
    timeoutMs: 1000,
  });
  engine.authorize = async () => {};
  engine.turnAuthorized = async () => true;
  engine.excludeLegacyOwnerBypass = async () => {};
  await engine.queue({
    scope: { campaignId: randomUUID(), npcId: 'npc', origin: 'system', purpose: 'speech' },
    operationId: randomUUID(),
    context,
  });
  assert.equal(job.provider_upper_micros, snapshot.reserveMicros);
  assert.equal(budget.reserved_micros, snapshot.reserveMicros);
  assert.ok(snapshot.reserveMicros < 50000);
  assert.deepEqual(job.request_snapshot, snapshot);
  assert.deepEqual(planner('speech', context), snapshot);
});

function ownerQueueFixture({
  acceptedCap = 2000000,
  denial,
  blocked = false,
  mode = 'owner',
  unknown = 0,
} = {}) {
  const authorizationId = randomUUID();
  const budget = {
    cap_micros: '1000000',
    spent_micros: 900000,
    reserved_micros: 10000,
    unknown_micros: unknown,
    overrun_micros: 0,
    blocked,
  };
  const events = [];
  let job;
  const inner = {
    id: 'openai-responses',
    version: 'accepted-new-profile',
    external: true,
    generate: async () => {
      throw Error('No provider calls in queue tests');
    },
  };
  const authority = {
    mode,
    preparedAuthorizationId: async () => authorizationId,
    acknowledgedTextCap: async (_client, id) => {
      assert.equal(id, authorizationId);
      assert.ok(events.indexOf('financial-lock') < events.indexOf('fence'));
      assert.ok(events.includes('fence'));
      events.push('accepted-policy-read');
      if (denial) throw Object.assign(Error(denial), { code: denial });
      return acceptedCap;
    },
  };
  const provider = new GenerationProvider(inner, authority);
  const client = {
    query: async (sql, v = []) => {
      if (sql.startsWith('SELECT * FROM npc_ai_jobs WHERE campaign_id'))
        return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM npc_ai_provider_budgets')) {
        events.push('financial-lock');
        return { rows: [budget], rowCount: 1 };
      }
      if (v[0] === 'generation-scope-admission') events.push('fence');
      if (sql.startsWith('UPDATE npc_ai_provider_budgets SET cap_micros=')) {
        assert.ok(events.includes('accepted-policy-read'));
        events.push('cap-update');
        budget.cap_micros = String(v[1]);
      }
      if (sql.startsWith('INSERT INTO npc_ai_jobs')) {
        events.push('job-insert');
        job = insertRow(sql, v);
        return { rows: [job], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros+')) {
        events.push('reserve-increment');
        budget.reserved_micros += v[1];
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const engine = new NpcAiEngine({ tx: (f) => f(client) }, provider, {
    providerUpperMicros: 200000,
    providerCapMicros: 2000000,
    externalApproved: true,
    timeoutMs: 1000,
  });
  engine.authorize = async () => {};
  engine.turnAuthorized = async () => true;
  const input = {
    scope: { campaignId: randomUUID(), npcId: 'npc', origin: 'system', purpose: 'speech' },
    operationId: randomUUID(),
    context: { contextHash: 'accepted-cap' },
  };
  return { engine, input, budget, events, job: () => job };
}

test('acknowledged owner cap increase admits NPC request without resetting historical provider counters', async () => {
  const fixture = ownerQueueFixture();
  const before = { ...fixture.budget };
  await fixture.engine.queue(fixture.input);
  assert.equal(fixture.budget.cap_micros, '2000000');
  assert.equal(fixture.budget.spent_micros, before.spent_micros);
  assert.equal(fixture.budget.reserved_micros, before.reserved_micros + 200000);
  assert.equal(fixture.budget.unknown_micros, before.unknown_micros);
  assert.equal(fixture.budget.overrun_micros, before.overrun_micros);
  assert.equal(fixture.budget.blocked, before.blocked);
  assert.ok(fixture.events.indexOf('accepted-policy-read') < fixture.events.indexOf('cap-update'));
  assert.ok(fixture.events.indexOf('cap-update') < fixture.events.indexOf('job-insert'));
  assert.equal(fixture.job().provider_upper_micros, 200000);
  await fixture.engine.queue(fixture.input);
  assert.equal(fixture.events.filter((e) => e === 'job-insert').length, 1);
  assert.equal(fixture.events.filter((e) => e === 'reserve-increment').length, 1);
});

test('unacknowledged or stopped owner policy cannot raise provider cap or reserve another request', async () => {
  for (const options of [
    { denial: 'GENERATION_POLICY_CHANGED' },
    { denial: 'LIVE_TEST_STOPPED', unknown: 5000 },
    { blocked: true, unknown: 5000 },
  ]) {
    const fixture = ownerQueueFixture(options);
    const before = { ...fixture.budget };
    await assert.rejects(fixture.engine.queue(fixture.input));
    assert.deepEqual(fixture.budget, before);
    assert.equal(fixture.job(), undefined);
    assert.equal(fixture.events.includes('cap-update'), false);
    assert.equal(fixture.events.includes('reserve-increment'), false);
  }
});

test('owner cap cannot fall below liabilities and manual mode retains the historical lower cap', async () => {
  const reduced = ownerQueueFixture({ acceptedCap: 800000 });
  const before = { ...reduced.budget };
  await assert.rejects(
    reduced.engine.queue(reduced.input),
    (e) => (e.code ?? e.getResponse?.().code) === 'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
  );
  assert.deepEqual(reduced.budget, before);
  assert.equal(reduced.job(), undefined);
  const manual = ownerQueueFixture({ mode: 'manual' });
  await assert.rejects(manual.engine.queue(manual.input));
  assert.equal(manual.budget.cap_micros, '1000000');
  assert.equal(manual.events.includes('accepted-policy-read'), false);
  assert.equal(manual.events.includes('cap-update'), false);
  assert.equal(manual.job(), undefined);
});

test('large request dispatch pins its independent window and output snapshot; replaying the pure quote does not send', async () => {
  let calls = 0,
    body;
  const c = config({ contextBudgetTokens: 256000 });
  const provider = new OpenAiNpcProvider(c, async (_url, options) => {
    calls++;
    body = options.body;
    return response({ text: 'Synthetic large-context reply' }, 140000, 10);
  });
  const context = { contextHash: 'large-history', replyLocale: 'ru', history: 'x'.repeat(130000) };
  const prepared = provider.prepareTextRequest('speech', context);
  assert.ok(prepared.snapshot.serializedBytes > 130000);
  assert.equal(prepared.snapshot.contextWindow.requestedContextTokens, 256000);
  assert.deepEqual(provider.prepareTextRequest('speech', context).snapshot, prepared.snapshot);
  assert.equal(calls, 0);
  const result = await provider.generate({
    ...request(context),
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(calls, 1);
  assert.equal(body, prepared.body);
  assert.equal(JSON.parse(body).truncation, 'disabled');
  assert.equal(result.failureCode, undefined);
  assert.equal(result.usage.inputTokens, 140000);
  const newer = new OpenAiNpcProvider({ ...c, maxOutputTokens: 4096 }, async () => {
    assert.fail('Stale snapshot must not dispatch');
  });
  await assert.rejects(
    newer.generate({ ...request(context), textReservationSnapshot: prepared.snapshot }),
    /PROVIDER_REQUEST_SNAPSHOT_CHANGED/,
  );
});

test('actual deferred-request processor preserves previously quoted history during a same-phase metadata refresh', async () => {
  const { GameService } = require('../../apps/api/dist/game/game.service.js');
  const fence = { roundId: 'world-round', phaseEpoch: 3, rulesetVersion: 1 };
  const frozen = {
    contextHash: 'same-semantic-state',
    turnFence: fence,
    historyPolicy: 'permitted-only',
    history: [{ text: 'QUOTED_ALLOWED_HISTORY' }],
    contextSelection: { omittedRecords: 4 },
    recipientId: 'player',
    channel: 'say',
    observationIds: [],
    deferredSpeechId: randomUUID(),
    replyLocale: 'ru',
  };
  const row = {
    id: randomUUID(),
    npc_id: 'keeper',
    requester_user_id: 'owner',
    purpose: 'speech',
    context: frozen,
  };
  const written = [];
  let reviewed;
  const fake = {
    story: { quotedReply: async () => null, requireLegacyReplyConsent: async () => false },
    db: {
      query: async (sql, args = []) => {
        if (sql.startsWith('SELECT * FROM game_npc_decision_requests')) return [row];
        if (sql.startsWith('SELECT c.id FROM game_campaigns')) return [{ id: 'campaign' }];
        if (sql.startsWith('SELECT status FROM npc_ai_jobs')) return [];
        if (sql.startsWith('UPDATE game_npc_decision_requests SET context=')) {
          written.push(JSON.parse(args[1]));
          return [];
        }
        if (sql.includes("result_code='PROVIDER_DISABLED'")) return [];
        if (sql.startsWith('SELECT 1 FROM game_npc_decision_requests')) return [{ id: row.id }];
        if (sql.startsWith('SELECT npc_id FROM game_npc_decision_requests')) return [];
        assert.fail('Unexpected SQL in deferred-body regression');
      },
    },
    ai: {
      contextWindow: () => ({ effectiveContextTokens: 256000 }),
      configuration: () => ({ enabled: false }),
      activeSponsor: async () => null,
      releaseGeneration: () => false,
      manualLive: () => true,
      manualRequestAuthorized: async (_id, context) => {
        reviewed = context;
        return true;
      },
    },
    reconcileIntents: async () => {},
    speechContext: () => ({
      contextHash: frozen.contextHash,
      turnFence: { ...fence },
      recipientId: 'player',
      channel: 'say',
      observationIds: [],
      claims: [],
    }),
  };
  const state = {
    tick: 1,
    turnController: {
      ...fence,
      phase: 'world',
      deferredSpeech: [
        {
          id: frozen.deferredSpeechId,
          actorId: 'player',
          recipientId: 'keeper',
          utteranceId: 'synthetic-utterance',
          channel: 'say',
          audienceIds: ['keeper', 'player'],
          sequence: 0,
          roundId: fence.roundId,
          phaseEpoch: fence.phaseEpoch,
        },
      ],
    },
    entities: { keeper: { kind: 'npc' } },
    npcBrains: { keeper: {} },
  };
  await GameService.prototype.processDecisionRequests.call(fake, 'campaign', { state });
  assert.equal(written.length, 0, 'Frozen large history is not rewritten every world tick');
  assert.deepEqual(reviewed.history, frozen.history);
  assert.deepEqual(reviewed.contextSelection, frozen.contextSelection);
  assert.equal(reviewed.replyLocale, 'ru');
});

test('actual deferred-request processor prepares the history window before asking for manual authorization', async () => {
  const { GameService } = require('../../apps/api/dist/game/game.service.js');
  const fence = { roundId: 'world-round', phaseEpoch: 3, rulesetVersion: 1 };
  const original = {
    contextHash: 'semantic',
    turnFence: fence,
    recipientId: 'player',
    channel: 'say',
    audienceIds: ['keeper', 'player'],
    observationIds: [],
    deferredSpeechId: randomUUID(),
    replyLocale: 'uk',
  };
  const row = {
    id: randomUUID(),
    npc_id: 'keeper',
    requester_user_id: 'owner',
    purpose: 'speech',
    context: original,
  };
  const written = [];
  let reviewed, failed;
  const fake = {
    story: { quotedReply: async () => null, requireLegacyReplyConsent: async () => false },
    db: {
      query: async (sql, args = []) => {
        if (sql.startsWith('SELECT * FROM game_npc_decision_requests')) return [row];
        if (sql.startsWith('SELECT c.id FROM game_campaigns')) return [{ id: 'campaign' }];
        if (sql.includes('WITH recent AS')) return [];
        if (sql.startsWith('UPDATE game_npc_decision_requests SET context=')) {
          written.push(JSON.parse(args[1]));
          return [];
        }
        if (sql.startsWith('SELECT 1 FROM game_npc_decision_requests')) return [{ id: row.id }];
        if (sql.startsWith('SELECT npc_id FROM game_npc_decision_requests')) return [];
        assert.fail('Unexpected outer SQL in pre-consent context regression');
      },
      tx: async (work) =>
        work({
          query: async (sql, args = []) => {
            if (sql.startsWith('SELECT context FROM game_npc_decision_requests'))
              return { rows: [{ context: original }], rowCount: 1 };
            if (sql.startsWith('SELECT 1 FROM live_test_text_permits'))
              return { rows: [], rowCount: 0 };
            if (sql.startsWith('UPDATE game_npc_decision_requests SET context=')) {
              written.push(JSON.parse(args[1]));
              return { rows: [], rowCount: 1 };
            }
            assert.fail('No financial mutation is allowed before consent');
          },
        }),
    },
    ai: {
      contextWindow: () => ({ effectiveContextTokens: 256000 }),
      packContext: (c) => ({ ...c, budgetExceeded: false }),
      releaseGeneration: () => false,
      manualLive: () => true,
      manualRequestAuthorized: async (_id, c) => {
        reviewed = c;
        return false;
      },
    },
    reconcileIntents: async () => {},
    failUnqueuedManualRequest: async (_id, code) => {
      failed = code;
    },
    speechContext: () => ({ ...original, claims: [] }),
  };
  const state = {
    tick: 1,
    turnController: {
      ...fence,
      phase: 'world',
      deferredSpeech: [
        {
          id: original.deferredSpeechId,
          actorId: 'player',
          recipientId: 'keeper',
          utteranceId: 'synthetic-utterance',
          channel: 'say',
          audienceIds: ['keeper', 'player'],
          sequence: 0,
          roundId: fence.roundId,
          phaseEpoch: fence.phaseEpoch,
        },
      ],
    },
    entities: { keeper: { kind: 'npc' } },
    npcBrains: {
      keeper: { living: { relationships: {}, goal: {}, obligations: [], observations: [] } },
    },
  };
  await GameService.prototype.processDecisionRequests.call(fake, 'campaign', { state });
  assert.equal(failed, 'MANUAL_AUTHORIZATION_UNAVAILABLE');
  assert.ok(reviewed.historyPolicy);
  assert.deepEqual(reviewed.history, []);
  assert.ok(written.at(-1).historyPolicy);
  assert.equal(written.at(-1).replyLocale, 'uk');
});
