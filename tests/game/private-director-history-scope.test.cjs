const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extendContextHistory } = require('../../apps/api/dist/game/context-history');

function fixture() {
  const calls = [];
  return {
    state: {
      entities: {
        alice: { kind: 'player' },
        bob: { kind: 'player' },
        keeper: { kind: 'npc' },
        door: { kind: 'door' },
      },
    },
    calls,
    db: {
      query: async (sql, args) => {
        calls.push({ sql, args });
        return [];
      },
    },
    ai: {
      contextWindow: () => ({ effectiveContextTokens: 1000 }),
      packContext: (value) => value,
    },
  };
}
function context(outputAudienceIds) {
  return {
    mode: 'director',
    channel: 'whisper',
    outputAudienceIds,
    director: { sharedAudience: [{ id: 'bob' }] },
  };
}
function extend(f, value) {
  return extendContextHistory(f.db, f.ai, 'campaign', f.state, 'alice', value, 'story_turn');
}

test('private director history rejects empty, missing, malformed and foreign scope before any reads', async () => {
  for (const audience of [
    undefined,
    null,
    [],
    ['bob', 'keeper'],
    ['alice', ''],
    ['alice', ' '],
    ['alice', 'missing'],
    ['alice', 'door'],
    ['alice', 1],
    ['*'],
    'alice',
    { alice: true },
  ]) {
    const f = fixture();
    f.ai.withRuntimeMap = () => {
      assert.fail('invalid scope must not extend runtime context');
    };
    await assert.rejects(extend(f, context(audience)), /^Error: FORBIDDEN$/);
    assert.deepEqual(f.calls, []);
  }
});

test('invalid private scope cannot bypass validation with history packing disabled', async () => {
  const f = fixture();
  f.ai.contextWindow = () => null;
  await assert.rejects(extend(f, context([])), /^Error: FORBIDDEN$/);
  assert.deepEqual(f.calls, []);
});

test('private retrieval pins a nonempty complete audience and rejects extension-corrupted scope', async () => {
  const f = fixture();
  await extend(f, context(['alice', 'keeper', 'alice']));
  const feed = f.calls.find((call) => call.sql.includes('game_story_feed'));
  assert.deepEqual(feed.args[1], ['alice', 'keeper']);
  assert.equal(feed.args[3], true);
  assert.match(feed.sql, /audience_ids @> \$2::text\[\]/);
  const changed = fixture();
  changed.ai.withRuntimeMap = (_campaign, _state, _actor, value) => ({
    ...value,
    outputAudienceIds: [],
  });
  await assert.rejects(extend(changed, context(['alice', 'keeper'])), /^Error: FORBIDDEN$/);
  assert.equal(
    changed.calls.some((call) => call.sql.includes('game_story_feed')),
    false,
  );
});

test('public director history keeps the shared audience and never enables private rows', async () => {
  const f = fixture();
  await extend(f, { ...context([]), channel: 'say' });
  const feed = f.calls.find((call) => call.sql.includes('game_story_feed'));
  assert.deepEqual(feed.args[1], ['alice', 'bob']);
  assert.equal(feed.args[3], false);
});
