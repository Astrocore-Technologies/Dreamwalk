import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaxonomy } from '../../apps/api/src/taxonomy.ts';
import { studioContentTranslationAdapters } from '../../apps/api/src/translation/studio-content-sources.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const reader = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
const adventureId = '44444444-4444-4444-8444-444444444444';
const npcId = '55555555-5555-4555-8555-555555555555';
const releaseId = '66666666-6666-4666-8666-666666666666';
const epoch = '77777777-7777-4777-8777-777777777777';
const nextEpoch = '88888888-8888-4888-8888-888888888888';
const source = { kind: 'adventure', id: adventureId };
const system = { kind: 'system' },
  viewer = (userId) => ({ kind: 'viewer', userId });
const [adventures, taxonomy] = studioContentTranslationAdapters;
const taxonomySource = { kind: 'taxonomy', id: 'taxonomy' };
const localeTags = {
  genres: ['Тайна'],
  tags: [
    {
      id: 'mystery',
      aliases: ['mystery-alias'],
      labels: { ru: 'Тайна', en: 'Mystery', uk: 'Таємниця' },
    },
  ],
};
function content() {
  return {
    title: 'Опубликовано',
    synopsis: 'Начало',
    sourceLanguage: 'ru',
    sourceRevision: 1,
    tags: ['mystery', 'mystery-alias', 'Свет/Тень'],
    duration: 'Один вечер',
    translations: {
      en: { sourceRevision: 1, title: 'Prepared title', tags: { 'Свет/Тень': 'Light/Shadow' } },
    },
    content: {
      world: 'HIDDEN WORLD',
      rules: 'HIDDEN RULES',
      locations: [{ id: 'future', description: 'HIDDEN LOCATION' }],
      lorebook: [
        { id: 'secret', title: 'HIDDEN LORE', text: 'HIDDEN LORE TEXT', disclosure: 'public' },
      ],
    },
    publicNpcs: [
      {
        id: npcId,
        name: 'Смотритель',
        description: 'Старый смотритель',
        role: 'Хранитель',
        personality: 'Добрый',
        appearance: 'Синий плащ',
        greeting: 'Добрый вечер',
        biography: 'HIDDEN BIOGRAPHY',
        secrets: 'HIDDEN SECRET',
        characterProfile: { modelPrompt: 'HIDDEN PROFILE' },
        sourceLanguage: 'ru',
        sourceRevision: 1,
        translations: { uk: { sourceRevision: 1, name: 'Доглядач' } },
      },
    ],
  };
}
function fixture(overrides = {}) {
  const row = {
    id: adventureId,
    owner_id: owner,
    title: 'HIDDEN DRAFT',
    synopsis: 'HIDDEN DRAFT SYNOPSIS',
    data: { title: 'HIDDEN DRAFT', content: { lorebook: [{ text: 'HIDDEN DRAFT LORE' }] } },
    visibility: 'public',
    status: 'draft',
    published_snapshot: content(),
    private_release_id: null,
    private_snapshot: null,
    deleted_at: null,
    version: 2,
    edit_revision: 7,
    translation_epoch: epoch,
    ...overrides,
  };
  const state = {
    row,
    people: [owner, reader, stranger],
    userEpoch: epoch,
    inviteEpoch: epoch,
    invited: true,
    taxonomy: localeTags,
    queries: [],
  };
  const c = {
    async query(sql, parameters = []) {
      state.queries.push({ sql, parameters });
      let rows;
      if (sql.startsWith('SELECT owner_id FROM adventures'))
        rows = state.row ? [{ owner_id: state.row.owner_id }] : [];
      else if (sql.startsWith('SELECT id,translation_epoch FROM users'))
        rows = parameters[0]
          .filter((id) => state.people.includes(id))
          .map((id) => ({ id, translation_epoch: state.userEpoch }));
      else if (sql.includes('FROM adventures a')) rows = state.row ? [state.row] : [];
      else if (sql.includes('FROM adventure_invitations'))
        rows =
          state.invited && parameters[1] === reader
            ? [{ id: 'invite', translation_epoch: state.inviteEpoch }]
            : [];
      else if (sql.includes('FROM platform_settings'))
        rows = state.taxonomy ? [{ value: state.taxonomy }] : [];
      else throw new Error('Unexpected SQL: ' + sql);
      return { rows, rowCount: rows.length };
    },
  };
  return { state, c };
}
const map = (bundle) => new Map(bundle.fields.map((field) => [field.path, field]));
function applyAuthorized(projection, bundles, locale = 'en') {
  for (const field of projection.fields) {
    const bundle = bundles.find(
      (value) =>
        value.source.kind === field.source.kind &&
        value.source.id === field.source.id &&
        value.partition === field.partition,
    );
    const sourceField = bundle?.fields.find(
      (value) => value.path === field.path && value.text === field.text,
    );
    if (sourceField) field.apply(sourceField.curated?.[locale] ?? `${locale}:${field.text}`);
  }
  return projection.value;
}

