const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { CachedTranslations, translationKey } = require('../../apps/api/dist/translation/service');
const { translationProjection } = require('../../apps/api/dist/translation/projection');
const {
  validateTranslations,
  translationDefinition,
} = require('../../apps/api/dist/translation/definition');
const user = randomUUID(),
  adventureId = randomUUID(),
  campaignId = randomUUID();
const story = () => ({
  id: adventureId,
  title: 'Лес',
  synopsis: 'Тихий лес',
  status: 'published',
  sourceLanguage: 'ru',
  sourceRevision: 1,
  translations: {},
  content: { world: 'SECRET WORLD', secrets: 'SECRET NOTES' },
  privateProfile: 'SECRET PROFILE',
});
function memoryCache() {
  const rows = new Map();
  let claims = 0;
  return {
    rows,
    get claims() {
      return claims;
    },
    async read(keys) {
      return keys.flatMap((key) => (rows.has(key) ? [rows.get(key)] : []));
    },
    async claim(_scope, _locale, items) {
      const added = [];
      for (const { id } of items)
        if (!rows.has(id)) {
          claims++;
          rows.set(id, { key: id, status: 'pending', translated_text: null });
          added.push(id);
        }
      return added;
    },
    async complete(values) {
      for (const [key, text] of values)
        rows.set(key, { key, status: 'ready', translated_text: text });
    },
    async fail(keys) {
      for (const key of keys) rows.set(key, { key, status: 'failed', translated_text: null });
    },
  };
}
function fixtureProvider(calls = []) {
  return {
    external: false,
    async translate(request) {
      calls.push(request);
      return {
        translations: request.items.map((item) => ({
          id: item.id,
          text: `${request.targetLocale}:${item.text}`,
        })),
      };
    },
  };
}
test('selected locale translates visible metadata, never modifies source, and reuses durable cache after restart', async () => {
  const cache = memoryCache(),
    calls = [],
    source = story();
  const service = new CachedTranslations(cache, fixtureProvider(calls));
  const first = await service.localize('/adventures/forest', source, 'en', user);
  assert.equal(first.translations.en.title, 'en:Лес');
  assert.equal(first.translations.en.sourceRevision, 1);
  assert.equal(source.translations.en, undefined);
  assert.equal(first.title, source.title);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes('SECRET'));
  const restarted = new CachedTranslations(cache);
  assert.deepEqual(await restarted.localize('/adventures/forest', source, 'en', user), first);
  assert.equal(cache.claims, 2);
});
test('locale, content edits, source revision, resource and audience have independent cache identities', async () => {
  const cache = memoryCache(),
    calls = [],
    service = new CachedTranslations(cache, fixtureProvider(calls));
  for (const [value, locale, viewer] of [
    [story(), 'en', user],
    [story(), 'uk', user],
    [story(), 'en', randomUUID()],
    [{ ...story(), sourceRevision: 2 }, 'en', user],
    [{ ...story(), title: 'Роща' }, 'en', user],
    [{ ...story(), id: randomUUID() }, 'en', user],
    [story(), 'en', null],
  ])
    await service.localize('/adventures/forest', value, locale, viewer);
  assert.equal(calls.length, 7);
  assert.equal(
    new Set(calls.flatMap((call) => call.items.map((item) => item.id))).size,
    cache.rows.size,
  );
});
test('valid curated fields win, stale translations are replaced per field, source language and editor reads do not dispatch', async () => {
  const calls = [],
    service = new CachedTranslations(memoryCache(), fixtureProvider(calls));
  const existing = {
    ...story(),
    translations: { en: { sourceRevision: 1, title: 'Curated Forest' } },
  };
  const value = await service.localize('/adventures/forest', existing, 'en', user);
  assert.equal(value.translations.en.title, 'Curated Forest');
  assert.equal(value.translations.en.synopsis, 'en:Тихий лес');
  assert.equal(calls[0].items.length, 1);
  for (const path of [
    '/studio/adventures/' + adventureId,
    '/npcs/' + adventureId,
    '/account/profile',
    '/game/campaigns/' + campaignId + '/turns/quote',
  ])
    assert.deepEqual(await service.localize(path, story(), 'uk', user), story());
  await service.localize('/adventures/forest', story(), 'ru', user);
  assert.equal(calls.length, 1);
  const stale = await service.localize(
    '/adventures/forest',
    { ...story(), sourceRevision: 2, translations: { en: { sourceRevision: 1, title: 'Old' } } },
    'en',
    user,
  );
  assert.equal(stale.translations.en.title, 'en:Лес');
  assert.equal(stale.translations.en.sourceRevision, 2);
});
test('game field allowlist excludes canonical mechanics, IDs, receipts, identities and unseen/private text', async () => {
  const calls = [],
    service = new CachedTranslations(memoryCache(), fixtureProvider(calls));
  const value = {
    type: 'snapshot',
    projectionRevision: 9,
    streamId: 'unchanged',
    campaign: { title: 'Лес' },
    projection: {
      revision: 9,
      map: {
        id: 'forest',
        label: 'Лес',
        description: 'Тихий лес',
        exits: [{ id: 'door', label: 'Дверь' }],
        privateLore: 'SECRET',
      },
      entities: [
        { id: 'p', kind: 'player', label: 'Yuri' },
        {
          id: 'npc',
          kind: 'npc',
          label: 'Страж',
          secrets: 'SECRET',
          x: 3,
          publicProfile: { role: 'Страж' },
        },
      ],
      npcUtterances: [{ id: 'speech', text: 'Привет' }],
      npcFactTopics: [{ npcId: 'npc', id: 'fact', title: 'Лес' }],
      objectives: [{ status: 'active', title: 'Цель', description: 'Иди' }],
      privateMemory: 'SECRET',
    },
  };
  const localized = await service.localize(
    `/game/campaigns/${campaignId}/snapshot`,
    value,
    'en',
    user,
  );
  assert.equal(localized.projection.map.labelTranslations.en, 'en:Лес');
  assert.equal(localized.projection.entities[0].label, 'Yuri');
  assert.equal(localized.projection.entities[1].x, 3);
  assert.equal(localized.projectionRevision, 9);
  assert.equal(localized.streamId, value.streamId);
  assert.equal(localized.projection.npcUtterances[0].text, 'en:Привет');
  assert.ok(!JSON.stringify(calls).includes('SECRET'));
  assert.ok(!JSON.stringify(calls).includes('Yuri'));
  const feed = {
    entries: [{ id: '1', kind: 'narration', text: 'Лес' }],
    turns: [{ inputText: 'ORIGINAL INPUT', proposalHash: 'immutable' }],
  };
  const translatedFeed = await service.localize(
    `/game/campaigns/${campaignId}/turns/feed`,
    feed,
    'uk',
    user,
  );
  assert.equal(translatedFeed.entries[0].text, 'uk:Лес');
  assert.deepEqual(translatedFeed.turns, feed.turns);
  assert.deepEqual(
    await service.localize(`/game/campaigns/${campaignId}/snapshot`, value, 'uk', null),
    value,
  );
});
test('concurrent reads claim once and repeated failures, timeouts and crashes never auto-retry', async () => {
  const cache = memoryCache(),
    calls = [],
    service = new CachedTranslations(cache, fixtureProvider(calls));
  await Promise.all(
    Array.from({ length: 12 }, () => service.localize('/adventures/forest', story(), 'en', user)),
  );
  assert.equal(calls.length, 1);
  assert.equal(cache.claims, 2);
  for (const kind of ['invalid', 'failure', 'timeout']) {
    const store = memoryCache();
    let count = 0;
    const failed = new CachedTranslations(
      store,
      {
        external: false,
        async translate() {
          count++;
          if (kind === 'timeout') return new Promise(() => {});
          if (kind === 'failure') throw new Error('SECRET ERROR');
          return { translations: [] };
        },
      },
      5,
    );
    for (let attempt = 0; attempt < 2; attempt++)
      assert.deepEqual(await failed.localize('/adventures/forest', story(), 'en', user), story());
    assert.equal(count, 1);
    assert.ok([...store.rows.values()].every((row) => row.status === 'failed'));
  }
});
test('gameplay dispatcher remains disabled and metadata dispatch requires explicit release mode', async () => {
  const cache = memoryCache(),
    service = new CachedTranslations(cache);
  assert.deepEqual(await service.localize('/adventures/forest', story(), 'en', user), story());
  assert.equal(cache.claims, 0);
  assert.throws(() => new CachedTranslations(cache, { external: true }), /PAYMENT_POLICY_REQUIRED/);
  const main = readFileSync('apps/api/src/main.ts', 'utf8');
  assert.match(
    main,
    /new CachedTranslations\(new PostgresTranslationCache\(db\), undefined, 2000, metadata\)/,
  );
  assert.match(main, /policy.mode === 'release'[\s\S]*?new PlatformMetadataTranslations\(db\)/);
  assert.match(main, /NPC_AI_KILL_SWITCH/);
});
test('strict output binding rejects missing, duplicated, invented, oversized and control-character translations', () => {
  const id = 'a'.repeat(64),
    id2 = 'b'.repeat(64),
    requested = [{ id, maxLength: 10 }];
  assert.equal(
    validateTranslations({ translations: [{ id, text: 'Hello' }] }, requested).get(id),
    'Hello',
  );
  for (const translations of [
    [],
    [{ id, text: 'long'.repeat(10) }],
    [{ id: id2, text: 'X' }],
    [
      { id, text: 'X' },
      { id, text: 'Y' },
    ],
    [{ id, text: 'X\u0000' }],
  ])
    assert.throws(() => validateTranslations({ translations }, requested));
  assert.match(translationDefinition.instructions, /untrusted/);
});
test('catalog and library only translate explicitly selected read surfaces; all scopes include content revision', () => {
  const result = translationProjection(
    '/library',
    { favorites: [story()], drafts: [story()], shared: [story()] },
    'en',
    user,
  );
  assert.equal(result.fields.length, 4);
  assert.equal(new Set(result.fields.map((field) => translationKey(field, 'en'))).size, 2);
  assert.deepEqual(translationProjection('/studio/adventures', [story()], 'en', user).fields, []);
});

