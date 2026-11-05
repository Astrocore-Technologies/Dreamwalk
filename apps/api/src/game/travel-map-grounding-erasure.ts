import type { PoolClient } from 'pg';
import { settleReservationSparks } from '../generation/sparks-hooks';
/** Called only inside confirmed image/campaign erasure. Cancel undispatched work,
 * preserve unresolved liabilities, and remove every duplicate of private raster input. */
export async function eraseTravelMapGrounding(
  c: PoolClient,
  ownerId: string,
  campaignIds: string[],
) {
  const rows = (
    await c.query(
      `SELECT g.preparation_id,g.project_id,g.job_id FROM game_travel_map_groundings g JOIN game_location_travel_preparations p ON p.id=g.preparation_id WHERE p.owner_id=$1 OR p.campaign_id=ANY($2::uuid[]) ORDER BY g.preparation_id FOR UPDATE OF g NOWAIT`,
      [ownerId, campaignIds],
    )
  ).rows;
  for (const row of rows) {
    if (row.job_id) {
      const job = (
        await c.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE NOWAIT', [
          row.job_id,
        ])
      ).rows[0];
      if (job?.status === 'queued' && !job.dispatched_at) {
        await settleReservationSparks(c, job.reservation_id, {
          outcome: 'not_dispatched',
          receiptId: `travel-erasure:${job.id}`,
        });
        await c.query(
          "UPDATE generation_budget_reservations SET status='settled',actual_micros=0 WHERE id=$1 AND status='held'",
          [job.reservation_id],
        );
      }
      await c.query(
        "UPDATE live_authoring_text_jobs SET context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',proposal=NULL,result=NULL,provider_request_id=NULL,cancel_requested=true,status=CASE WHEN status='dispatched' THEN 'unknown' WHEN status IN ('queued','generated','committed') THEN 'cancelled' ELSE status END,error_code='DATA_ERASED',updated_at=now() WHERE id=$1",
        [row.job_id],
      );
    }
    await c.query(
      "UPDATE live_authoring_text_quotes SET context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',request_hash='erased' WHERE project_id=$1",
      [row.project_id],
    );
    await c.query('DELETE FROM game_travel_map_groundings WHERE preparation_id=$1', [
      row.preparation_id,
    ]);
    await c.query(
      "UPDATE visual_authoring_projects SET status='cancelled',brief='{}',plan=NULL,preview_state=NULL WHERE id=$1",
      [row.project_id],
    );
  }
}