test('only displayed released metadata: no NPC cast, duration, drafts, hidden lore or mutable joins', async () => {
  const { state, c } = fixture();
  const bundles = await adventures.load(c, source, system);
  assert.deepEqual(
    bundles.map((b) => b.partition),
    ['public-release'],
  );
  const fields = map(bundles[0]);
  assert.equal(fields.get('/title').text, 'Опубликовано');
  assert.equal(
    bundles[0].fields.some((field) => field.path.startsWith('/publicNpcs/')),
    false,
  );
  assert.equal(JSON.stringify(bundles).includes('Смотритель'), false);
  assert.equal(fields.has('/duration'), false);
  assert.equal(JSON.stringify(bundles).includes('HIDDEN'), false);
  assert.equal(
    state.queries.some((q) => /FROM npcs/.test(q.sql)),
    false,
  );
  assert.equal(fields.has('/tags/mystery'), false);
  assert.equal(fields.has('/tags/mystery-alias'), false);
  assert.equal(fields.get('/tags/Свет~1Тень').curated.en, 'Light/Shadow');
  assert.ok(
    state.queries.filter((q) => q.sql.includes('FOR SHARE')).every((q) => q.sql.includes('NOWAIT')),
  );
});

test('unreleased draft and absent source produce no jobs even for owner/system', async () => {
  const { state, c } = fixture({ published_snapshot: null });
  for (const access of [system, viewer(owner), viewer(reader), viewer(null)])
    assert.deepEqual(await adventures.load(c, source, access), []);
  state.row = null;
  assert.deepEqual(await adventures.load(c, source, system), []);
  assert.deepEqual(
    studioContentTranslationAdapters.map((a) => a.kind),
    ['adventure', 'taxonomy'],
  );
});

test('draft changes cannot affect retained approved fields; unchanged fields reuse identity', async () => {
  const { state, c } = fixture();
  const before = (await adventures.load(c, source, system))[0];
  state.row.title = 'NEW HIDDEN DRAFT';
  state.row.data = { content: { world: 'NEW HIDDEN WORLD' } };
  state.row.edit_revision++;
  assert.deepEqual((await adventures.load(c, source, system))[0], before);
  state.row.published_snapshot.synopsis = 'Изменённое начало';
  const updated = (await adventures.load(c, source, system))[0];
  assert.deepEqual(map(updated).get('/title'), map(before).get('/title'));
  assert.notDeepEqual(map(updated).get('/synopsis'), map(before).get('/synopsis'));
});

test('public release is the only source for anonymous, owner and unrelated live viewers', async () => {
  const { c } = fixture();
  for (const user of [null, owner, reader, stranger])
    assert.deepEqual(
      (await adventures.load(c, source, viewer(user))).map((b) => b.partition),
      ['public-release'],
    );
});

