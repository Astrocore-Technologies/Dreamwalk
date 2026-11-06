// Source-only synthetic storage/engine tests. No network, provider, production or PG claims.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === '@dreamwalk/game-core') return path.join(root, 'packages/game-core/src/index.ts');
  if (request.includes('/apps/api/dist/')) {
    const file =
      path
        .resolve(path.dirname(parent.filename), request)
        .replace('/apps/api/dist/', '/apps/api/src/') + '.ts';
    if (fs.existsSync(file)) return file;
  }
  return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, file) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: file,
    }).outputText,
    file,
  );
const core = require('@dreamwalk/game-core');
const { digest } = require('../../apps/api/dist/ai/context');
const {
  RuntimeMapCountRequired,
  withRuntimeMapPreflight,
} = require('../../apps/api/dist/ai/runtime-map-preflight');
const {
  capturePresentationAliases,
  assertPresentationAliasAuthority,
  withPresentationAliasScope,
  storedPresentationAliases,
} = require('../../apps/api/dist/game/presentation-aliases');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');

function fixture() {
  const campaignId = randomUUID(),
    versionId = randomUUID(),
    userId = randomUUID(),
    ownerId = randomUUID();
  const draft = core.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const compiled = core.compilePlayableDraft(draft).playable;
  const state = core.createStateFromPlayable(compiled, ['alice', 'bob']);
  state.narrativeSource = { versionId, checksum: 'c'.repeat(64) };
  delete state.turnController;
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  Object.assign(compiled.entities.key, {
    label: 'Старинный пропуск',
    labelTranslations: undefined,
  });
  Object.assign(state.entities.key, {
    x: 5,
    y: 5,
    label: 'Старинный пропуск',
    labelTranslations: undefined,
  });
  Object.assign(compiled.entities.keeper, { label: 'Смотритель', labelTranslations: undefined });
  Object.assign(state.entities.keeper, {
    x: 6,
    y: 4,
    label: 'Смотритель',
    labelTranslations: undefined,
  });
  const pkg = { schemaVersion: 1, compiled, source: { title: compiled.title } };
  const campaign = { title: compiled.title, playableVersionId: versionId };
  const f = {
    state,
    pkg,
    campaignId,
    versionId,
    userId,
    ownerId,
    campaign,
    reads: 0,
    memberEpoch: 'member-life',
    turns: [],
    calls: [],
  };
  f.input = {
    operationId: randomUUID(),
    text: '*take Brass pass*',
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
  };
  f.rows = [
    {
      source: { kind: 'playable', id: versionId },
      partition: 'released-descriptions',
      path: 'entity/key/label',
      sourceText: state.entities.key.label,
      text: 'Brass pass',
      translationKey: '1'.repeat(64),
    },
  ];
  f.reader = {
    readyFields: async (_path, dto, locale, viewer) => {
      f.reads++;
      assert.equal(viewer, userId);
      assert.equal(dto.campaign.playableVersionId, versionId);
      assert.equal(
        dto.projection.entities.find((e) => e.id === 'key').label,
        state.entities.key.label,
      );
      return structuredClone(f.rows);
    },
  };
  const query = async (sql, args = []) => {
    f.calls.push(sql);
    if (sql.startsWith('SELECT a.owner_id')) return { rows: [{ owner_id: ownerId }] };
    if (sql.startsWith('SELECT owner_id FROM game_campaigns'))
      return { rows: [{ owner_id: userId }] };
    if (sql.includes('SELECT v.package'))
      return {
        rows: f.revoked
          ? []
          : [
              {
                package: pkg,
                checksum: digest(pkg),
                audience: 'review',
                adventure_id: randomUUID(),
                owner_id: ownerId,
                source_epoch: 'source-life',
                owner_epoch: 'owner-life',
              },
            ],
      };
    if (sql.includes('SELECT c.state'))
      return {
        rows: [
          {
            state,
            snapshot_state: state,
            checksum: digest(state),
            actor_id: 'alice',
            owner_id: userId,
            campaign_epoch: 'campaign-life',
            member_epoch: f.memberEpoch,
            viewer_epoch: 'viewer-life',
            campaign_owner_epoch: 'viewer-life',
            invitation_epoch: null,
          },
        ],
      };
    if (sql.includes('SELECT m.actor_id'))
      return {
        rows: f.accessRevoked ? [] : [{ actor_id: 'alice' }],
        rowCount: f.accessRevoked ? 0 : 1,
      };
    if (sql.startsWith('SELECT * FROM game_story_turns'))
      return { rows: f.turns.filter((r) => r.operation_id === args[2]) };
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: 0 }] };
    if (sql.startsWith('INSERT INTO game_story_turns')) {
      f.turns.push({
        id: args[0],
        campaign_id: args[1],
        requester_user_id: args[2],
        actor_id: args[3],
        operation_id: args[4],
        request_hash: args[5],
        input: JSON.parse(args[6]),
        segments: JSON.parse(args[7]),
        context: JSON.parse(args[8]),
        quote_id: args[9],
        quote_result: JSON.parse(args[10]),
        status: 'quoted',
      });
    }
    return { rows: [], rowCount: 1 };
  };
  f.client = { query };
  f.db = { tx: (work) => work(f.client), query: async (...args) => (await query(...args)).rows };
  f.capture = () =>
    capturePresentationAliases(
      f.db,
      f.reader,
      campaignId,
      campaign,
      state,
      'alice',
      userId,
      f.input,
    );
  return f;
}

