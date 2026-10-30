const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  settingsSchema,
  adventureSchema,
  heroSchema,
  npcSchema,
  runtimeSchema,
  registerSchema,
  parsePatch,
} = require('../dist');
test('locale is an explicit persisted platform preference', () => {
  for (const language of ['uk', 'en', 'ru'])
    assert.equal(settingsSchema.parse({ language }).language, language);
  assert.equal(settingsSchema.safeParse({ language: 'xx' }).success, false);
});
test('PATCH does not reset unrelated defaulted fields', () => {
  assert.deepEqual(parsePatch(settingsSchema.partial(), { theme: 'light' }), { theme: 'light' });
  assert.deepEqual(parsePatch(adventureSchema.partial(), { title: 'Changed title' }), {
    title: 'Changed title',
  });
  assert.deepEqual(parsePatch(npcSchema.partial(), { name: 'Renamed' }), { name: 'Renamed' });
});
test('heroes and NPCs remain separate strict schemas', () => {
  assert.equal(heroSchema.safeParse({ name: 'Hero', secrets: 'private' }).success, false);
  assert.equal(npcSchema.parse({ name: 'NPC' }).age, 25);
  assert.equal(npcSchema.safeParse({ name: 'NPC', age: 12 }).success, false);
});
test('runtime rejects arbitrary endpoint URLs and injected credentials', () => {
  assert.equal(
    runtimeSchema.safeParse({
      name: 'Runtime',
      provider: 'mock',
      model: 'mock',
      endpointId: 'http://169.254.169.254',
    }).success,
    false,
  );
  assert.equal(
    runtimeSchema.safeParse({
      name: 'Runtime',
      provider: 'mock',
      model: 'mock',
      endpointId: 'mock',
      apiKey: 'secret',
    }).success,
    false,
  );
});
test('registration never accepts roles or weak passwords', () => {
  const body = {
    email: 'test@example.com',
    name: 'Tester',
    handle: 'tester',
    password: 'long-test-password',
  };
  assert.equal(registerSchema.safeParse({ ...body, role: 'admin' }).success, false);
  assert.equal(registerSchema.safeParse({ ...body, password: 'short' }).success, false);
  assert.equal(
    registerSchema.parse({ ...body, email: 'Test@Example.Com' }).email,
    'test@example.com',
  );
});

test('timezone accepts supported zones and rejects invalid or empty values', () => {
  for (const timezone of ['UTC', 'Europe/Kyiv', 'Europe/Paris', 'America/New_York']) {
    assert.equal(settingsSchema.parse({ timezone }).timezone, timezone);
  }
  for (const timezone of ['', 'not-a-timezone', 'Mars/Olympus', '../etc/passwd']) {
    assert.equal(settingsSchema.safeParse({ timezone }).success, false);
  }
  assert.equal(settingsSchema.parse({}).timezone, 'UTC');
});

test('metadata translation uses per-field fallback and never selects stale text', () => {
  const { selectAdventureText, safeAdventureMetadata } = require('../dist');
  const original = {
    title: 'Оригінал',
    synopsis: 'Початковий опис',
    sourceLanguage: 'uk',
    sourceRevision: 2,
    translations: {
      en: { title: 'English title', sourceRevision: 2 },
      ru: { title: 'Старый перевод', synopsis: 'Старый текст', sourceRevision: 1 },
    },
  };
  assert.deepEqual(selectAdventureText(original, 'en'), {
    title: 'English title',
    synopsis: 'Початковий опис',
    sourceLanguage: 'uk',
    translationStatus: 'ready',
    isFallback: true,
  });
  assert.equal(selectAdventureText(original, 'ru').title, 'Оригінал');
  assert.equal(selectAdventureText(original, 'ru').translationStatus, 'stale');
  assert.equal(selectAdventureText(original, 'uk').translationStatus, 'disabled');
  assert.equal(selectAdventureText(original, 'uk').isFallback, false);
  assert.deepEqual(safeAdventureMetadata(original).translations.ru, { sourceRevision: 1 });
  assert.equal(
    selectAdventureText({ title: 'Original', synopsis: 'Original summary' }, 'en').title,
    'Original',
  );
});
test('controlled tags resolve stable IDs and legacy aliases; custom translations are revision bound', () => {
  const {
    selectAdventureTags,
    controlledTagSchema,
    metadataTranslationSchema,
  } = require('../dist');
  const definitions = [
    { id: 'magic', labels: { en: 'Magic', uk: 'Магія', ru: 'Магия' }, aliases: ['Магия'] },
  ];
  const story = {
    tags: ['magic', 'Магия', 'Мой тег'],
    sourceRevision: 2,
    translations: { en: { sourceRevision: 2, tags: { 'Мой тег': 'My tag' } } },
  };
  assert.deepEqual(selectAdventureTags(story, 'en', definitions), ['Magic', 'Magic', 'My tag']);
  assert.deepEqual(selectAdventureTags({ ...story, sourceRevision: 3 }, 'en', definitions), [
    'Magic',
    'Magic',
    'Мой тег',
  ]);
  assert.deepEqual(selectAdventureTags(story, 'uk', definitions), ['Магія', 'Магія', 'Мой тег']);
  assert.equal(
    controlledTagSchema.safeParse({ ...definitions[0], labels: { en: 'Magic' } }).success,
    false,
  );
  assert.equal(
    metadataTranslationSchema.safeParse({
      sourceRevision: 1,
      tags: Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['x' + i, 'x'])),
    }).success,
    false,
  );
});
test('NPC public fields use per-field fallback and stale variants never appear ready', () => {
  const { selectNpcText, safeNpcMetadata, npcTranslationSchema } = require('../dist');
  const npc = {
    name: 'Оригінал',
    description: 'Опис',
    sourceLanguage: 'uk',
    sourceRevision: 2,
    translations: { en: { name: 'Old', description: 'Old description', sourceRevision: 1 } },
  };
  assert.equal(selectNpcText(npc, 'en').name, 'Оригінал');
  assert.equal(selectNpcText(npc, 'en').isFallback, true);
  assert.equal(selectNpcText(npc, 'en').translationStatus, 'stale');
  assert.deepEqual(safeNpcMetadata(npc).translations.en, { sourceRevision: 1 });
  assert.equal(npcTranslationSchema.safeParse({ secrets: 'No', sourceRevision: 2 }).success, false);
  npc.translations.en = { name: 'Current', sourceRevision: 2 };
  assert.equal(selectNpcText(npc, 'en').name, 'Current');
  assert.equal(selectNpcText(npc, 'en').description, 'Опис');
});
