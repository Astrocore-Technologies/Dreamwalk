const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = require('@dreamwalk/game-core');
const { digest } = require('../../apps/api/dist/ai/context');
const { contentTranslationUnits } = require('../../apps/api/dist/translation/content-fields');
const {
  PlayableContentSource,
  releasedPlayableFields,
  playableDescriptionProjection,
} = require('../../apps/api/dist/translation/playable-content-source');

const versionId = randomUUID(),
  campaignId = randomUUID(),
  ownerId = randomUUID(),
  viewerId = randomUUID();
const source = { kind: 'playable', id: versionId };
function fixture() {
  const compiled = core.compilePlayableDraft(core.createCompleteObservatoryDraft()).playable;
  const state = core.createStateFromPlayable(compiled, ['alice', 'bob']);
  const mapId = state.entities.alice.mapId;
  compiled.maps[mapId].label = state.maps[mapId].label = 'Тихий двор';
  compiled.maps[mapId].description = state.maps[mapId].description = 'Светлый двор.';
  compiled.entities.keeper.label = state.entities.keeper.label = 'Аля';
  compiled.entities.keeper.publicProfile = state.entities.keeper.publicProfile = {
    role: 'Хранитель',
    description: 'Помогает путникам.',
    appearance: 'Плащ.',
    personality: 'Спокойная.',
    greeting: 'DO NOT TRANSLATE GREETING',
  };
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 6, y: 5 });
  state.maps[mapId].blocked = [];
  state.npcUtterances = [
    {
      id: 'speech',
      mapId,
      text: 'DO NOT TRANSLATE WHISPER',
      audienceIds: ['alice'],
      speakerId: 'keeper',
      speakerKnownToIds: ['alice'],
      tick: 0,
    },
  ];
  return {
    state,
    pkg: {
      schemaVersion: 1,
      compiled,
      source: { title: compiled.title, content: { secrets: 'SECRET LORE' } },
      npcDefinitions: [{ id: 'keeper', data: { biography: 'SECRET BIOGRAPHY' } }],
    },
  };
}
function fakeDb({ state, pkg }, options = {}) {
  const calls = [];
  const row = {
    package: pkg,
    checksum: digest(pkg),
    audience: 'review',
    adventure_id: options.adventureId ?? randomUUID(),
    owner_id: options.ownerId ?? ownerId,
    source_epoch: 'source-life',
    owner_epoch: 'owner-life',
  };
  return {
    calls,
    row,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.startsWith('SELECT a.owner_id'))
        return { rows: [{ owner_id: options.ownerId ?? ownerId }] };
      if (sql.startsWith('SELECT owner_id FROM game_campaigns'))
        return { rows: [{ owner_id: viewerId }] };
      if (sql.includes('SELECT v.package')) return { rows: options.unreleased ? [] : [row] };
      if (sql.includes('SELECT c.state'))
        return {
          rows: options.revoked
            ? []
            : [
                {
                  state,
                  snapshot_state: state,
                  checksum: digest(state),
                  actor_id: 'alice',
                  owner_id: viewerId,
                  campaign_epoch: 'campaign-life',
                  member_epoch: options.memberEpoch ?? 'member-life',
                  viewer_epoch: 'viewer-life',
                  campaign_owner_epoch: 'viewer-life',
                  invitation_epoch: options.invitationEpoch ?? null,
                },
              ],
        };
      return { rows: [] };
    },
  };
}
test('released compiled fields preserve runtime IDs and never traverse brains, utterances, greeting or lore secrets', () => {
  const { pkg } = fixture();
  const fields = releasedPlayableFields(pkg);
  assert.ok(fields.some((field) => field.path === 'entity/keeper/label' && field.text === 'Аля'));
  assert.ok(fields.some((field) => field.path === 'entity/keeper/profile/personality'));
  assert.ok(!JSON.stringify(fields).includes('SECRET'));
  assert.ok(!JSON.stringify(fields).includes('DO NOT TRANSLATE'));
  assert.deepEqual(releasedPlayableFields({ erased: true }), []);
});
test('launch-source names are bound by exact source IDs even when two names match', () => {
  const ids = [randomUUID(), randomUUID()];
  const pkg = {
    schemaVersion: 2,
    kind: 'launch-source',
    compiled: null,
    plannerSource: {
      title: 'Дом',
      content: {
        npcIds: ids,
        locations: [{ id: 'room-one', name: 'Зал', description: 'Тихий зал' }],
      },
      npcs: ids.map((id) => ({
        id,
        name: 'Страж',
        role: 'Страж',
        description: 'У двери.',
        appearance: 'Плащ.',
        greeting: 'DO NOT TRANSLATE',
      })),
    },
  };
  const fields = releasedPlayableFields(pkg);
  assert.equal(
    fields.filter((field) => field.text === 'Страж' && field.path.endsWith('/label')).length,
    2,
  );
  assert.ok(fields.some((field) => field.path === `entity/${ids[0]}/label`));
  assert.ok(fields.some((field) => field.path === 'map/room-one/label'));
  pkg.plannerSource.npcs[1].id = randomUUID();
  assert.deepEqual(releasedPlayableFields(pkg), []);
});
test('playable overlay keeps canonical names/IDs and all game text unchanged', () => {
  const { state, pkg } = fixture();
  const snapshot = {
    campaign: { playableVersionId: versionId, title: pkg.compiled.title },
    projection: core.projectState(state, 'alice'),
  };
  const before = structuredClone(snapshot);
  const projected = playableDescriptionProjection(
    `/game/campaigns/${campaignId}/snapshot`,
    snapshot,
    'en',
    viewerId,
  );
  for (const field of projected.fields) field.apply('Translated ' + field.text);
  assert.equal(
    projected.value.projection.entities.find((entity) => entity.id === 'keeper').label,
    'Аля',
  );
  assert.equal(
    projected.value.projection.entities.find((entity) => entity.id === 'keeper').labelTranslations
      .en,
    'Translated Аля',
  );
  assert.deepEqual(projected.value.projection.npcUtterances, snapshot.projection.npcUtterances);
  assert.deepEqual(snapshot, before);
  for (const suffix of ['turns/feed', 'narrative', 'chat'])
    assert.deepEqual(
      playableDescriptionProjection(
        `/game/campaigns/${campaignId}/${suffix}`,
        snapshot,
        'en',
        viewerId,
      ).fields,
      [],
    );
  assert.deepEqual(
    playableDescriptionProjection(`/game/campaigns/${campaignId}/snapshot`, snapshot, 'en', null)
      .fields,
    [],
  );
});
test('system translation requires actual release proof, immutable checksum and lifetime epochs', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture();
  for (const options of [{ unreleased: true }, {}]) {
    const db = fakeDb(data, options);
    const bundles = await adapter.load(db, source, { kind: 'system' });
    assert.equal(bundles.length, options.unreleased ? 0 : 1);
    const sql = db.calls.find((call) => call.sql.includes('SELECT v.package')).sql;
    assert.match(sql, /game_playable_approvals/);
    assert.match(sql, /adventure_private_releases/);
    assert.match(sql, /FOR SHARE OF v,a NOWAIT/);
  }
  const corrupt = fakeDb(data);
  corrupt.row.checksum = 'wrong';
  assert.deepEqual(await adapter.load(corrupt, source, { kind: 'system' }), []);
  const missingEpoch = fakeDb(data);
  delete missingEpoch.row.source_epoch;
  assert.deepEqual(await adapter.load(missingEpoch, source, { kind: 'system' }), []);
});
test('viewer reads require active campaign membership and current visible exact source text', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture();
  const access = { kind: 'viewer', userId: viewerId, campaignId };
  assert.deepEqual(
    await adapter.load(fakeDb(data), source, { kind: 'viewer', userId: viewerId }),
    [],
  );
  assert.deepEqual(await adapter.load(fakeDb(data, { revoked: true }), source, access), []);
  const db = fakeDb(data),
    loaded = await adapter.load(db, source, access);
  assert.ok(loaded[0].fields.some((field) => field.path === 'entity/keeper/label'));
  assert.ok(!loaded[0].fields.some((field) => field.text.includes('DO NOT TRANSLATE')));
  assert.match(
    db.calls.find((call) => call.sql.includes('SELECT c.state')).sql,
    /m.status='accepted'/,
  );
  assert.match(
    db.calls.find((call) => call.sql.includes('SELECT c.state')).sql,
    /FOR SHARE OF c,s,m NOWAIT/,
  );
  data.state.entities.keeper.label = 'Changed runtime name';
  data.state.entities.runtimeOnly = {
    ...data.state.entities.keeper,
    id: 'runtimeOnly',
    label: 'Generated later',
  };
  const changed = await adapter.load(fakeDb(data), source, access);
  assert.ok(
    !changed[0].fields.some(
      (field) => field.path === 'entity/keeper/label' || field.text === 'Generated later',
    ),
  );
});
test('movement/content revisions do not change lifetime authority; revoke/rejoin epochs do', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture(),
    access = { kind: 'viewer', userId: viewerId, campaignId };
  const before = (await adapter.load(fakeDb(data), source, access))[0];
  data.state.revision += 3;
  data.state.entities.alice.x += 1;
  const after = (await adapter.load(fakeDb(data), source, access))[0];
  assert.equal(before.authority, after.authority);
  const rejoined = (
    await adapter.load(fakeDb(data, { memberEpoch: 'new-life' }), source, access)
  )[0];
  assert.notEqual(after.authority, rejoined.authority);
  assert.equal(after.fields[0].cachePartition, rejoined.fields[0].cachePartition);
});
test('a hidden NPC never exposes even a ready immutable label or profile', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture();
  data.state.entities.keeper.mapId = 'a-different-map';
  const system = await adapter.load(fakeDb(data), source, { kind: 'system' });
  assert.ok(system[0].fields.some((field) => field.path === 'entity/keeper/label'));
  const viewer = await adapter.load(fakeDb(data), source, {
    kind: 'viewer',
    userId: viewerId,
    campaignId,
  });
  assert.ok(!viewer[0].fields.some((field) => field.path.startsWith('entity/keeper/')));
});
test('curated labels remain authoritative while invalid curated values and runtime brains are excluded', () => {
  const { pkg } = fixture();
  pkg.compiled.entities.keeper.labelTranslations = {
    ru: 'Аля',
    uk: 'Аля',
    en: 'Alya',
    x: 'invalid',
  };
  pkg.compiled.npcBrains = { keeper: { privateThought: 'NEVER SEND THIS' } };
  const fields = releasedPlayableFields(pkg);
  assert.deepEqual(fields.find((field) => field.path === 'entity/keeper/label').curated, {
    ru: 'Аля',
    uk: 'Аля',
    en: 'Alya',
  });
  assert.ok(!JSON.stringify(fields).includes('NEVER SEND'));
});
test('only exact frozen origin grants source locale, and destination exits reuse map artifacts', () => {
  const { pkg, state } = fixture();
  const map = pkg.compiled.maps[state.entities.alice.mapId];
  pkg.source.sourceLanguage = 'ru';
  pkg.source.content.locations = [{ id: map.id, name: map.label, description: map.description }];
  pkg.npcDefinitions = [
    {
      id: 'keeper',
      data: { name: 'Аля', sourceLanguage: 'uk', ...pkg.compiled.entities.keeper.publicProfile },
    },
  ];
  const fields = releasedPlayableFields(pkg);
  assert.equal(fields.find((field) => field.path === 'title').sourceLocale, 'ru');
  assert.equal(fields.find((field) => field.path === `map/${map.id}/label`).sourceLocale, 'ru');
  assert.equal(fields.find((field) => field.path === 'entity/keeper/label').sourceLocale, 'uk');
  assert.equal(
    fields.find((field) => field.path === 'entity/keeper/profile/description').sourceLocale,
    'uk',
  );
  pkg.npcDefinitions[0].data.name = 'Unrelated';
  assert.equal(
    releasedPlayableFields(pkg).find((field) => field.path === 'entity/keeper/label').sourceLocale,
    undefined,
  );
  const exit = map.exits[0];
  const destination = pkg.compiled.maps[exit.destinationMapId];
  exit.label = destination.label;
  assert.ok(
    !releasedPlayableFields(pkg).some(
      (field) => field.path === `map/${map.id}/exit/${exit.id}/label`,
    ),
  );
  const view = playableDescriptionProjection(
    `/game/campaigns/${campaignId}/snapshot`,
    { campaign: { playableVersionId: versionId }, projection: { map } },
    'en',
    viewerId,
  );
  const destinationField = view.fields.find(
    (field) => field.path === `map/${exit.destinationMapId}/label`,
  );
  assert.ok(destinationField);
  destinationField.apply('Destination');
  assert.equal(view.value.projection.map.exits[0].labelTranslations.en, 'Destination');
  assert.equal(map.exits[0].label, destination.label);
});
test('a distinct curated exit translation wins over an equal destination label in either read order', () => {
  const { pkg, state } = fixture();
  const map = pkg.compiled.maps[state.entities.alice.mapId],
    exit = map.exits[0];
  const destination = pkg.compiled.maps[exit.destinationMapId];
  destination.label = exit.label = 'Башня';
  destination.labelTranslations = { en: 'Tower' };
  exit.labelTranslations = { en: 'Tower entrance' };
  assert.equal(
    releasedPlayableFields(pkg).find(
      (field) => field.path === `map/${map.id}/exit/${exit.id}/label`,
    ).curated.en,
    'Tower entrance',
  );
  for (const reverse of [false, true]) {
    const view = playableDescriptionProjection(
      `/game/campaigns/${campaignId}/snapshot`,
      { campaign: { playableVersionId: versionId }, projection: { map } },
      'en',
      viewerId,
    );
    const specific = view.fields.find(
      (field) => field.path === `map/${map.id}/exit/${exit.id}/label`,
    );
    const fallback = view.fields.find(
      (field) => field.path === `map/${exit.destinationMapId}/label`,
    );
    for (const field of reverse ? [fallback, specific] : [specific, fallback])
      field.apply(field === specific ? 'Tower entrance' : 'Tower');
    assert.equal(view.value.projection.map.exits[0].labelTranslations.en, 'Tower entrance');
  }
});
test('frozen NPC curated metadata requires exact identity, source text and revision', () => {
  const { pkg } = fixture();
  pkg.npcDefinitions = [
    {
      id: 'keeper',
      data: {
        name: 'Аля',
        ...pkg.compiled.entities.keeper.publicProfile,
        sourceRevision: 4,
        sourceLanguage: 'ru',
        translations: {
          en: { sourceRevision: 4, name: 'Alya', description: 'Helps travellers.' },
          uk: { sourceRevision: 3, name: 'Stale name', description: 'Stale description' },
        },
      },
    },
  ];
  delete pkg.compiled.entities.keeper.labelTranslations;
  let fields = releasedPlayableFields(pkg);
  assert.deepEqual(fields.find((field) => field.path === 'entity/keeper/label').curated, {
    en: 'Alya',
  });
  assert.deepEqual(
    fields.find((field) => field.path === 'entity/keeper/profile/description').curated,
    { en: 'Helps travellers.' },
  );
  pkg.compiled.entities.keeper.labelTranslations = { en: 'Authored alias' };
  fields = releasedPlayableFields(pkg);
  assert.equal(
    fields.find((field) => field.path === 'entity/keeper/label').curated.en,
    'Authored alias',
  );
  pkg.npcDefinitions[0].data.description = 'Other source';
  fields = releasedPlayableFields(pkg);
  assert.equal(
    fields.find((field) => field.path === 'entity/keeper/profile/description').curated,
    undefined,
  );
});
test('unchanged authored fields reuse artifacts across releases but never across owner, story, role or visibility', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture(),
    adventureId = randomUUID();
  const load = async (sourceId, options = {}) => {
    const db = fakeDb(data, { adventureId, ...options });
    if (options.audience) db.row.audience = options.audience;
    return (await adapter.load(db, { kind: 'playable', id: sourceId }, { kind: 'system' }))[0];
  };
  const before = await load(versionId),
    after = await load(randomUUID());
  const field = (bundle) => bundle.fields.find((field) => field.path.endsWith('/description'));
  const key = (bundle) => contentTranslationUnits(bundle, field(bundle), 'en')[0].key;
  assert.equal(key(before), key(after));
  assert.notEqual(before.authority, after.authority, 'version admission remains exact');
  assert.notEqual(key(before), key(await load(randomUUID(), { ownerId: randomUUID() })));
  assert.notEqual(key(before), key(await load(randomUUID(), { adventureId: randomUUID() })));
  assert.notEqual(key(before), key(await load(randomUUID(), { audience: 'private' })));
  const title = before.fields.find((field) => field.path === 'title');
  assert.equal(
    title.artifactIdentity,
    digest(['released-story-field', adventureId, ownerId, 'title']),
  );
  const otherRole = {
    ...field(before),
    artifactIdentity: digest(['released-story-field', adventureId, ownerId, 'another-field']),
  };
  assert.notEqual(key(before), contentTranslationUnits(before, otherRole, 'en')[0].key);
  assert.notEqual(
    key(before),
    contentTranslationUnits(before, { ...field(before), text: 'Changed description' }, 'en')[0].key,
  );
});
test('current released human title variants bind exact frozen revision, language and text, never draft metadata', async () => {
  const adapter = new PlayableContentSource(),
    data = fixture();
  Object.assign(data.pkg.source, { sourceRevision: 4, sourceLanguage: 'ru' });
  const released = {
    title: data.pkg.source.title,
    sourceRevision: 4,
    sourceLanguage: 'ru',
    translations: {
      en: { sourceRevision: 4, title: 'Curated release title' },
      uk: { sourceRevision: 3, title: 'Stale title' },
    },
  };
  for (const audience of ['review', 'private']) {
    const db = fakeDb(data);
    Object.assign(db.row, {
      audience,
      [audience === 'review' ? 'published_snapshot' : 'private_snapshot']: released,
    });
    const bundle = (await adapter.load(db, source, { kind: 'system' }))[0],
      title = bundle.fields.find((field) => field.path === 'title');
    assert.equal(title.curated.en, 'Curated release title');
    assert.equal(title.curated.uk, undefined);
    assert.deepEqual(contentTranslationUnits(bundle, title, 'en'), []);
  }
  for (const mismatch of [
    { title: 'Another title' },
    { sourceRevision: 5 },
    { sourceLanguage: 'en' },
  ]) {
    const db = fakeDb(data);
    db.row.published_snapshot = { ...released, ...mismatch };
    const title = (await adapter.load(db, source, { kind: 'system' }))[0].fields.find(
      (field) => field.path === 'title',
    );
    assert.equal(title.curated, undefined);
  }
  const draftOnly = fakeDb(data);
  draftOnly.row.data = released;
  assert.equal(
    (await adapter.load(draftOnly, source, { kind: 'system' }))[0].fields.find(
      (field) => field.path === 'title',
    ).curated,
    undefined,
  );
});
