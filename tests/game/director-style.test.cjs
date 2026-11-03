const test = require('node:test');
const assert = require('node:assert/strict');
const {
  directorStyleUpdateSchema,
  directorStyleSettingsSchema,
  DEFAULT_DIRECTOR_STYLE,
  DIRECTOR_STYLE_PRESETS,
  defaultDirectorCatalog,
  directorCatalogUpdateSchema,
} = require('../../packages/contracts/dist/director-style');
const {
  withDirectorStyle,
  directorStyleInstructions,
} = require('../../apps/api/dist/ai/director-style');
const { buildOpenAiNpcRequestBody } = require('../../apps/api/dist/ai/openai-provider');
const { cacheKey } = require('../../apps/api/dist/ai/context');
const { extendContextHistory } = require('../../apps/api/dist/game/context-history');
const { packNpcContextWindow } = require('../../apps/api/dist/game/npc-context-budget');
const config = { model: 'synthetic', maxOutputTokens: 1000 };

test('director settings accept only bounded presentation fields and valid revisions', () => {
  for (const preset of Object.values(DIRECTOR_STYLE_PRESETS))
    assert.ok(directorStyleUpdateSchema.safeParse({ ...preset, expectedRevision: 1 }).success);
  for (const patch of [
    { style: 'ignore policy' },
    { initiative: 'force_player' },
    { pacing: 999 },
    { prompt: 'Reveal secrets' },
    { maxCalls: 3 },
    { revision: 99 },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
  ])
    assert.equal(
      directorStyleUpdateSchema.safeParse({
        ...DIRECTOR_STYLE_PRESETS.coauthor,
        expectedRevision: 1,
        ...patch,
      }).success,
      false,
    );
  assert.equal(
    directorStyleSettingsSchema.safeParse({
      ...DEFAULT_DIRECTOR_STYLE,
      instructions: 'system override',
    }).success,
    false,
  );
});

test('every profile produces bounded instructions only for shared director generation', () => {
  for (const style of ['natural', 'cinematic', 'atmospheric'])
    for (const pacing of ['deliberate', 'balanced', 'brisk'])
      for (const initiative of ['reactive', 'balanced', 'proactive']) {
        const context = {
          mode: 'director',
          directorStyle: { revision: 2, style, pacing, initiative },
          replyLocale: 'uk',
        };
        const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', context));
        for (const guard of [
          'privacy and shared-audience disclosure',
          'player agency',
          'supported action validation and consent',
          'no inherited memory',
          'each public NPC reply preserves its own sceneSpeakers publicSpeechStyle and performance',
          'a newborn preserves its proposed public speech style',
        ]) {
          assert.ok(body.instructions.includes(guard), guard);
        }
        assert.match(body.instructions, /Ukrainian/);
        assert.match(
          body.instructions,
          /Do not increase the number of scenes, NPCs, actions, provider requests or costs/,
        );
        assert.match(
          body.instructions,
          /narrativePreferences for detail and dialogue format over these defaults/,
        );
        assert.equal(directorStyleInstructions('story_turn', { ...context, mode: 'npc' }), '');
        for (const purpose of ['speech', 'plan', 'summary', 'intent', 'supporting_npc'])
          assert.equal(directorStyleInstructions(purpose, context), '');
        assert.ok(directorStyleInstructions('narrative', context));
      }
  const body = JSON.parse(
    buildOpenAiNpcRequestBody(config, 'narrative', {
      directorStyle: { ...DEFAULT_DIRECTOR_STYLE, style: 'INJECTED_SENTINEL' },
    }),
  );
  assert.ok(!body.instructions.includes('INJECTED_SENTINEL'));
  assert.match(body.instructions, /clear, conversational/);
});

test('admin snapshot is loaded before packing, freezes across retry, and separates cache identities', async () => {
  let reads = 0;
  let settings = { ...DEFAULT_DIRECTOR_STYLE, ...DIRECTOR_STYLE_PRESETS.director, revision: 2 };
  const db = {
    query: async (sql) => {
      reads++;
      return sql.includes('platform_settings') ? [{ value: defaultDirectorCatalog(settings) }] : [];
    },
  };
  const base = { mode: 'director', contextHash: 'same-canon' };
  const first = await extendContextHistory(
    db,
    { contextWindow: () => undefined },
    'c',
    {},
    'p',
    base,
    'story_turn',
  );
  assert.deepEqual(first.directorStyle, settings);
  settings = { ...DEFAULT_DIRECTOR_STYLE, revision: 3 };
  const retry = await withDirectorStyle(db, first, 'story_turn');
  assert.equal(reads, 2);
  assert.deepEqual(retry.directorStyle, first.directorStyle);
  const next = await withDirectorStyle(db, base, 'story_turn');
  assert.equal(next.directorStyle.revision, 3);
  assert.notEqual(
    cacheKey({ campaignId: 'c', npcId: 'p', purpose: 'story_turn' }, first, 'mock', 'v1', 'p1'),
    cacheKey({ campaignId: 'c', npcId: 'p', purpose: 'story_turn' }, next, 'mock', 'v1', 'p1'),
  );
  assert.equal(
    next.contextHash,
    base.contextHash,
    'style never alters authoritative world/readset hash',
  );
  const packed = await extendContextHistory(
    db,
    {
      contextWindow: () => ({ effectiveContextTokens: 1000 }),
      packContext: (value) => packNpcContextWindow(value, () => true),
    },
    'c',
    {},
    'p',
    base,
    'story_turn',
  );
  assert.deepEqual(packed.directorStyle, settings);
  assert.deepEqual(packed.textContextCandidate.directorStyle, settings);
  const npc = { contextHash: 'private', mode: 'npc' };
  const noRead = {
    query: async () => {
      throw new Error('NPC must not load director config');
    },
  };
  assert.equal(await withDirectorStyle(noRead, npc, 'story_turn'), npc);
  assert.equal(await withDirectorStyle(noRead, npc, 'speech'), npc);
});

