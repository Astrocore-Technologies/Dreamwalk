const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  openingArtMissing,
  withOpeningScene,
  OPENING_LOCATION_ID,
} = require('../../apps/api/dist/game/story-opening');
const { contentSchema } = require('../../packages/contracts/dist');

const written = () =>
  contentSchema.parse({ world: 'Старый порт.', firstMessage: 'Вы на причале.', npcIds: [] });

test('a story without author locations gets one opening location and counts as missing its picture', () => {
  const content = withOpeningScene(written(), 'ru');
  assert.deepEqual(
    content.locations.map((l) => l.id),
    [OPENING_LOCATION_ID],
  );
  assert.equal(content.startSceneId, 'scene-opening');
  assert.equal(openingArtMissing({ content }), true);
});

test('a picture, an omitted picture or author locations end the requirement', () => {
  const content = withOpeningScene(written(), 'en');
  assert.equal(openingArtMissing({ content, mapImages: [{ location_id: 'opening' }] }), false);
  assert.equal(
    openingArtMissing({ content, omittedMapImages: [{ location_id: 'opening' }] }),
    false,
  );
  const authored = contentSchema.parse({
    world: 'w',
    locations: [{ id: 'hall', name: 'Hall', description: '' }],
    npcIds: [],
  });
  assert.equal(openingArtMissing({ content: authored }), false);
  assert.equal(openingArtMissing({}), false);
});

test('opening names exist for every interface language', () => {
  for (const [language, expected] of [
    ['ru', 'Начало истории'],
    ['uk', 'Початок історії'],
    ['en', 'Story opening'],
  ])
    assert.equal(withOpeningScene(written(), language).locations[0].name, expected);
});
