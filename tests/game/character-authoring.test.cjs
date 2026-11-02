const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const c = require('../../packages/contracts/dist');
const core = require('../../packages/game-core/dist');
const { compileStoryPlan } = require('../../apps/api/dist/game/story-plan');
const { applyAuthoredCharacters } = require('../../apps/api/dist/game/character-authoring');
const configModule = require.resolve('../../apps/api/dist/config');
require.cache[configModule] = {
  id: configModule,
  filename: configModule,
  loaded: true,
  exports: { config: { DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect' } },
};
const { adventureView } = require('../../apps/api/dist/content');
const { StoryNpcService } = require('../../apps/api/dist/story-authoring/npcs');
function fixture() {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const npcs = ids.map((id, i) => ({
    id,
    name: ['Guard', 'Friend', 'Scout'][i],
    role: 'Person',
    description: '',
    appearance: '',
    characterProfile: {
      version: 1,
      initialGoal: i === 1 ? 'help' : 'patrol',
      personality: {
        role: ['guard', 'helper', 'patrol'][i],
        values: [i === 1 ? 'kindness' : 'caution'],
        taboos: ['disclose_private'],
        speechStyle: '',
        publicSpeechStyle: ['terse', 'warm', 'wry'][i],
        biography: 'PRIVATE_BIO_' + i,
        characterization: {
          version: 1,
          motives: [{ kind: ['protect', 'care', 'discover'][i], priority: 5 }],
          reactions: [],
          publicVoice: {
            cadence: ['brief', 'balanced', 'elaborate'][i],
            register: 'plain',
            humor: 'none',
          },
          dialogueExamples: [{ situation: 'refusal', text: 'PRIVATE_EXAMPLE_' + i }],
        },
      },
    },
  }));
  const content = c.contentSchema.parse({
    npcIds: ids,
    locations: [{ id: 'room', name: 'Room' }],
    lorebook: [
      {
        id: 'secret',
        title: 'PRIVATE_LORE_TITLE',
        text: 'PRIVATE_LORE_TEXT',
        disclosure: 'never',
        knowerNpcIds: [ids[0]],
        topics: ['key'],
        locationId: 'room',
      },
    ],
  });
  const source = { title: 'Character fixture', content, npcs };
  const proposal = {
    version: 1,
    rooms: [
      {
        locationId: 'room',
        width: 24,
        height: 24,
        spawns: [
          { x: 2, y: 2 },
          { x: 3, y: 2 },
          { x: 2, y: 3 },
          { x: 3, y: 3 },
        ],
        blocked: [],
        surfaces: [],
      },
    ],
    connections: [],
    npcs: ids.map((sourceNpcId, i) => ({
      sourceNpcId,
      locationId: 'room',
      x: 5 + i,
      y: 5,
      stock: [],
    })),
    items: [],
  };
  return { ids, source, proposal };
}
test('three typed author profiles survive real story compiler into distinct immutable private brains', () => {
  const f = fixture();
  const built = compileStoryPlan(f.source, f.proposal);
  assert.deepEqual(
    built.draft.npcs.map((n) => n.goal),
    ['patrol', 'help', 'patrol'],
  );
  assert.deepEqual(
    f.ids.map((id) => built.playable.npcBrains[id].living.personality.role),
    ['guard', 'helper', 'patrol'],
  );
  for (const [i, id] of f.ids.entries()) {
    assert.equal(
      built.playable.npcBrains[id].living.personality.characterization.dialogueExamples[0].text,
      'PRIVATE_EXAMPLE_' + i,
    );
  }
  const saved = JSON.stringify(built.playable);
  f.source.npcs[0].characterProfile.personality.biography = 'EDIT_AFTER_RELEASE';
  assert.equal(JSON.stringify(built.playable), saved);
  const state = core.createStateFromPlayable(JSON.parse(saved), ['player']);
  assert.doesNotMatch(
    JSON.stringify(core.projectState(state, 'player')),
    /PRIVATE_BIO|PRIVATE_EXAMPLE|PRIVATE_LORE/,
  );
});
test('lore knowledge gate precedes relevance and public disclosure never grants universal knowledge', () => {
  const f = fixture();
  f.source.content.lorebook[0].disclosure = 'public';
  const built = compileStoryPlan(f.source, f.proposal);
  assert.equal(
    built.playable.npcBrains[f.ids[0]].living.observations.filter((o) => o.kind === 'authored_fact')
      .length,
    1,
  );
  for (const id of f.ids.slice(1))
    assert.equal(
      built.playable.npcBrains[id].living.observations.filter((o) => o.kind === 'authored_fact')
        .length,
      0,
    );
  const unknown = c.previewStoryLore(
    f.source.content.lorebook,
    f.ids[1],
    'PRIVATE_LORE_TEXT',
    'room',
  )[0];
  assert.deepEqual(unknown, { id: 'secret', included: false, reason: 'not_known' });
  assert.equal(
    c.previewStoryLore(f.source.content.lorebook, f.ids[0], 'key', 'room')[0].included,
    true,
  );
  assert.equal(
    c.previewStoryLore(f.source.content.lorebook, f.ids[0], 'key', 'elsewhere')[0].reason,
    'not_relevant',
  );
});
test('new publication clears removed story lore and explicit profile reset without mutating old package', () => {
  const f = fixture();
  const built = compileStoryPlan(f.source, f.proposal),
    old = JSON.stringify(built.playable);
  f.source.npcs[0].characterProfile = null;
  applyAuthoredCharacters(built.draft, f.source.npcs, []);
  assert.equal(built.draft.npcs[0].personality, undefined);
  assert.equal(built.draft.npcs[0].initialFacts.length, 0);
  assert.equal(JSON.stringify(built.playable), old);
  assert.equal(c.npcSchema.parse({ name: 'Reset', characterProfile: null }).characterProfile, null);
  assert.equal(Object.hasOwn(c.npcSchema.parse({ name: 'Legacy' }), 'characterProfile'), false);
});
test('foreign, duplicate and malformed lore references cannot compile', () => {
  const f = fixture();
  f.source.content.lorebook[0].knowerNpcIds = [randomUUID()];
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SOURCE_MISMATCH/);
  for (const patch of [
    { knowerNpcIds: [] },
    { knowerNpcIds: [f.ids[0], f.ids[0]] },
    { id: '__proto__' },
    { topics: ['x'.repeat(41)] },
  ])
    assert.equal(
      c.storyLoreEntrySchema.safeParse({ ...fixture().source.content.lorebook[0], ...patch })
        .success,
      false,
    );
});
test('reader projections strip lore from live/public/private snapshots but owner retains author data', () => {
  const f = fixture(),
    data = { title: 'Story', synopsis: '', content: f.source.content };
  const row = {
    id: randomUUID(),
    owner_id: randomUUID(),
    title: 'Story',
    synopsis: '',
    visibility: 'private',
    status: 'draft',
    data,
    private_snapshot: data,
    published_snapshot: data,
    created_at: new Date(),
    updated_at: new Date(),
  };
  assert.ok(adventureView(row).content.lorebook);
  assert.equal(adventureView(row, true).content.lorebook, undefined);
  assert.equal(adventureView(row, false, true).content.lorebook, undefined);
  assert.equal(adventureView({ ...row, visibility: 'public' }, true).content.lorebook, undefined);
});
test('owner lore preview validates actual ownership and never invokes a provider or reads campaign state', async () => {
  const f = fixture(),
    owner = randomUUID(),
    storyId = randomUUID();
  let statements = [];
  const db = {
    tx: async (fn) =>
      fn({
        query: async (sql, p) => {
          statements.push(sql);
          if (sql.startsWith('SELECT * FROM adventures'))
            return {
              rows:
                p[1] === owner
                  ? [
                      {
                        id: storyId,
                        data: c.adventureSchema.parse({
                          title: f.source.title,
                          content: f.source.content,
                        }),
                        edit_revision: 7,
                      },
                    ]
                  : [],
              rowCount: p[1] === owner ? 1 : 0,
            };
          if (sql.startsWith('SELECT id FROM npcs'))
            return { rows: f.ids.map((id) => ({ id })), rowCount: f.ids.length };
          throw Error('Unexpected query: ' + sql);
        },
      }),
  };
  const service = new StoryNpcService(db);
  const result = await service.previewLore(owner, storyId, {
    npcId: f.ids[0],
    query: 'key',
    locationId: 'room',
  });
  assert.equal(result.storyEditRevision, 7);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.entries[0].included, true);
  await assert.rejects(() => service.previewLore(randomUUID(), storyId, { npcId: f.ids[0] }));
  await assert.rejects(() => service.previewLore(owner, storyId, { npcId: randomUUID() }));
  assert.ok(statements.every((sql) => sql.startsWith('SELECT') && !sql.includes('campaign')));
});
test('real freeze binds current complete author profile and lore into a new checksum, never overwrites old versions', async () => {
  const { PlayableService } = require('../../apps/api/dist/game/playable.service');
  const f = fixture(),
    built = compileStoryPlan(f.source, f.proposal),
    owner = randomUUID(),
    storyId = randomUUID();
  const oldDraft = structuredClone(built.draft);
  const versions = [];
  let rows = f.source.npcs.map((n) => ({
    id: n.id,
    data: c.npcSchema.parse(Object.fromEntries(Object.entries(n).filter(([key]) => key !== 'id'))),
  }));
  // npcSchema is strict: the source ID belongs to the database row, not its JSON data.
  const query = async (sql, p) => {
    if (sql.startsWith('SELECT draft,revision'))
      return { rows: [{ draft: oldDraft, revision: 4 }] };
    if (sql.startsWith('SELECT id FROM npcs'))
      return { rows: rows.map((n) => ({ id: n.id })), rowCount: rows.length };
    if (sql.startsWith('SELECT id,data FROM npcs'))
      return { rows: structuredClone(rows), rowCount: rows.length };
    if (sql.startsWith('SELECT id FROM game_playable_versions'))
      return { rows: versions.filter((v) => v.checksum === p[3]).map((v) => ({ id: v.id })) };
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: versions.length }] };
    if (sql.startsWith('INSERT INTO game_playable_versions')) {
      versions.push({ id: p[0], payload: JSON.parse(p[4]), checksum: p[5] });
      return { rows: [] };
    }
    throw Error('Unexpected query ' + sql);
  };
  const art = {
    prepareManifestTx: async () => ({ draftRevision: 0, bindings: [] }),
    pinPrepared: async () => {},
  };
  const service = new PlayableService({}, {}, art),
    story = {
      id: storyId,
      owner_id: owner,
      title: f.source.title,
      data: c.adventureSchema.parse({ title: f.source.title, content: f.source.content }),
    };
  delete rows[0].data.characterProfile.personality.biography;
  rows[0].data.personality = 'PRIVATE_LEGACY_PERSONALITY';
  rows[0].data.biography = 'PRIVATE_BACKSTORY';
  const first = await service.freeze({ query }, story, 'private', 4, 0);
  assert.equal(
    versions[0].payload.compiled.npcBrains[f.ids[0]].living.personality.biography,
    'PRIVATE_LEGACY_PERSONALITY\nPRIVATE_BACKSTORY',
  );
  assert.doesNotMatch(
    JSON.stringify(
      core.projectState(
        core.createStateFromPlayable(versions[0].payload.compiled, ['player']),
        'player',
      ),
    ),
    /PRIVATE_LEGACY_PERSONALITY|PRIVATE_BACKSTORY/,
  );
  const immutable = JSON.stringify(versions[0]);
  rows[0].data.characterProfile.personality.characterization.publicVoice.cadence = 'elaborate';
  const second = await service.freeze({ query }, story, 'private', 4, 0);
  assert.notEqual(first, second);
  assert.notEqual(versions[0].checksum, versions[1].checksum);
  assert.equal(JSON.stringify(versions[0]), immutable);
  assert.equal(
    versions[1].payload.compiled.npcBrains[f.ids[0]].living.personality.characterization.publicVoice
      .cadence,
    'elaborate',
  );
  assert.ok(versions[1].payload.source.content.lorebook);
  assert.equal(JSON.stringify(oldDraft), JSON.stringify(built.draft));
});
test('profile replacement removes stale derived goals; explicit clear restores manual baseline exactly', () => {
  const f = fixture(),
    draft = compileStoryPlan(
      { ...f.source, npcs: f.source.npcs.map((n) => ({ ...n, characterProfile: undefined })) },
      f.proposal,
    ).draft;
  const manual = {
    role: 'patrol',
    values: ['duty'],
    taboos: [],
    speechStyle: 'MANUAL_PRIVATE',
    publicSpeechStyle: 'formal',
  };
  const goal = {
    id: 'manual',
    kind: 'patrol',
    priority: 2,
    motivation: 'routine',
    when: [],
    success: [],
    cancelWhen: [],
    holdTicks: 5,
  };
  draft.npcs[0].personality = manual;
  draft.npcs[0].initialGoals = [goal];
  draft.npcs[0].goal = 'patrol';
  const baseline = structuredClone({ personality: manual, initialGoals: [goal], goal: 'patrol' });
  f.source.npcs[0].characterProfile.initialGoals = [{ ...goal, id: 'derived' }];
  applyAuthoredCharacters(draft, f.source.npcs, []);
  assert.equal(draft.npcs[0].initialGoals[0].id, 'derived');
  delete f.source.npcs[0].characterProfile.initialGoals;
  applyAuthoredCharacters(draft, f.source.npcs, []);
  assert.equal(draft.npcs[0].initialGoals, undefined);
  f.source.npcs[0].characterProfile = null;
  applyAuthoredCharacters(draft, f.source.npcs, []);
  assert.deepEqual(draft.npcs[0].personality, baseline.personality);
  assert.deepEqual(draft.npcs[0].initialGoals, baseline.initialGoals);
  assert.equal(draft.npcs[0].goal, baseline.goal);
  assert.equal(draft.npcs[0].characterSource, undefined);
  const result = core.compilePlayableDraft(draft);
  assert.ok(result.playable, result.errors.join(';'));
  assert.doesNotMatch(
    JSON.stringify(
      core.projectState(core.createStateFromPlayable(result.playable, ['player']), 'player'),
    ),
    /characterSource|MANUAL_PRIVATE/,
  );
});