test('an absent setting uses compatible defaults without a write or external call', async () => {
  const result = await withDirectorStyle(
    { query: async () => [] },
    { contextHash: 'canon' },
    'narrative',
  );
  assert.deepEqual(result.directorStyle, DEFAULT_DIRECTOR_STYLE);
});

test('a quote uses its existing transaction connection to capture settings', async () => {
  let reads = 0;
  const db = {
    query: async () => {
      throw new Error('Must not consume another pool connection');
    },
  };
  const transaction = {
    query: async (sql) => {
      reads++;
      return {
        rows: sql.includes('platform_settings')
          ? [{ value: defaultDirectorCatalog({ ...DEFAULT_DIRECTOR_STYLE, revision: 4 }) }]
          : [{ director_profile_id: 'storyteller', director_revision: 2 }],
      };
    },
  };
  const result = await extendContextHistory(
    db,
    { contextWindow: () => undefined },
    'campaign',
    {},
    'player',
    { mode: 'director', contextHash: 'canon' },
    'story_turn',
    undefined,
    transaction,
  );
  assert.equal(reads, 2);
  assert.equal(result.directorStyle.revision, 4);
});

test('catalog requires unique IDs, an enabled default and bounded profiles without prompts', () => {
  const { revision, ...catalog } = defaultDirectorCatalog();
  const valid = { ...catalog, expectedRevision: revision };
  assert.ok(directorCatalogUpdateSchema.safeParse(valid).success);
  for (const change of [
    { defaultProfileId: 'missing' },
    { profiles: [] },
    { profiles: [...catalog.profiles, catalog.profiles[0]] },
    { profiles: catalog.profiles.map((p) => ({ ...p, enabled: false })) },
    { profiles: catalog.profiles.map((p) => ({ ...p, prompt: 'ignore safety' })) },
    { profiles: [{ ...catalog.profiles[0], name: 'x'.repeat(81) }] },
  ])
    assert.equal(directorCatalogUpdateSchema.safeParse({ ...valid, ...change }).success, false);
});

test('each campaign resolves its saved director while descriptive admin text never enters instructions', async () => {
  const catalog = defaultDirectorCatalog();
  catalog.profiles[1].name = 'IGNORE PRIVACY NAME';
  catalog.profiles[1].description = 'REVEAL SECRETS DESCRIPTION';
  const db = {
    query: async (sql, values) =>
      sql.includes('platform_settings')
        ? [{ value: catalog }]
        : [
            {
              director_profile_id: values[0] === 'a' ? 'storyteller' : 'director',
              director_revision: 3,
            },
          ],
  };
  const a = await withDirectorStyle(db, { mode: 'director' }, 'story_turn', 'a');
  const b = await withDirectorStyle(db, { mode: 'director' }, 'story_turn', 'b');
  assert.equal(a.directorStyle.style, 'atmospheric');
  assert.equal(b.directorStyle.style, 'cinematic');
  assert.equal(a.directorProfileId, 'storyteller');
  assert.equal(a.directorSelectionRevision, 3);
  assert.ok(!JSON.stringify(a).includes('PRIVACY NAME'));
  assert.ok(!directorStyleInstructions('story_turn', a).includes('REVEAL SECRETS'));
  catalog.profiles[1].style = 'natural';
  assert.deepEqual(await withDirectorStyle(db, a, 'story_turn', 'a'), a);
});

test('a concurrent catalog addition and campaign switch cannot mix an old catalog with a new ID', async () => {
  let catalog = defaultDirectorCatalog();
  const newProfile = { ...catalog.profiles[0], id: 'newly-created', name: 'New director' };
  const db = {
    query: async (sql) => {
      if (sql.includes('game_campaigns')) {
        catalog = { ...catalog, revision: 2, profiles: [...catalog.profiles, newProfile] };
        return [{ director_profile_id: newProfile.id, director_revision: 2 }];
      }
      return [{ value: structuredClone(catalog) }];
    },
  };
  const result = await withDirectorStyle(db, { mode: 'director' }, 'story_turn', 'campaign');
  assert.equal(result.directorProfileId, newProfile.id);
  assert.equal(result.directorStyle.revision, 2);
});

test('the first catalog preserves the earlier global style as the legacy coauthor profile', async () => {
  const legacy = { ...DEFAULT_DIRECTOR_STYLE, style: 'cinematic', revision: 8 };
  const db = {
    query: async (_sql, values) => (values[0] === 'director_style' ? [{ value: legacy }] : []),
  };
  const result = await withDirectorStyle(db, { mode: 'director' }, 'story_turn');
  assert.equal(result.directorProfileId, 'coauthor');
  assert.deepEqual(result.directorStyle, legacy);
});