test('private release requires owner/system or accepted invitation; revoke/rejoin fences authority', async () => {
  const { state, c } = fixture({
    visibility: 'private',
    private_release_id: releaseId,
    private_snapshot: content(),
  });
  for (const user of [null, stranger])
    assert.deepEqual(await adventures.load(c, source, viewer(user)), []);
  const first = (await adventures.load(c, source, viewer(reader)))[0];
  assert.equal(first.partition, 'private-release');
  assert.deepEqual(first.erasureUserIds, [owner]);
  assert.equal(JSON.stringify(first).includes('HIDDEN'), false);
  state.invited = false;
  assert.deepEqual(await adventures.load(c, source, viewer(reader)), []);
  state.invited = true;
  state.inviteEpoch = nextEpoch;
  const rejoined = (await adventures.load(c, source, viewer(reader)))[0];
  assert.notEqual(rejoined.authority, first.authority);
  assert.deepEqual(rejoined.fields, first.fields);
  assert.equal((await adventures.load(c, source, system)).length, 1);
});

test('archive/erasure fail closed; access epochs change authority but not field identity', async () => {
  for (const changes of [
    { deleted_at: '2026-11-06' },
    { status: 'archived' },
    { translation_epoch: undefined },
  ]) {
    const { c } = fixture(changes);
    assert.deepEqual(await adventures.load(c, source, system), []);
  }
  const { state, c } = fixture();
  const original = (await adventures.load(c, source, system))[0];
  state.row.translation_epoch = nextEpoch;
  const changed = (await adventures.load(c, source, system))[0];
  assert.notEqual(changed.authority, original.authority);
  assert.deepEqual(changed.fields, original.fields);
  state.people = [reader];
  assert.deepEqual(await adventures.load(c, source, system), []);
  state.people = [owner];
  assert.deepEqual(await adventures.load(c, source, viewer(reader)), []);
});

test('Studio/NPC/drafts/review/history/game-message projections are excluded', () => {
  const data = {
    ...content(),
    id: adventureId,
    ownerId: owner,
    status: 'published',
    visibility: 'public',
  };
  for (const path of [
    '/studio/adventures',
    `/studio/adventures/${adventureId}`,
    `/studio/adventures/${adventureId}/versions`,
    '/npcs',
    `/npcs/${npcId}`,
    `/studio/adventures/${adventureId}/npcs`,
    '/admin/adventures',
    `/game/campaigns/${adventureId}/turns/feed`,
    `/game/campaigns/${adventureId}/narrative`,
  ])
    assert.deepEqual(adventures.project(path, data, 'en', owner).fields, []);
  for (const override of [
    { editRevision: 1 },
    { access: 'owner' },
    { access: 'reviewer' },
    { status: 'draft' },
  ])
    assert.deepEqual(
      adventures.project('/adventures/example', { ...data, ...override }, 'en', owner).fields,
      [],
    );
  assert.deepEqual(adventures.project('/library', { drafts: [data] }, 'en', owner).fields, []);
});

test('reader overlay preserves source and curated values and never adds withheld cast/content', async () => {
  const { c } = fixture();
  const original = {
    ...content(),
    id: adventureId,
    status: 'published',
    visibility: 'public',
    content: { world: '', rules: '', locations: [], scenes: [] },
    npcs: [],
  };
  delete original.publicNpcs;
  const snapshot = structuredClone(original);
  const result = applyAuthorized(
    adventures.project('/adventures/example', original, 'en', null),
    await adventures.load(c, source, viewer(null)),
  );
  assert.deepEqual(original, snapshot);
  assert.equal(result.title, original.title);
  assert.equal(result.translations.en.title, 'Prepared title');
  assert.equal(result.duration, original.duration);
  assert.deepEqual(result.content, original.content);
  assert.deepEqual(result.npcs, []);
  assert.equal('publicNpcs' in result, false);
  assert.equal('localizedContent' in result, false);
});