test('duplicate uses complete NPC map for forward/cyclic profile and lore references', async () => {
  const { ContentController } = require('../../apps/api/dist/content');
  const f = fixture();
  const owner = randomUUID();
  const storyId = randomUUID();
  // UUIDs beginning with a letter also exercise existing authored entity-reference slots.
  const ids = ['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'];
  const profiles = f.source.npcs.slice(0, 2).map((npc, i) => ({
    ...npc.characterProfile,
    personality: {
      ...npc.characterProfile.personality,
      links: [{ npcId: ids[1 - i], relation: 'ally' }],
    },
    initialGoals: [
      {
        id: 'guard',
        kind: 'investigate',
        targetId: ids[1 - i],
        priority: 3,
        motivation: 'duty',
        when: [{ kind: 'near_entity', entityId: ids[1 - i] }],
        success: [],
        cancelWhen: [],
        holdTicks: 1,
      },
    ],
  }));
  const lore = [{ ...f.source.content.lorebook[0], knowerNpcIds: ids, topicEntityId: ids[1] }];
  const data = c.adventureSchema.parse({
    title: 'Duplicate',
    content: { ...f.source.content, npcIds: ids, lorebook: lore },
  });
  const original = structuredClone({ data, profiles });
  let insertedStory;
  const insertedNpcs = [];
  const db = {
    tx: async (fn) =>
      fn({
        query: async (sql, p) => {
          if (sql.startsWith('SELECT * FROM adventures'))
            return { rows: [{ id: storyId, title: 'Duplicate', data }] };
          if (sql.startsWith('SELECT * FROM npcs'))
            return {
              rows: ids.map((id, i) => ({
                id,
                story_id: storyId,
                source_template_id: null,
                data: { name: 'Person', characterProfile: profiles[i] },
              })),
            };
          if (sql.startsWith('INSERT INTO adventures'))
            insertedStory = {
              id: p[0],
              owner_id: owner,
              data: JSON.parse(p[7]),
              created_at: new Date(),
              updated_at: new Date(),
            };
          else if (sql.startsWith('INSERT INTO npcs'))
            insertedNpcs.push({ id: p[0], data: JSON.parse(p[4]) });
          else if (sql.startsWith('UPDATE adventures')) insertedStory.data = JSON.parse(p[1]);
          else throw Error(sql);
          return { rows: [] };
        },
      }),
  };
  const controller = new ContentController(
    db,
    { require: async () => ({ id: owner }) },
    { own: async () => insertedStory },
    {},
  );
  await controller.duplicate(storyId, {});
  assert.equal(c.validateStoryLoreReferences(insertedStory.data.content), true);
  c.adventureSchema.parse(insertedStory.data);
  const copiedIds = insertedStory.data.content.npcIds;
  assert.deepEqual(
    copiedIds,
    insertedNpcs.map((npc) => npc.id),
  );
  assert.deepEqual(insertedStory.data.content.lorebook[0].knowerNpcIds, copiedIds);
  assert.equal(insertedStory.data.content.lorebook[0].topicEntityId, copiedIds[1]);
  for (let i = 0; i < 2; i++) {
    const profile = c.npcCharacterProfileSchema.parse(insertedNpcs[i].data.characterProfile);
    assert.equal(profile.personality.links[0].npcId, copiedIds[1 - i]);
    assert.equal(profile.initialGoals[0].targetId, copiedIds[1 - i]);
    assert.equal(profile.initialGoals[0].when[0].entityId, copiedIds[1 - i]);
    assert.equal(profile.personality.biography, profiles[i].personality.biography);
  }
  assert.deepEqual({ data, profiles }, original);
  const {
    remapCopiedCharacterProfile,
    remapCopiedStoryLore,
  } = require('../../apps/api/dist/game/character-authoring');
  assert.deepEqual(remapCopiedCharacterProfile(profiles[0], new Map()), profiles[0]);
  assert.deepEqual(remapCopiedStoryLore(lore, new Map()), lore);
});

