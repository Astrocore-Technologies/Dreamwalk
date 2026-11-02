import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  adventureSchema,
  authoredGameDraftSchema,
  safeNpcMetadata,
  readerStoryContent,
} from '@dreamwalk/contracts';
import { Db } from '../db';
import { PlayableService } from '../game/playable.service';
import { fail } from '../errors';

const inputSchema = z
  .object({
    operationId: z.uuid(),
    expectedEditRevision: z.number().int().positive(),
    expectedGameRevision: z.number().int().positive(),
    expectedArtRevision: z.number().int().nonnegative(),
  })
  .strict();

@Injectable()
export class PrivateReleaseService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(PlayableService) private playable: PlayableService,
  ) {}
  async publish(owner: string, adventureId: string, body: unknown) {
    z.uuid().parse(adventureId);
    const input = inputSchema.parse(body);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ adventureId, ...input }))
      .digest('hex');
    return this.db.tx(async (c) => {
      await this.playable.lockAuthor(c, owner);
      const story = (
        await c.query(
          "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
          [adventureId, owner],
        )
      ).rows[0];
      if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const prior = (
        await c.query(
          'SELECT * FROM adventure_private_releases WHERE adventure_id=$1 AND operation_id=$2',
          [adventureId, input.operationId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return { releaseId: prior.id, playableVersionId: prior.playable_version_id };
      }
      if (story.visibility !== 'private')
        fail(409, 'STATE_CONFLICT', 'Private visibility required');
      if (Number(story.edit_revision) !== input.expectedEditRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const data = adventureSchema.parse(story.data);
      if (!data.title.trim() || !data.content.locations.length)
        fail(400, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      const gameRow = (
        await c.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1 FOR SHARE', [
          adventureId,
        ])
      ).rows[0];
      if (!gameRow) fail(409, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      const game = authoredGameDraftSchema.parse(gameRow.draft);
      const sameIds = (a: string[], b: string[]) =>
        JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
      if (
        !sameIds(
          game.maps.flatMap((m) => (m.sourceLocationId ? [m.sourceLocationId] : [])),
          data.content.locations.map((l) => l.id),
        ) ||
        !sameIds(
          game.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : [])),
          data.content.npcIds,
        )
      )
        fail(409, 'STORY_SOURCE_MISMATCH', 'Rebuild the playable plan from the current story.');
      const playableVersionId = await this.playable.freeze(
        c,
        story,
        'private',
        input.expectedGameRevision,
        input.expectedArtRevision,
      );
      if (!playableVersionId) fail(409, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      const rows = (
        await c.query(
          'SELECT id,data FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3)',
          [owner, data.content.npcIds, adventureId],
        )
      ).rows;
      if (rows.length !== new Set(data.content.npcIds).size)
        fail(400, 'VALIDATION_FAILED', 'VALIDATION_FAILED');
      const publicNpcs = rows.map((row) => {
        const {
          secrets: _secrets,
          biography: _biography,
          characterProfile: _characterProfile,
          ...safe
        } = row.data;
        return { ...safe, ...safeNpcMetadata(row.data), id: row.id };
      });
      const snapshot = {
        ...data,
        content: readerStoryContent(data.content),
        status: 'published',
        visibility: 'private',
        playableVersionId,
        publicNpcs,
      };
      const releaseId = randomUUID();
      await c.query(
        'INSERT INTO adventure_private_releases(id,adventure_id,playable_version_id,owner_id,operation_id,request_hash,source_edit_revision,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          releaseId,
          adventureId,
          playableVersionId,
          owner,
          input.operationId,
          requestHash,
          story.edit_revision,
          JSON.stringify(snapshot),
        ],
      );
      await c.query(
        "UPDATE adventures SET private_release_id=$2,status='published',updated_at=now() WHERE id=$1",
        [adventureId, releaseId],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        owner,
        'adventure.private.publish',
        adventureId,
        JSON.stringify({ releaseId, playableVersionId }),
      ]);
      return { releaseId, playableVersionId };
    });
  }
}