test('owner default detail, unpublished drafts and reviewer views never enter translation input', async () => {
  const calls = [],
    service = new CachedTranslations(memoryCache(), fixtureProvider(calls));
  for (const variant of [
    { status: 'draft' },
    { status: 'pending_review', access: 'reviewer' },
    { access: 'owner' },
    { editRevision: 9 },
  ]) {
    const value = { ...story(), ...variant };
    assert.deepEqual(await service.localize('/adventures/forest', value, 'en', user), value);
  }
  assert.equal(calls.length, 0);
});

const {
  metadataTranslationKey,
  isMetadataField,
} = require('../../apps/api/dist/translation/platform-metadata');
test('platform metadata keys share readers and unrelated revisions but fence source, field, locale and visibility', () => {
  const publicStory = { ...story(), visibility: 'public' };
  const fields = (value, viewer = user) =>
    translationProjection('/adventures/forest', value, 'en', viewer).fields.filter(isMetadataField);
  const keys = (value, viewer = user, locale = 'en') =>
    fields(value, viewer).map((field) => metadataTranslationKey(field, locale));
  assert.deepEqual(keys(publicStory), keys(publicStory, randomUUID()));
  assert.deepEqual(keys(publicStory), keys(publicStory, null));
  assert.deepEqual(keys(publicStory), keys({ ...publicStory, sourceRevision: 91 }));
  const changed = keys({ ...publicStory, title: 'Новый лес' });
  assert.notEqual(changed[0], keys(publicStory)[0]);
  assert.equal(changed[1], keys(publicStory)[1], 'unchanged description is not translated again');
  assert.notDeepEqual(keys(publicStory), keys({ ...publicStory, visibility: 'private' }));
  assert.notDeepEqual(keys(publicStory), keys(publicStory, user, 'uk'));
  assert.notDeepEqual(keys(publicStory), keys({ ...publicStory, id: randomUUID() }));
  assert.equal(fields({ ...publicStory, editRevision: 1 }).length, 0);
  assert.equal(fields({ ...publicStory, status: 'draft' }).length, 0);
  assert.equal(
    translationProjection(
      `/game/campaigns/${campaignId}/turns/feed`,
      { entries: [{ text: 'PRIVATE WORDS' }] },
      'en',
      user,
    ).fields.filter(isMetadataField).length,
    0,
  );
});
