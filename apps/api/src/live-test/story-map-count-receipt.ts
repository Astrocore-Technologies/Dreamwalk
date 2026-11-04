import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '../db';
import { fail } from '../errors';
import { ProviderFailure } from '../ai/types';
import type { StoryMapCountRequired } from './story-map-count';

/** A quote-only operational request, not generation or a player charge. Reuse the
 * existing metadata-only receipt and erasure path; campaign=NULL denotes authoring.
 * Unknown provider fees remain NULL, never a fabricated zero-cost invoice. */
export async function resolveStoryMapCount(
  db: Pick<Db, 'query' | 'tx'>,
  ownerId: string,
  request: StoryMapCountRequired,
  authorize: (client: PoolClient) => Promise<void>,
) {
  const admitted = await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `story-map-count:${ownerId}`,
    ]);
    // The source/family/member rights are rechecked AFTER waiting for locks and
    // before recording admission. No request body is sent under SQL locks.
    await authorize(c);
    const prior = (
      await c.query(
        "SELECT * FROM runtime_map_token_counts WHERE actor_id=$1 AND campaign_id IS NULL AND provider_version=$2 AND body_sha256=$3 AND (status IN ('dispatched','unknown') OR (status='succeeded' AND created_at>clock_timestamp()-interval '10 minutes')) ORDER BY CASE WHEN status='succeeded' THEN 1 ELSE 0 END,created_at DESC LIMIT 1",
        [ownerId, request.providerVersion, request.bodySha256],
      )
    ).rows[0];
    if (prior?.status === 'succeeded')
      return {
        tokens: Number(prior.input_tokens),
        expiresAt: new Date(prior.created_at).getTime() + 600000,
      };
    if (prior) fail(409, 'STORY_MAP_COUNT_UNRESOLVED', 'STORY_MAP_COUNT_UNRESOLVED');
    const recent = (
      await c.query(
        "SELECT count(*)::int AS n FROM runtime_map_token_counts WHERE actor_id=$1 AND created_at>clock_timestamp()-interval '1 minute'",
        [ownerId],
      )
    ).rows[0];
    if (Number(recent.n) >= 60) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
    const id = randomUUID();
    await c.query(
      "INSERT INTO runtime_map_token_counts(id,actor_id,body_sha256,model,provider_version,status) VALUES($1,$2,$3,$4,$5,'dispatched')",
      [id, ownerId, request.bodySha256, request.model, request.providerVersion],
    );
    return { id };
  });
  if ('tokens' in admitted) {
    request.accept(admitted.tokens!, admitted.expiresAt!);
    return;
  }
  try {
    const tokens = await request.count(admitted.id!);
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('TEXT_COUNT_INVALID_RESPONSE');
    const saved = await db.query(
      "UPDATE runtime_map_token_counts SET status='succeeded',input_tokens=$2,completed_at=clock_timestamp() WHERE id=$1 AND status='dispatched' RETURNING id,created_at",
      [admitted.id, tokens],
    );
    if (!saved.length) fail(409, 'STORY_MAP_QUOTE_CHANGED', 'STORY_MAP_QUOTE_CHANGED');
    request.accept(tokens, new Date(saved[0].created_at as string).getTime() + 600000);
  } catch (error) {
    await db.query(
      "UPDATE runtime_map_token_counts SET status='unknown',result_code=$2,completed_at=clock_timestamp() WHERE id=$1 AND status='dispatched'",
      [admitted.id, error instanceof ProviderFailure ? error.code : 'STORY_MAP_COUNT_FAILED'],
    );
    // No automatic retry or fallback image-token guess after an uncertain request.
    fail(503, 'STORY_MAP_COUNT_UNAVAILABLE', 'STORY_MAP_COUNT_UNAVAILABLE');
  }
}
