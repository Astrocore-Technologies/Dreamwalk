import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Db } from './db';
import { readableAdventureSql } from './content';
import { fail } from './errors';

// Admin status is not permission to read an author's private drafts or NPC secrets.
export const adminAdventureAccessSql = (user: string) =>
  `(((a.visibility='public' AND (a.status IN('pending_review','published') OR a.published_snapshot IS NOT NULL)) OR ${readableAdventureSql(user)}) AND (a.owner_id=${user} OR a.visibility<>'private' OR EXISTS(SELECT 1 FROM adventure_private_releases pr WHERE pr.id=a.private_release_id AND pr.adventure_id=a.id AND pr.owner_id=a.owner_id)))`;

// Opaque row-change token includes PostgreSQL's transaction revision and full
// timestamp precision, rather than the millisecond timestamp used for display.
export const adminDeletionRevisionSql = (alias = 'a') =>
  `md5(${alias}.xmin::text || ':' || ${alias}.updated_at::text || ':' || ${alias}.id::text)`;

const removalSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
const restoreSchema = z.object({ deletionId: z.uuid() }).strict();
const trashAccessSql = `(a.deleted_by=$2 OR a.owner_id=$2 OR (a.visibility='public' AND a.published_snapshot IS NOT NULL))`;

export async function deletedStories(db: Db, adminId: string) {
  // Deliberately metadata-only: never expose the stored draft, private snapshot,
  // playable package, reasons from other reviews or player campaign contents.
  return db.query(
    `SELECT a.id,a.deletion_id AS "deletionId",a.deleted_at AS "deletedAt",
      CASE WHEN a.owner_id=$1 THEN a.title
        WHEN a.visibility='private' THEN pr.snapshot->>'title'
        ELSE COALESCE(a.published_snapshot->>'title',a.title) END AS title
      FROM adventures a JOIN users u ON u.id=a.owner_id
      LEFT JOIN adventure_private_releases pr ON pr.id=a.private_release_id
      WHERE a.deleted_at IS NOT NULL AND u.deleted_at IS NULL
      AND (a.deleted_by=$1 OR a.owner_id=$1 OR (a.visibility='public' AND a.published_snapshot IS NOT NULL))
      ORDER BY a.deleted_at DESC,a.id LIMIT 200`,
    [adminId],
  );
}

export async function removeStory(
  db: Db,
  adminId: string,
  id: string,
  body: unknown,
  lockAuthor: (client: PoolClient, ownerId: string) => Promise<unknown>,
) {
  z.uuid().parse(id);
  const input = removalSchema.parse(body);
  return db.tx(async (c) => {
    const pre = (await c.query('SELECT owner_id FROM adventures WHERE id=$1', [id])).rows[0];
    if (!pre) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    await lockAuthor(c, pre.owner_id);
    const row = (
      await c.query(
        `SELECT a.*,${adminDeletionRevisionSql()} AS deletion_revision FROM adventures a WHERE a.id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    // A response lost after commit may be retried. The same old request must also
    // remain harmless after restore, rather than deleting the story a second time.
    const replay = (
      await c.query(
        'SELECT adventure_id,expected_revision FROM adventure_deletion_operations WHERE actor_id=$1 AND operation_id=$2',
        [adminId, input.operationId],
      )
    ).rows[0];
    if (replay) {
      if (replay.adventure_id !== id || replay.expected_revision !== input.expectedRevision)
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      return {
        ok: true,
        deleted: !!row.deleted_at && row.deletion_id === input.operationId,
        deletionId: input.operationId,
      };
    }
    const eligible = (
      await c.query(
        `SELECT a.id FROM adventures a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${adminAdventureAccessSql('$2')}`,
        [id, adminId],
      )
    ).rowCount;
    if (!eligible) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (row.deletion_revision !== input.expectedRevision) fail(409, 'STALE_STATE', 'STALE_STATE');
    const admitted = await c.query(
      'INSERT INTO adventure_deletion_operations(actor_id,operation_id,adventure_id,expected_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [adminId, input.operationId, id, input.expectedRevision],
    );
    // A simultaneous request cannot rebind the same identity to a different story.
    if (!admitted.rowCount) fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    // Archiving invokes the existing source-revocation triggers for queued jobs,
    // generation consents and sponsors, without guessing or releasing liabilities.
    await c.query(
      "UPDATE adventures SET status='archived',deleted_at=now(),deleted_by=$2,deletion_id=$3,updated_at=clock_timestamp() WHERE id=$1",
      [id, adminId, input.operationId],
    );
    await c.query(
      "UPDATE adventure_invitations SET status='revoked',updated_at=now() WHERE adventure_id=$1 AND status IN('pending','accepted')",
      [id],
    );
    await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
      adminId,
      'adventure.delete',
      id,
      JSON.stringify({ deletionId: input.operationId }),
    ]);
    return { ok: true, deleted: true, deletionId: input.operationId };
  });
}

export async function restoreStory(
  db: Db,
  adminId: string,
  id: string,
  body: unknown,
  lockAuthor: (client: PoolClient, ownerId: string) => Promise<unknown>,
) {
  z.uuid().parse(id);
  const input = restoreSchema.parse(body);
  return db.tx(async (c) => {
    const pre = (await c.query('SELECT owner_id FROM adventures WHERE id=$1', [id])).rows[0];
    if (!pre) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    await lockAuthor(c, pre.owner_id);
    const row = (
      await c.query(
        `SELECT a.* FROM adventures a WHERE a.id=$1 AND (${trashAccessSql} OR EXISTS(
          SELECT 1 FROM audit r WHERE r.actor_id=$2 AND r.action='adventure.restore'
          AND r.target_id=a.id::text AND r.details->>'deletionId'=$3)) FOR UPDATE`,
        [id, adminId, input.deletionId],
      )
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (row.deletion_id !== input.deletionId) fail(409, 'STALE_STATE', 'STALE_STATE');
    if (!row.deleted_at) return { ok: true, deleted: false, deletionId: input.deletionId };
    // Restore only an author draft. Publication, old invitations, paid consent and
    // queued generation are never re-enabled by restoring content.
    await c.query(
      "UPDATE adventures SET deleted_at=NULL,status='draft',published_snapshot=NULL,private_release_id=NULL,submitted_game_version_id=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE adventure_invitations SET status='revoked',updated_at=now() WHERE adventure_id=$1 AND status IN('pending','accepted')",
      [id],
    );
    await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
      adminId,
      'adventure.restore',
      id,
      JSON.stringify({ deletionId: input.deletionId, status: 'draft' }),
    ]);
    return { ok: true, deleted: false, deletionId: input.deletionId };
  });
}
