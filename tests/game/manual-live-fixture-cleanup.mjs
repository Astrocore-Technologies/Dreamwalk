import assert from 'node:assert/strict';
import { cleanupPolicyRevisionFixture } from './policy-revision-fixture-cleanup.mjs';
/** Only synthetic grants in the disposable integration-test cluster are removed. */
export async function cleanupManualLiveFixture(db, sessionId, ownerId, scopeId) {
  assert.match(
    process.env.LOCAL_POSTGRES_CLUSTER ?? '',
    /^(game-test-|visual-test-|manual-live-final-|authoring-text-test-)/,
  );
  const match = (
    await db.query('SELECT 1 FROM live_test_sessions WHERE id=$1 AND owner_id=$2 AND scope_id=$3', [
      sessionId,
      ownerId,
      scopeId,
    ])
  ).rows;
  if (!match.length) return;
  if (
    (await db.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0].present
  ) {
    await db.query(
      'DELETE FROM visual_spatial_proposals WHERE job_id IN(SELECT id FROM live_authoring_text_jobs WHERE session_id=$1)',
      [sessionId],
    );
    await db.query('DELETE FROM live_authoring_text_jobs WHERE session_id=$1', [sessionId]);
    await db.query('DELETE FROM live_authoring_text_quotes WHERE session_id=$1', [sessionId]);
  }
  await db.query('DELETE FROM live_test_text_permits WHERE session_id=$1', [sessionId]);
  await cleanupPolicyRevisionFixture(db, [sessionId]);
  await db.query('DELETE FROM live_test_sessions WHERE id=$1 AND owner_id=$2', [
    sessionId,
    ownerId,
  ]);
  await db.query('DELETE FROM generation_budget_reservations WHERE scope_id=$1 AND actor_id=$2', [
    scopeId,
    ownerId,
  ]);
  await db.query(
    'DELETE FROM generation_budget_scopes WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1) AND NOT EXISTS(SELECT 1 FROM live_test_sessions WHERE scope_id=$1)',
    [scopeId],
  );
}
