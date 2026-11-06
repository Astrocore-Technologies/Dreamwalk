/** Serialize different authored posts before preparing or dispatching their work.
 * A later director must not mutate a frozen earlier reply's context in flight.
 * Same-post director/speech dependencies remain governed by awaitStoryDirector;
 * private world planning retains its existing independent priority. */
export const orderedTurnRequestsSql = `SELECT * FROM game_npc_decision_requests r
WHERE campaign_id=$1 AND status='queued'
AND NOT EXISTS (
  SELECT 1 FROM game_story_turns current_post
  JOIN game_story_turns earlier_post
    ON earlier_post.campaign_id=current_post.campaign_id
    AND earlier_post.submitted_sequence < current_post.submitted_sequence
    AND earlier_post.input->'turnFence'->>'roundId'=$2
  JOIN game_npc_decision_requests earlier
    ON earlier.campaign_id=earlier_post.campaign_id
    AND earlier_post.id::text=CASE WHEN earlier.purpose='speech'
      THEN earlier.context->>'storyTurnId' ELSE earlier.id::text END
  LEFT JOIN npc_ai_jobs earlier_job ON earlier_job.id=earlier.job_id
  WHERE current_post.campaign_id=r.campaign_id
    AND current_post.id::text=CASE WHEN r.purpose='speech'
      THEN r.context->>'storyTurnId' ELSE r.id::text END
    AND current_post.input->'turnFence'->>'roundId'=$2
    AND ((r.purpose='speech' AND r.context ? 'deferredSpeechId')
      OR (r.purpose='story_turn' AND r.context->>'turnBasedDeferredDirector'='true'))
    AND ((earlier.purpose='speech' AND earlier.context ? 'deferredSpeechId')
      OR (earlier.purpose='story_turn' AND earlier.context->>'turnBasedDeferredDirector'='true'))
    AND earlier.status IN ('queued','scheduled')
    AND (earlier_job.id IS NULL
      OR earlier_job.status NOT IN ('committed','stale','failed','cancelled','reconciling'))
)
ORDER BY CASE WHEN purpose='plan' AND context ? 'worldRoundDecision' THEN 0
  WHEN purpose='story_turn' AND context ? 'travelSceneSpec' THEN 1
  WHEN purpose='story_turn' AND context->>'generationPolicy'='world-batch-v1' THEN 2 ELSE 3 END,
  CASE WHEN context ? 'turnOrder' THEN (context->>'turnOrder')::bigint ELSE 9223372036854775807 END,
  created_at,id LIMIT 8`;
