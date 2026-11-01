import type { PoolClient } from 'pg';
export async function exportVisualAuthoring(c: PoolClient, owner: string) {
  return {
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
