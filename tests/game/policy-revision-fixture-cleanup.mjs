import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Test-only final fixture teardown. Production append-only triggers remain enabled and unchanged. */
export async function cleanupPolicyRevisionFixture(db, authorizationIds) {
  if (
    !(await db.query("SELECT to_regclass('generation_policy_revisions') AS present")).rows[0]
      .present
  )
    return;
  if (
    !(
      await db.query(
        'SELECT 1 FROM generation_policy_revisions WHERE authorization_id=ANY($1::uuid[]) LIMIT 1',
        [authorizationIds],
      )
    ).rowCount
  )
    return;
  assert.equal(
    process.env.NODE_ENV,
    'test',
    'Only disposable test environments may truncate their journal',
  );
  const cluster = process.env.LOCAL_POSTGRES_CLUSTER ?? '';
  assert.match(
    cluster,
    /^(game-test-|visual-test-|images-test-)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const expected = realpathSync(resolve(root, '.local', cluster, 'postgres')).toLowerCase();
  const actual = realpathSync(
    (await db.query('SHOW data_directory')).rows[0].data_directory,
  ).toLowerCase();
  assert.equal(actual, expected, 'Journal teardown must target this exact disposable cluster');
  if (
    !(await db.query("SELECT to_regclass('generation_policy_revisions') AS present")).rows[0]
      .present
  )
    return;
  assert.equal(
    (
      await db.query(
        'SELECT 1 FROM generation_policy_revisions WHERE NOT(authorization_id=ANY($1::uuid[])) LIMIT 1',
        [authorizationIds],
      )
    ).rowCount,
    0,
    'Never truncate unrelated fixture financial history',
  );
  await db.query('TRUNCATE generation_policy_revisions');
}
