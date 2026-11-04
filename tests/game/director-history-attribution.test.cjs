const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  directorHistoryEntry,
  extendContextHistory,
} = require('../../apps/api/dist/game/context-history');
const row = (change = {}) => ({
  id: 'row-1',
  sequence: 2,
  ordinal: 0,
  kind: 'npc_reply',
  authorId: 'hidden-npc',
  authorLabel: 'Secret Keeper',
  text: 'Wait by the door.',
  speakerKnownToIds: ['hidden-npc', 'alice'],
  ...change,
});
const anonymous = (entry) => {
  assert.equal(Object.hasOwn(entry, 'authorId'), false);
  assert.equal(Object.hasOwn(entry, 'authorLabel'), false);
  assert.equal(Object.hasOwn(entry, 'speakerKnownToIds'), false);
  assert.equal(entry.text, 'Wait by the door.');
};
test('heard speech keeps words but identity requires every director audience member at emission', () => {
  for (const kind of ['speech', 'npc_reply']) {
    anonymous(directorHistoryEntry(row({ kind }), ['alice', 'bob']));
    anonymous(directorHistoryEntry(row({ kind, speakerKnownToIds: ['hidden-npc'] }), ['alice']));
    const known = directorHistoryEntry(row({ kind }), ['alice']);
    assert.equal(known.authorId, 'hidden-npc');
    assert.equal(known.authorLabel, 'Secret Keeper');
    assert.equal(Object.hasOwn(known, 'speakerKnownToIds'), false);
  }
});
test('legacy absent, malformed and empty identity provenance fail closed', () => {
  for (const known of [undefined, null, [], '*', ['*'], ['alice', 1], { alice: true }])
    anonymous(directorHistoryEntry(row({ speakerKnownToIds: known }), ['alice']));
  anonymous(directorHistoryEntry(row(), []));
});
test('narrator, outcome and attempt attribution remain unchanged and internal metadata is stripped', () => {
  for (const kind of ['narration', 'outcome', 'attempt']) {
    const original = row({ kind });
    const projected = directorHistoryEntry(original, ['bob']);
    assert.equal(projected.authorId, original.authorId);
    assert.equal(projected.authorLabel, original.authorLabel);
    assert.equal(Object.hasOwn(projected, 'speakerKnownToIds'), false);
    assert.deepEqual(original.speakerKnownToIds, ['hidden-npc', 'alice']);
  }
});
test('director retrieval uses immutable stored provenance after later reveal, pruning and restart', async () => {
  const stored = [
    row({ speakerKnownToIds: ['hidden-npc'] }),
    row({
      id: 'known',
      authorId: 'known-npc',
      authorLabel: 'Known Keeper',
      speakerKnownToIds: ['alice', 'bob'],
    }),
  ];
  const calls = [];
  const db = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      return sql.includes('game_story_feed') ? structuredClone(stored) : [];
    },
  };
  const ai = {
    contextWindow: () => ({ effectiveContextTokens: 1000 }),
    packContext: (value) => value,
  };
  // The formerly unseen shouter is now adjacent and identified; archived utterances
  // were pruned. Neither is permission to retroactively reveal who spoke.
  const state = JSON.parse(
    JSON.stringify({
      entities: {
        alice: { kind: 'player', x: 1, y: 1 },
        'hidden-npc': { kind: 'npc', x: 1, y: 2, label: 'Secret Keeper' },
      },
      npcUtterances: [],
    }),
  );
  const result = await extendContextHistory(
    db,
    ai,
    'campaign',
    state,
    'alice',
    { mode: 'director', director: { sharedAudience: [{ id: 'bob' }] } },
    'story_turn',
  );
  anonymous(result.history.find((entry) => entry.id === 'row-1'));
  assert.equal(result.history.find((entry) => entry.id === 'known').authorId, 'known-npc');
  assert.equal(JSON.stringify(result.textContextCandidate).includes('Secret Keeper'), false);
  const feed = calls.find((call) => call.sql.includes('game_story_feed'));
  assert.match(feed.sql, /entry->'speakerKnownToIds'/);
  assert.deepEqual(feed.args[1], ['alice', 'bob']);
  assert.match(feed.sql, /audience_ids @> \$2::text\[\]/);
  assert.deepEqual(stored[0].speakerKnownToIds, ['hidden-npc']);
});
