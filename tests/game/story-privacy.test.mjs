import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportStoryTurnData,
  purgeStoryTurnData,
} from '../../scripts/story-turn-data-requests.mjs';

test('story export is requester scoped and excludes contexts, proposals and erased rows', async () => {
  const rows = [{ id: 'own', input: { text: 'my words' } }];
  const result = await exportStoryTurnData(
    {
      async query(sql, args) {
        assert.match(sql, /requester_user_id=\$1 AND erased_at IS NULL/);
        assert.doesNotMatch(sql.split('FROM')[0], /context|proposal|quote_result/);
        assert.deepEqual(args, ['requester']);
        return { rows };
      },
    },
    'requester',
  );
  assert.deepEqual(result, rows);
});

test('confirmed erasure keeps operation tombstones and financial liability while clearing derivative prose', async () => {
  const queries = [];
  const changed = await purgeStoryTurnData(
    {
      async query(sql, args) {
        queries.push({ sql, args });
        return { rowCount: 2, rows: [{ id: 'retained-tombstone' }] };
      },
    },
    'campaign',
    'requester',
  );
  assert.equal(changed, true);
  assert.equal(queries.length, 2);
  const { sql, args } = queries[0];
  for (const fragment of [
    "input='{}'",
    "segments='[]'",
    "context='{}'",
    'proposal=NULL',
    'result=NULL',
    "result_code='DATA_ERASED'",
    'erased_at=COALESCE',
  ])
    assert.ok(sql.includes(fragment));
  assert.doesNotMatch(
    sql,
    /DELETE|operation_id\s*=|requester_user_id\s*=\s*NULL|npc_ai_jobs|budget|wallet/,
  );
  assert.deepEqual(args.slice(0, 2), ['campaign', 'requester']);
  assert.match(args[2], /^erased-[\da-f-]{36}$/);
  assert.equal(queries[1].sql, 'DELETE FROM game_story_feed WHERE campaign_id=$1');
});