test('ready-only capture binds exact released fields, frozen provenance and no canonical or input mutation', async () => {
  const f = fixture(),
    before = structuredClone(f.state),
    input = structuredClone(f.input);
  const aliases = await f.capture();
  assert.equal(aliases.entries.length, 1);
  assert.equal(aliases.entries[0].id, 'key');
  assert.equal(aliases.authority.length, 64);
  assert.ok(Object.isFrozen(aliases.entries[0]));
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.input, input);
  await assertPresentationAliasAuthority(
    f.client,
    f.campaignId,
    f.userId,
    'alice',
    aliases,
    f.input.text,
  );
  assert.equal(f.reads, 1, 'admission never refreshes ready cache');
  assert.ok(f.calls.some((sql) => sql.includes('FOR SHARE OF c,s,m NOWAIT')));
});

test('count retry scope freezes hits and misses; distinct operation can see a newly ready label', async () => {
  const f = fixture();
  await withPresentationAliasScope(async () => {
    const first = await f.capture();
    f.rows[0].text = 'Changed name';
    assert.deepEqual(await f.capture(), first);
    assert.equal(f.reads, 1);
  });
  assert.equal(await f.capture(), undefined);
  await withPresentationAliasScope(async () => {
    const miss = await f.capture();
    f.rows[0].text = 'Brass pass';
    assert.equal(await f.capture(), miss);
  });
  assert.equal((await f.capture()).entries[0].text, 'Brass pass');
});

test('only exact current playable label paths are admissible; no arbitrary source, draft or text surfaces', async () => {
  for (const patch of [
    { source: { kind: 'adventure', id: randomUUID() } },
    { source: { kind: 'playable', id: randomUUID() } },
    { path: 'entity/key/description' },
    { path: 'message/a/text' },
    { path: 'draft/key/label' },
  ]) {
    const f = fixture();
    Object.assign(f.rows[0], patch);
    assert.equal(await f.capture(), undefined);
  }
  for (const patch of [
    { sourceText: 'different source' },
    { translationKey: 'chosen-by-client' },
    { partition: 'private-other-viewer' },
  ]) {
    const f = fixture();
    Object.assign(f.rows[0], patch);
    await assert.rejects(f.capture, /INVALID_PRESENTATION_ALIASES/);
  }
});

