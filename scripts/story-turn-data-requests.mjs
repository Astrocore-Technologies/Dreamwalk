/** Unified-turn data rights. Caller owns confirmed-erasure transaction and campaign locks. */
import { randomUUID } from 'node:crypto';

export async function exportStoryTurnData(client, userId) {
  return (
    await client.query(
      `SELECT id,campaign_id,operation_id,input,segments,status,result_code,result,created_at,committed_at
       FROM game_story_turns WHERE requester_user_id=$1 AND erased_at IS NULL ORDER BY created_at,id`,
      [userId],
    )
  ).rows;
}

export async function purgeStoryTurnData(client, campaignId, userId) {
  // One response can paraphrase a different participant's prior contribution.
  // Conservatively clear all derived turn prose while preserving world mechanics,
  // financial receipts and operation tombstones. Deleting the operation rows would
  // let a surviving participant replay an old operation as a newly paid request.
  const result = await client.query(
    `UPDATE game_story_turns SET
       input='{}',segments='[]',context='{}',quote_result=NULL,proposal=NULL,result=NULL,
       quote_id=NULL,confirmed_action_hash=NULL,proposal_hash=NULL,
       request_hash='erased',confirmation_request_hash=NULL,
       status='failed',result_code='DATA_ERASED',valid_until_tick=NULL,
       actor_id=CASE WHEN requester_user_id=$2 THEN $3 ELSE actor_id END,
       erased_at=COALESCE(erased_at,now())
     WHERE campaign_id=$1 RETURNING id`,
    [campaignId, userId, `erased-${randomUUID()}`],
  );
  await client.query('DELETE FROM game_story_feed WHERE campaign_id=$1', [campaignId]);
  // requester_user_id and operation_id remain opaque anti-replay identity keys;
  // the deleted account cannot authenticate. No payer/ledger row is altered here.
  return result.rowCount > 0;
}
