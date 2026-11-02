import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  adventureSchema,
  npcSchema,
  npcTextFields,
  previewStoryLore,
  validateStoryLoreReferences,
} from '@dreamwalk/contracts';
import { Db } from '../db';
import { fail } from '../errors';
import { ownedCharacterPackage } from '../visual-authoring/character-package';

const mutation = z.object({
  requestId: z.uuid(),
  expectedStoryRevision: z.number().int().positive().safe(),
});
type Row = Record<string, unknown>;
type NpcData = z.infer<typeof npcSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function view(row: Row) {
  return {
    ...npcSchema.parse(row.data),
    id: row.id,
    storyId: row.story_id ?? null,
    sourceTemplateId: row.source_template_id ?? null,
    editRevision: Number(row.edit_revision),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

/** Owner-only story authoring. Library templates are copied, never edited in place. */
@Injectable()
export class StoryNpcService {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async story(c: PoolClient, userId: string, storyId: string) {
    z.uuid().parse(storyId);
    const row = (
      await c.query(
        "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
        [storyId, userId],
      )
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return row;
  }
  private async local(c: PoolClient, userId: string, storyId: string, npcId: string) {
    z.uuid().parse(npcId);
    const row = (
      await c.query('SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 AND story_id=$3 FOR UPDATE', [
        npcId,
        userId,
        storyId,
      ])
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return row;
  }
  private async validate(c: PoolClient, userId: string, input: NpcData) {
    const data = npcSchema.parse(input);
    if (
      data.portraitAssetId &&
      !(
        await c.query('SELECT id FROM assets WHERE id=$1 AND owner_id=$2 FOR SHARE', [
          data.portraitAssetId,
          userId,
        ])
      ).rowCount
    )
      fail(400, 'VALIDATION_FAILED', 'ASSET_NOT_FOUND');
    if (
      data.modelProfileId &&
      !(await c.query('SELECT id FROM model_profiles WHERE id=$1 FOR SHARE', [data.modelProfileId]))
        .rowCount
    )
      fail(400, 'VALIDATION_FAILED', 'MODEL_NOT_FOUND');
    if (data.characterPackageVersionId) {
      const { manifest } = await ownedCharacterPackage(c, userId, data.characterPackageVersionId);
      const portrait = manifest.parts.find((part) => part.role === 'portrait');
      if (portrait) data.portraitAssetId = portrait.uploadId;
    }
    return data;
  }
  private async run(
    userId: string,
    storyId: string,
    operation: string,
    input: z.infer<typeof mutation>,
    work: (c: PoolClient, story: Row) => Promise<Record<string, unknown>>,
  ) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonical({ operation, input })))
      .digest('hex');
    return this.db.tx(async (c) => {
      const story = await this.story(c, userId, storyId);
      const previous = (
        await c.query(
          'SELECT owner_id,fingerprint,result FROM story_npc_operations WHERE story_id=$1 AND request_id=$2',
          [storyId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.owner_id !== userId || previous.fingerprint !== fingerprint)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return previous.result;
      }
      if (Number(story.edit_revision) !== input.expectedStoryRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const result = await work(c, story);
      await c.query(
        'INSERT INTO story_npc_operations(story_id,request_id,owner_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',
        [storyId, input.requestId, userId, fingerprint, JSON.stringify(result)],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        userId,
        `story.npc.${operation.split(':')[0]}`,
        storyId,
        JSON.stringify({ requestId: input.requestId }),
      ]);
      return result;
    });
  }
  private async link(c: PoolClient, story: Row, npcId: string, replaceId?: string) {
    const source = adventureSchema.parse(story.data);
    const ids = source.content.npcIds;
    const next = [...new Set([...ids.map((id) => (id === replaceId ? npcId : id)), npcId])];
    if (next.length > 30) fail(400, 'VALIDATION_FAILED', 'NPC_LIMIT');
    const data = { ...source, status: 'draft', content: { ...source.content, npcIds: next } };
    return (
      await c.query(
        "UPDATE adventures SET data=$2,status='draft',updated_at=now() WHERE id=$1 RETURNING edit_revision",
        [story.id, JSON.stringify(data)],
      )
    ).rows[0].edit_revision;
  }
  async list(userId: string, storyId: string) {
    return this.db.tx(async (c) => {
      const story = await this.story(c, userId, storyId);
      const rows = (
        await c.query(
          'SELECT * FROM npcs WHERE owner_id=$1 AND story_id=$2 ORDER BY created_at,id',
          [userId, storyId],
        )
      ).rows;
      return { npcs: rows.map(view), storyEditRevision: Number(story.edit_revision) };
    });
  }
  async previewLore(userId: string, storyId: string, body: unknown) {
    const input = z
      .object({
        npcId: z.uuid(),
        query: z.string().trim().max(200).default(''),
        locationId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,80}$/)
          .optional(),
      })
      .strict()
      .parse(body);
    return this.db.tx(async (c) => {
      const story = await this.story(c, userId, storyId);
      const content = adventureSchema.parse(story.data).content;
      if (!validateStoryLoreReferences(content))
        fail(400, 'VALIDATION_FAILED', 'INVALID_LORE_REFERENCE');
      if (
        !content.npcIds.includes(input.npcId) ||
        (input.locationId && !content.locations.some((entry) => entry.id === input.locationId))
      )
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const owned = await c.query(
        'SELECT id FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3)',
        [userId, content.npcIds, storyId],
      );
      if (owned.rowCount !== new Set(content.npcIds).size) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      return {
        npcId: input.npcId,
        storyEditRevision: Number(story.edit_revision),
        providerCalls: 0,
        entries: previewStoryLore(
          content.lorebook ?? [],
          input.npcId,
          input.query,
          input.locationId,
        ),
      };
    });
  }
  async create(userId: string, storyId: string, body: unknown) {
    const input = mutation.extend({ npc: npcSchema }).strict().parse(body);
    return this.run(userId, storyId, 'create', input, async (c, story) => {
      const data = await this.validate(c, userId, {
        ...input.npc,
        sourceRevision: 1,
        translations: {},
        visibility: 'private',
      });
      const row = (
        await c.query(
          'INSERT INTO npcs(id,owner_id,story_id,data) VALUES($1,$2,$3,$4) RETURNING *',
          [randomUUID(), userId, storyId, JSON.stringify(data)],
        )
      ).rows[0];
      const revision = await this.link(c, story, row.id);
      return { npc: view(row), storyEditRevision: Number(revision) };
    });
  }
  async importTemplate(userId: string, storyId: string, body: unknown) {
    const input = mutation.extend({ templateId: z.uuid() }).strict().parse(body);
    return this.run(userId, storyId, 'import', input, async (c, story) => {
      const template = (
        await c.query(
          'SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 AND story_id IS NULL FOR SHARE',
          [input.templateId, userId],
        )
      ).rows[0];
      if (!template) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const data = await this.validate(
        c,
        userId,
        npcSchema.parse({
          ...template.data,
          sourceRevision: 1,
          translations: {},
          visibility: 'private',
        }),
      );
      const row = (
        await c.query(
          'INSERT INTO npcs(id,owner_id,story_id,source_template_id,data) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [randomUUID(), userId, storyId, template.id, JSON.stringify(data)],
        )
      ).rows[0];
      const revision = await this.link(c, story, row.id, template.id);
      return { npc: view(row), storyEditRevision: Number(revision) };
    });
  }
  async update(userId: string, storyId: string, npcId: string, body: unknown) {
    const input = mutation
      .extend({
        expectedNpcRevision: z.number().int().positive().safe(),
        patch: npcSchema.partial(),
      })
      .strict()
      .parse(body);
    return this.run(userId, storyId, `update:${npcId}`, input, async (c, story) => {
      const old = await this.local(c, userId, storyId, npcId);
      if (Number(old.edit_revision) !== input.expectedNpcRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const original = npcSchema.parse(old.data);
      const data = await this.validate(
        c,
        userId,
        npcSchema.parse({
          ...original,
          ...input.patch,
          sourceRevision: original.sourceRevision,
          translations: original.translations,
          visibility: 'private',
        }),
      );
      if (
        npcTextFields.some((field) => data[field] !== original[field]) ||
        JSON.stringify(data.characterProfile) !== JSON.stringify(original.characterProfile) ||
        data.sourceLanguage !== original.sourceLanguage
      )
        data.sourceRevision++;
      const row = (
        await c.query('UPDATE npcs SET data=$2,updated_at=now() WHERE id=$1 RETURNING *', [
          npcId,
          JSON.stringify(data),
        ])
      ).rows[0];
      const revision = await this.link(c, story, row.id);
      return { npc: view(row), storyEditRevision: Number(revision) };
    });
  }
  async saveAsTemplate(userId: string, storyId: string, npcId: string, body: unknown) {
    const input = mutation
      .extend({ expectedNpcRevision: z.number().int().positive().safe() })
      .strict()
      .parse(body);
    return this.run(userId, storyId, `export:${npcId}`, input, async (c, story) => {
      const local = await this.local(c, userId, storyId, npcId);
      if (Number(local.edit_revision) !== input.expectedNpcRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const data = await this.validate(
        c,
        userId,
        npcSchema.parse({
          ...local.data,
          sourceRevision: 1,
          translations: {},
          visibility: 'private',
        }),
      );
      const row = (
        await c.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3) RETURNING *', [
          randomUUID(),
          userId,
          JSON.stringify(data),
        ])
      ).rows[0];
      return { npc: view(row), storyEditRevision: Number(story.edit_revision) };
    });
  }
}