test('membership lifetime, revocation, current label and campaign/actor fences fail closed', async () => {
  for (const mutation of [
    (f) => {
      f.memberEpoch = 'rejoined';
    },
    (f) => {
      f.revoked = true;
    },
    (f) => {
      f.state.entities.key.label = 'Changed';
    },
  ]) {
    const f = fixture(),
      aliases = await f.capture();
    mutation(f);
    await assert.rejects(
      () =>
        assertPresentationAliasAuthority(
          f.client,
          f.campaignId,
          f.userId,
          'alice',
          aliases,
          f.input.text,
        ),
      /INVALID_PRESENTATION_ALIASES/,
    );
  }
  const f = fixture(),
    aliases = await f.capture();
  await assert.rejects(
    () => assertPresentationAliasAuthority(f.client, randomUUID(), f.userId, 'alice', aliases),
    /INVALID_PRESENTATION_ALIASES/,
  );
  await assert.rejects(
    () => assertPresentationAliasAuthority(f.client, f.campaignId, f.userId, 'bob', aliases),
    /INVALID_PRESENTATION_ALIASES/,
  );
  delete f.state.entities.key;
  await assertPresentationAliasAuthority(
    f.client,
    f.campaignId,
    f.userId,
    'alice',
    aliases,
    '*wait*',
  );
  await assert.rejects(
    () =>
      assertPresentationAliasAuthority(
        f.client,
        f.campaignId,
        f.userId,
        'alice',
        aliases,
        '*take Brass pass*',
      ),
    /INVALID_PRESENTATION_ALIASES/,
  );
});

test('legacy absent sidecar does not read source, add properties or require reader', async () => {
  const f = fixture();
  assert.equal(storedPresentationAliases({ contextHash: 'old' }), undefined);
  await assertPresentationAliasAuthority(
    { query: () => assert.fail('legacy must not query') },
    f.campaignId,
    f.userId,
    'alice',
    undefined,
  );
  assert.equal(
    await capturePresentationAliases(
      f.db,
      undefined,
      f.campaignId,
      f.campaign,
      f.state,
      'alice',
      f.userId,
      f.input,
    ),
    undefined,
  );
  assert.equal(f.reads, 0);
  assert.equal(f.calls.length, 0);
});

function runtime(f) {
  const quoted = [];
  const ai = {
    contextWindow: () => null,
    contextBudgetBytes: () => 1000000,
    contextFits: () => true,
    quote: async (_scope, context) => {
      quoted.push(structuredClone(context));
      if (f.countRetry) {
        f.countRetry = false;
        const error = new RuntimeMapCountRequired(
          JSON.stringify(context),
          'synthetic',
          'v1',
          () => assert.fail('no provider count'),
          () => {},
        );
        error.scope = _scope;
        error.context = context;
        error.stateHash = digest(f.state);
        throw error;
      }
      return {
        id: randomUUID(),
        credits: 0,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        demo: true,
        requiresConsent: false,
      };
    },
  };
  const live = { state: f.state, campaign: f.campaign, eventSeq: 0, paused: false };
  const port = {
    serial: (_id, work) => work(),
    access: async () => ({ user: { id: f.userId }, actorId: 'alice', ownerId: f.userId }),
    load: async () => live,
    presentationAliases: () => f.capture(),
  };
  port.dispatch = () => {};
  return { runtime: new StoryTurnRuntime(f.db, ai, port), quoted, live, ai, port };
}

test('runtime quote/count retry and durable replay reuse one immutable alias context without cache refresh', async () => {
  const f = fixture(),
    r = runtime(f);
  f.countRetry = true;
  const quote = await withPresentationAliasScope(() =>
    withRuntimeMapPreflight(
      () => r.runtime.quote({ headers: {} }, f.campaignId, f.input),
      async () => {
        f.rows[0].text = 'Changed in cache';
      },
    ),
  );
  assert.equal(quote.status, 'quoted');
  assert.equal(f.reads, 1);
  assert.deepEqual(r.quoted[0], r.quoted[1]);
  const evidence = f.turns[0].context.presentationAliases;
  assert.equal(evidence.entries[0].text, 'Brass pass');
  assert.equal(f.turns[0].input.text, f.input.text);
  const replay = await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  assert.deepEqual(replay, f.turns[0].quote_result);
  assert.equal(f.reads, 1);
});