test('source UUID references compile to runtime entities while item/goal/location references stay unchanged', () => {
  const f = fixture();
  const sourceId = '10000000-0000-4000-8000-000000000001';
  const priorId = f.ids[1];
  f.source.npcs[1].id = sourceId;
  f.source.content.npcIds[1] = sourceId;
  f.proposal.npcs.find((npc) => npc.sourceNpcId === priorId).sourceNpcId = sourceId;
  f.source.npcs[0].characterProfile.initialGoals = [
    {
      id: 'guard',
      kind: 'investigate',
      targetId: sourceId,
      priority: 3,
      motivation: 'duty',
      when: [{ kind: 'near_entity', entityId: sourceId }],
      success: [{ kind: 'observed', event: 'helped', targetId: sourceId }],
      cancelWhen: [],
      holdTicks: 1,
    },
  ];
  f.source.npcs[0].characterProfile.promiseTemplates = [
    {
      id: 'inspect',
      promisedAction: { kind: 'inspect', targetId: sourceId },
      offerOn: 'addressed',
      conditions: [{ kind: 'near_entity', entityId: sourceId }],
      dueTicks: 10,
      requiresAcceptance: true,
    },
  ];
  f.source.content.lorebook[0].topicEntityId = sourceId;
  const { draft, playable } = compileStoryPlan(f.source, f.proposal);
  const reloaded = core.createStateFromPlayable(JSON.parse(JSON.stringify(playable)), ['player']);
  assert.equal(reloaded.npcBrains[f.ids[0]].living.goalDefinitions[0].targetId, sourceId);
  const entity = draft.npcs.find((npc) => npc.sourceNpcId === sourceId).id;
  const guard = draft.npcs.find((npc) => npc.sourceNpcId === f.ids[0]);
  assert.equal(guard.initialGoals[0].targetId, entity);
  assert.equal(guard.initialGoals[0].when[0].entityId, entity);
  assert.equal(guard.initialGoals[0].success[0].targetId, entity);
  assert.equal(guard.promiseTemplates[0].promisedAction.targetId, entity);
  assert.equal(guard.promiseTemplates[0].conditions[0].entityId, entity);
  assert.equal(guard.initialFacts[0].topicEntityId, entity);
  c.authoredGameDraftSchema.parse(draft);
  const { remapCopiedCharacterProfile } = require('../../apps/api/dist/game/character-authoring');
  const profile = structuredClone(f.source.npcs[0].characterProfile);
  profile.initialGoals[0].targetId = 'door';
  profile.initialGoals[0].itemId = 'key';
  profile.initialGoals[0].fallbackGoalId = 'return';
  const copy = remapCopiedCharacterProfile(profile, new Map([[sourceId, randomUUID()]]));
  assert.equal(copy.initialGoals[0].targetId, 'door');
  assert.equal(copy.initialGoals[0].itemId, 'key');
  assert.equal(copy.initialGoals[0].fallbackGoalId, 'return');
});

test('maximum author lore ID compiles within the prefixed runtime identifier bound', () => {
  const f = fixture();
  f.source.content.lorebook[0].id = 'a'.repeat(53);
  assert.equal(c.storyLoreEntrySchema.safeParse(f.source.content.lorebook[0]).success, true);
  const built = compileStoryPlan(f.source, f.proposal);
  assert.equal(built.draft.npcs[0].initialFacts[0].id.length, 64);
  f.source.content.lorebook[0].id += 'a';
  assert.equal(c.storyLoreEntrySchema.safeParse(f.source.content.lorebook[0]).success, false);
});

test('lore relevance accepts the actual runtime map identifier domain', () => {
  const f = fixture();
  const mapId = '1' + 'r'.repeat(79);
  f.source.content.locations[0].id = mapId;
  f.source.content.lorebook[0].locationId = mapId;
  f.proposal.rooms[0].locationId = mapId;
  f.proposal.npcs.forEach((npc) => {
    npc.locationId = mapId;
  });
  const built = compileStoryPlan(f.source, f.proposal);
  assert.equal(built.draft.npcs[0].initialFacts[0].relevanceMapId, mapId);
});
