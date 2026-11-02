import { settleReservationSparks } from '../generation/sparks-hooks';
import type { PoolClient } from 'pg';
export async function exportVisualAuthoring(c: PoolClient, owner: string) {
  return {
    startPreparations: (
      await c.query(
        'SELECT id,source_version_id,hero_id,hero_snapshot,status,reused,campaign_id,created_at FROM game_start_preparations WHERE actor_id=$1',
        [owner],
      )
    ).rows,
    projects: (
      await c.query(
        'SELECT id,kind,brief,status,plan,generation_mode,public_grounding,plan_origin,plan_authority,created_at FROM visual_authoring_projects WHERE owner_id=$1',
        [owner],
      )
    ).rows,
    storyBuilds: (
      await c.query(
        'SELECT project_id,adventure_id,source_snapshot,status,proposal,draft,created_at,applied_at FROM story_playable_builds WHERE owner_id=$1',
        [owner],
      )
    ).rows,
    spatialProposals: (
      await c.query(
        'SELECT id,project_id,job_id,project_revision,source_hash,layout,plan,status,created_at FROM visual_spatial_proposals WHERE owner_id=$1',
        [owner],
      )
    ).rows,
    generationStages: (
      await c.query(
        `SELECT s.* FROM visual_authoring_stage_items s JOIN visual_authoring_projects p ON p.id=s.project_id WHERE p.owner_id=$1`,
        [owner],
      )
    ).rows,
    packages: (
      await c.query(
        'SELECT id,manifest,plan,created_at FROM visual_package_versions WHERE owner_id=$1',
        [owner],
      )
    ).rows,
  };
}
export async function eraseVisualAuthoring(c: PoolClient, owner: string) {
  if (
    !(
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND deleted_at IS NOT NULL AND current_setting('dreamwalk.erasure',true)='confirmed'",
        [owner],
      )
    ).rowCount
  )
    throw new Error('CONFIRMED_ERASURE_REQUIRED');
  const starts = (
    await c.query(
      `SELECT s.id FROM game_start_preparations s JOIN game_playable_versions v ON v.id=s.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE s.actor_id=$1 OR a.owner_id=$1 ORDER BY s.id FOR UPDATE OF s NOWAIT`,
      [owner],
    )
  ).rows.map((r) => r.id);
  if (starts.length) {
    const jobs = (
      await c.query(
        'SELECT * FROM live_authoring_text_jobs WHERE project_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [starts],
      )
    ).rows;
    for (const job of jobs) {
      if (job.status === 'queued' && !job.dispatched_at) {
        await settleReservationSparks(c, job.reservation_id, {
          outcome: 'not_dispatched',
          receiptId: `start-erasure:${job.id}`,
        });
        await c.query(
          "UPDATE generation_budget_reservations SET status='settled',actual_micros=0 WHERE id=$1 AND status='held'",
          [job.reservation_id],
        );
      }
      await c.query(
        `UPDATE live_authoring_text_jobs SET context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',proposal=NULL,result=NULL,provider_request_id=NULL,cancel_requested=true,status=CASE WHEN status='dispatched' THEN 'unknown' WHEN status IN ('queued','generated','committed') THEN 'cancelled' ELSE status END,error_code='DATA_ERASED',updated_at=now() WHERE id=$1`,
        [job.id],
      );
    }
    await c.query(
      "UPDATE live_authoring_text_quotes SET context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',request_hash='erased' WHERE project_id=ANY($1::uuid[])",
      [starts],
    );
    await c.query(
      "UPDATE visual_authoring_projects SET status='cancelled',brief='{}',plan=NULL,preview_state=NULL WHERE id=ANY($1::uuid[])",
      [starts],
    );
    await c.query('DELETE FROM game_start_preparations WHERE id=ANY($1::uuid[])', [starts]);
  }
  await c.query('DELETE FROM story_playable_builds WHERE owner_id=$1', [owner]);
  await c.query('DELETE FROM visual_spatial_proposals WHERE owner_id=$1', [owner]);
  await c.query(
    'DELETE FROM visual_authoring_stage_items WHERE project_id IN (SELECT id FROM visual_authoring_projects WHERE owner_id=$1)',
    [owner],
  );
  await c.query('DELETE FROM visual_authoring_operations WHERE owner_id=$1', [owner]);
  await c.query('DELETE FROM visual_package_versions WHERE owner_id=$1', [owner]);
  await c.query('DELETE FROM visual_authoring_projects WHERE owner_id=$1', [owner]);
}