function queueFixture(previous = false) {
  const context = { contextHash: 'a'.repeat(64) };
  const input = {
    scope: {
      campaignId: randomUUID(),
      npcId: 'alice',
      subjectKind: 'player',
      origin: 'user',
      purpose: 'story_turn',
      requesterUserId: randomUUID(),
    },
    operationId: randomUUID(),
    context,
  };
  const events = [],
    engine = Object.create(NpcAiEngine.prototype);
  engine.policy = { maxContextBytes: 100000 };
  engine.provider = {};
  engine.authorize = async () => {
    events.push('authorize');
  };
  const job = {
    id: randomUUID(),
    npc_id: 'alice',
    origin: 'user',
    subject_kind: 'player',
    requester_user_id: input.scope.requesterUserId,
    purpose: 'story_turn',
    context,
    request_meta: {},
    request_hash: digest({
      scope: input.scope,
      context,
      quoteId: null,
      consent: false,
      requestKey: '',
      sponsorId: null,
      runtimeRequestId: null,
      acceptedWorldBatchId: null,
    }),
  };
  const client = {
    query: async (sql) => {
      events.push(sql);
      return { rows: sql.includes('SELECT * FROM npc_ai_jobs') && previous ? [job] : [] };
    },
  };
  engine.db = {
    tx: async (work) => {
      events.push('begin');
      try {
        const result = await work(client);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  };
  engine.dto = async (_c, value) => ({ id: value.id });
  engine.requestPlan = async () => {
    events.push('plan');
    throw new Error('SYNTHETIC_STOP');
  };
  return { engine, input, events, job, client };
}

test('queue admission rejection rolls back before planning, reserves or new jobs; exact replay bypasses callback', async () => {
  const f = queueFixture();
  await assert.rejects(
    () =>
      f.engine.queue(f.input, async (c) => {
        assert.equal(c, f.client);
        f.events.push('alias-admission');
        throw new Error('REVOKED_ALIAS');
      }),
    /REVOKED_ALIAS/,
  );
  assert.equal(f.events.at(-1), 'rollback');
  assert.equal(f.events.filter((v) => v === 'alias-admission').length, 1);
  assert.ok(!f.events.includes('plan'));
  assert.ok(!f.events.some((v) => /INSERT|UPDATE|spark_holds/.test(v)));
  const replay = queueFixture(true);
  assert.deepEqual(
    await replay.engine.queue(replay.input, async () => assert.fail('no replay admission')),
    { id: replay.job.id },
  );
  assert.equal(replay.events.at(-1), 'commit');
  assert.ok(!replay.events.includes('plan'));
});

test('speech-only NPC target does not capture aliases or alter its isolated voice context', async () => {
  const f = fixture();
  f.input = { ...f.input, text: 'Brass pass', targetNpcId: 'keeper' };
  assert.equal(await f.capture(), undefined);
  assert.equal(f.reads, 0);
  assert.equal(f.calls.length, 0);
});

test('stored runtime scheduling pins quote evidence and rejects changed authority inside native admission', async () => {
  const f = fixture(),
    r = runtime(f);
  await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  const turn = f.turns[0];
  turn.status = 'queued';
  r.runtime.row = async () => turn;
  let queued;
  r.ai.queue = async (input, admission) => {
    await admission(f.client);
    queued = structuredClone(input);
  };
  f.rows[0].text = 'Changed after quote';
  await r.runtime.schedule(f.campaignId, r.live, { id: turn.id });
  assert.deepEqual(queued.context, turn.context);
  assert.equal(f.reads, 1);
  queued = undefined;
  f.memberEpoch = 'new-membership';
  await r.runtime.schedule(f.campaignId, r.live, { id: turn.id });
  assert.equal(queued, undefined);
  assert.equal(f.reads, 1);
  assert.ok(f.calls.some((sql) => sql.includes("SET status='stale'")));
});

test('quotes created without bridge preserve their no-sidecar context when bridge becomes available', async () => {
  const f = fixture(),
    r = runtime(f);
  delete r.port.presentationAliases;
  f.input.text = '*take Старинный пропуск*';
  const old = await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  assert.equal(Object.hasOwn(f.turns[0].context, 'presentationAliases'), false);
  r.port.presentationAliases = () => {
    throw Error('legacy replay must not capture');
  };
  assert.deepEqual(await r.runtime.quote({ headers: {} }, f.campaignId, f.input), old);
  assert.equal(f.reads, 0);
});

test('translated existing-map input routes to free local travel, never a new generated scene', async () => {
  const f = fixture(),
    r = runtime(f);
  const map = Object.values(f.state.maps).find((map) => map.id !== f.state.entities.alice.mapId);
  f.input.text = '*go to Archive*';
  f.rows = [
    {
      ...f.rows[0],
      path: `map/${encodeURIComponent(map.id)}/label`,
      sourceText: map.label ?? map.id,
      text: 'Archive',
    },
  ];
  const quote = await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.travel.generationRequired, false);
  assert.equal(quote.quote.provider, 'local-turn-resolver');
  assert.equal(r.quoted.length, 0);
  assert.equal(f.turns[0].context.presentationAliases.entries[0].id, map.id);
  assert.equal(f.state.entities.alice.mapId, 'observatory', 'quote never commits movement');
});

test('old quote replay rechecks locked ACL after initial access and does not expose erased content', async () => {
  const f = fixture(),
    r = runtime(f);
  await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  f.accessRevoked = true;
  await assert.rejects(() => r.runtime.quote({ headers: {} }, f.campaignId, f.input), /FORBIDDEN/);
  assert.equal(f.reads, 1);
  f.accessRevoked = false;
  f.turns[0].erased_at = new Date();
  await assert.rejects(
    () => r.runtime.quote({ headers: {} }, f.campaignId, f.input),
    /DATA_ERASED/,
  );
  assert.equal(f.reads, 1);
});

test('final alias lifetime rejection terminalizes the exact ready job without publishing or mutating canon', async () => {
  const f = fixture(),
    r = runtime(f);
  await r.runtime.quote({ headers: {} }, f.campaignId, f.input);
  const turn = f.turns[0];
  turn.status = 'queued';
  turn.decision_request_id = turn.id;
  const jobId = randomUUID(),
    before = structuredClone(f.state),
    finalized = [];
  r.runtime.row = async () => turn;
  const originalQuery = f.client.query;
  f.client.query = async (sql, args) => {
    if (sql.startsWith('SELECT status,job_id FROM game_npc_decision_requests'))
      return { rows: [{ status: 'scheduled', job_id: jobId }] };
    return originalQuery(sql, args);
  };
  r.ai.finalize = async (_c, id, status) => {
    finalized.push({ id, status });
  };
  let published = false;
  r.port.persist = async (_id, live, next, _kind, extra, preflight) => {
    await preflight(f.client);
    await extra(f.client);
    live.state = next;
    published = true;
  };
  const proposal = {
    turnId: turn.id,
    contextHash: turn.context.contextHash,
    status: 'ready',
    code: null,
    steps: [{ segmentIndex: 0, action: { kind: 'pick_up', targetId: 'key' }, reply: null }],
    narrative: {
      narration: 'The pass is picked up.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  f.memberEpoch = 'rejoined-before-application';
  await r.runtime.complete(f.campaignId, r.live, {
    id: jobId,
    npcId: 'alice',
    requesterUserId: f.userId,
    context: turn.context,
    contextHash: turn.context.contextHash,
    proposal,
  });
  assert.deepEqual(finalized, [{ id: jobId, status: 'stale' }]);
  assert.equal(published, false);
  assert.deepEqual(f.state, before);
  assert.ok(
    f.calls.some((sql) => sql.includes("UPDATE game_npc_decision_requests SET status='failed'")),
  );
  assert.equal(f.reads, 1);
});