test('catalog/creator/read-only library use released partitions', () => {
  const publicDto = { ...content(), id: adventureId, status: 'published', visibility: 'public' };
  const privateDto = { ...publicDto, visibility: 'private' };
  for (const [path, data] of [
    ['/adventures', [publicDto]],
    ['/creators/example', { adventures: [publicDto] }],
    ['/library', { favorites: [publicDto] }],
  ])
    assert.ok(adventures.project(path, data, 'uk', reader).fields.length);
  const result = adventures.project(
    '/library',
    { shared: [privateDto], privatePublished: [privateDto], drafts: [publicDto] },
    'uk',
    reader,
  );
  assert.deepEqual(new Set(result.fields.map((f) => f.partition)), new Set(['private-release']));
});

test('stale curated variants and oversized fields are not admitted', async () => {
  const { state, c } = fixture();
  state.row.published_snapshot.sourceRevision = 2;
  state.row.published_snapshot.synopsis = 'x'.repeat(4001);
  const fields = map((await adventures.load(c, source, system))[0]);
  assert.deepEqual(fields.get('/title').curated, {});
  assert.equal(fields.has('/synopsis'), false);
});

test('taxonomy preserves complete labels; only legacy unprepared display labels need translation', async () => {
  const { state, c } = fixture();
  state.taxonomy = { ...localeTags, genres: ['Тайна', 'Необычный жанр'] };
  const bundle = (await taxonomy.load(c, taxonomySource, system))[0];
  assert.equal(map(bundle).get('/tags/mystery/label').curated.en, 'Mystery');
  assert.deepEqual(bundle.fields.find((f) => f.text === 'Необычный жанр').curated, {});
  assert.equal(
    bundle.fields.find((f) => f.path.includes('genreDefinitions/mystery')).curated.uk,
    'Таємниця',
  );
  assert.equal(
    bundle.fields.some((f) => f.text === 'mystery' || f.text === 'mystery-alias'),
    false,
  );
  const dto = normalizeTaxonomy(state.taxonomy),
    projection = taxonomy.project('/taxonomy', dto, 'en', null);
  const result = applyAuthorized(projection, [bundle]);
  assert.equal(
    result.genreDefinitions.find((d) => d.value === 'Необычный жанр').labels.en,
    'en:Необычный жанр',
  );
  assert.deepEqual(result.genres, dto.genres);
  assert.deepEqual(result.tags, dto.tags);
  assert.deepEqual(taxonomy.project('/admin/taxonomy', dto, 'en', owner).fields, []);
});

test('untrusted tag keys remain own fields, not prototype mutations', async () => {
  const { state, c } = fixture();
  state.row.published_snapshot.tags = ['__proto__'];
  state.row.published_snapshot.translations = {};
  const original = {
    ...state.row.published_snapshot,
    id: adventureId,
    status: 'published',
    visibility: 'public',
  };
  const result = applyAuthorized(
    adventures.project('/adventures/example', original, 'en', reader),
    await adventures.load(c, source, viewer(reader)),
  );
  assert.equal(Object.hasOwn(result.translations.en.tags, '__proto__'), true);
  assert.equal(result.translations.en.tags.__proto__, 'en:__proto__');
  assert.equal(Object.getPrototypeOf(result.translations.en.tags), Object.prototype);
});

test('private release replacement preserves authority and unchanged fields while exact edited fields change', async () => {
  const { state, c } = fixture({
    visibility: 'private',
    private_release_id: releaseId,
    private_snapshot: content(),
  });
  for (const access of [system, viewer(owner), viewer(reader)]) {
    const before = (await adventures.load(c, source, access))[0];
    state.row.private_release_id =
      state.row.private_release_id === releaseId ? nextEpoch : releaseId;
    state.row.private_snapshot = {
      ...state.row.private_snapshot,
      title: state.row.private_snapshot.title + '!',
    };
    const after = (await adventures.load(c, source, access))[0];
    assert.equal(after.authority, before.authority);
    assert.deepEqual(map(after).get('/synopsis'), map(before).get('/synopsis'));
    assert.notDeepEqual(map(after).get('/title'), map(before).get('/title'));
  }
});
