import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Locale } from '@dreamwalk/contracts';
import type { Db } from '../db';
import { digest } from '../ai/context';
import { ProviderFailure } from '../ai/types';
import { ownerPricingIsCurrent, type ReleaseGenerationConfig } from '../generation/config';
import { currentReleaseDeployment } from '../generation/release-deployment';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import { settleGenerationSpend } from '../image-generation/budget';
import type { AuthoringTextProvider, AuthoringTextResult } from '../live-test/authoring-provider';
import { validateTranslations } from './definition';
import { translationProjection, type VisibleText } from './projection';
import { reserveMetadataSpend, METADATA_BUDGET_SCOPE } from './metadata-budget';

export const PLATFORM_METADATA_VERSION = 'released-metadata-v1';
type MetadataField = VisibleText & { metadata: NonNullable<VisibleText['metadata']> };
export const isMetadataField = (field: VisibleText): field is MetadataField =>
  field.scope.kind === 'adventure' && !!field.metadata;
/** No viewer or unrelated revision: one translation per exact released field/language.
 * Visibility is part of identity; private metadata never uses a public cache key. */
export function metadataTranslationKey(field: MetadataField, locale: Locale) {
  return digest([
    PLATFORM_METADATA_VERSION,
    field.scope.id,
    field.metadata.visibility,
    field.metadata.sourceLanguage,
    locale,
    field.metadata.field,
    field.source,
    field.maxLength,
  ]);
}
interface MetadataJob extends QueryResultRow {
  id: string;
  adventure_id: string | null;
  requester_id: string | null;
  visibility: 'public' | 'private';
  locale: Locale;
  cache_keys: string[];
  context: {
    targetLocale: Locale;
    items: { id: string; text: string; maxLength: number }[];
  } | null;
  provider_version: string;
  config_fingerprint: string;
  reservation_id: string;
  status: string;
  request_snapshot: Parameters<AuthoringTextProvider['generate']>[0]['textReservationSnapshot'];
  result: unknown;
  provider_usage: AuthoringTextResult['usage'] | null;
  error_code: string | null;
}

/** Recheck the released source and audience before enqueue, dispatch and cache commit.
 * No draft/content/lore fields enter the provider context. */
async function releasedFields(
  c: Pick<PoolClient, 'query'>,
  adventureId: string,
  requesterId: string | null,
  visibility: 'public' | 'private',
  locale: Locale,
) {
  // Fail fast rather than wait behind account erasure, which holds user locks
  // before scrubbing jobs. These locks are retained through dispatch/cache commit.
  const owner = (await c.query('SELECT owner_id FROM adventures WHERE id=$1', [adventureId]))
    .rows[0]?.owner_id;
  if (!owner) return [];
  await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT', [
    [...new Set([owner, requesterId].filter(Boolean))].sort(),
  ]);
  const adventure = (
    await c.query('SELECT owner_id FROM adventures WHERE id=$1 FOR SHARE NOWAIT', [adventureId])
  ).rows[0];
  if (adventure?.owner_id !== owner) return [];
  if (visibility === 'private' && requesterId)
    await c.query(
      'SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 FOR SHARE NOWAIT',
      [adventureId, requesterId],
    );
  const row = (
    await c.query(
      `SELECT a.id,a.visibility,CASE WHEN a.visibility='public' THEN a.published_snapshot ELSE r.snapshot END AS snapshot
     FROM adventures a JOIN users owner ON owner.id=a.owner_id AND owner.deleted_at IS NULL
     LEFT JOIN adventure_private_releases r ON r.id=a.private_release_id
     WHERE a.id=$1 AND a.deleted_at IS NULL AND a.status<>'archived' AND a.visibility=$3
       AND ((a.visibility='public' AND a.published_snapshot IS NOT NULL)
         OR (a.visibility='private' AND r.snapshot IS NOT NULL
           AND EXISTS(SELECT 1 FROM users viewer WHERE viewer.id=$2 AND viewer.deleted_at IS NULL)
           AND (a.owner_id=$2 OR EXISTS(SELECT 1 FROM adventure_invitations i
             WHERE i.adventure_id=a.id AND i.recipient_id=$2 AND i.status='accepted'))))`,
      [adventureId, requesterId, visibility],
    )
  ).rows[0];
  if (!row) return [];
  const snapshot = row.snapshot;
  return translationProjection(
    '/adventures/metadata',
    {
      id: row.id,
      visibility: row.visibility,
      status: 'published',
      title: snapshot.title,
      synopsis: snapshot.synopsis,
      sourceLanguage: snapshot.sourceLanguage ?? 'ru',
      sourceRevision: snapshot.sourceRevision ?? 1,
      translations: snapshot.translations ?? {},
    },
    locale,
    requesterId,
  ).fields.filter(isMetadataField);
}

export class PlatformMetadataTranslations {
  private timer?: ReturnType<typeof setInterval>;
  private running = 0;
  private stopped = false;
  constructor(
    private readonly db: Pick<Db, 'query' | 'tx'>,
    private readonly provider?: AuthoringTextProvider,
    private readonly config?: ReleaseGenerationConfig,
    private readonly enabled: () => boolean = () => true,
    private readonly timeoutMs = 60000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000)
      throw new Error('INVALID_TRANSLATION_TIMEOUT');
  }
  onModuleInit() {
    if (!this.provider || !this.config) return;
    this.timer = setInterval(() => {
      for (let i = 0; i < 4; i++) void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  private canEnqueue() {
    return (
      !!this.provider &&
      !!this.config &&
      !this.stopped &&
      this.enabled() &&
      ownerPricingIsCurrent(this.config.text.pricing)
    );
  }
  /** Runs only after the existing authorized DTO projection. Storage failures never
   * block reading. HTTP waits for cache/admission only, never a model response. */
  async localize<T>(path: string, original: T, locale: Locale, viewerId: string | null) {
    const projection = translationProjection(path, original, locale, viewerId);
    const fields = projection.fields.filter(isMetadataField);
    if (!fields.length) return { value: original, pending: false };
    const allowed = new Set<string>();
    const rows: { key: string; status: string; translated_text: string | null }[] = [];
    for (const field of new Map(fields.map((item) => [item.scope.id, item])).values()) {
      const found = await this.db.tx(async (c) => {
        const current = await releasedFields(
          c,
          field.scope.id,
          viewerId,
          field.metadata.visibility,
          locale,
        );
        const keys = current.map((item) => metadataTranslationKey(item, locale));
        const cached = await c.query<{
          key: string;
          status: string;
          translated_text: string | null;
        }>(
          'SELECT key,status,translated_text FROM content_translations WHERE key=ANY($1::text[])',
          [keys],
        );
        return { keys, rows: cached.rows };
      });
      for (const key of found.keys) allowed.add(key);
      rows.push(...found.rows);
    }
    const unique = new Map(
      fields
        .map((field) => [metadataTranslationKey(field, locale), field])
        .filter(([key]) => allowed.has(key as string)) as [string, MetadataField][],
    );
    if (!unique.size) return { value: original, pending: false };
    const cached = new Map(rows.map((row) => [row.key, row]));
    let pending = this.canEnqueue() && rows.some((row) => row.status === 'pending');
    for (const field of fields) {
      if (!allowed.has(metadataTranslationKey(field, locale))) continue;
      const row = cached.get(metadataTranslationKey(field, locale));
      if (
        row?.status === 'ready' &&
        row.translated_text?.trim() &&
        row.translated_text.length <= field.maxLength
      )
        field.apply(row.translated_text);
    }
    if (this.canEnqueue()) {
      const groups = new Map<string, MetadataField[]>();
      for (const [key, field] of unique) {
        if (cached.has(key)) continue; // Failed/unknown never become automatic paid retries.
        const group = groups.get(field.scope.id) ?? [];
        group.push(field);
        groups.set(field.scope.id, group);
      }
      for (const group of groups.values())
        pending = (await this.enqueue(group, locale, viewerId).catch(() => false)) || pending;
    }
    return { value: projection.value, pending };
  }
  private async enqueue(fields: MetadataField[], locale: Locale, requesterId: string | null) {
    const config = this.config!,
      provider = this.provider!,
      first = fields[0];
    return this.db.tx(async (c) => {
      // Serialize only a story/language claim, across processes and readers.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `metadata:${first.scope.id}:${first.metadata.visibility}:${locale}`,
      ]);
      const current = await releasedFields(
        c,
        first.scope.id,
        requesterId,
        first.metadata.visibility,
        locale,
      );
      const currentKeys = new Set(current.map((field) => metadataTranslationKey(field, locale)));
      const candidates = fields.filter((field) =>
        currentKeys.has(metadataTranslationKey(field, locale)),
      );
      const claimed: MetadataField[] = [];
      for (const field of candidates) {
        const row = await c.query(
          `INSERT INTO content_translations(key,adventure_id,viewer_id,locale,version,status)
           VALUES($1,$2,NULL,$3,$4,'pending') ON CONFLICT DO NOTHING RETURNING key`,
          [
            metadataTranslationKey(field, locale),
            field.scope.id,
            locale,
            PLATFORM_METADATA_VERSION,
          ],
        );
        if (row.rowCount) claimed.push(field);
      }
      if (!claimed.length) {
        return !!(
          await c.query(
            "SELECT 1 FROM content_translations WHERE key=ANY($1::text[]) AND status='pending' LIMIT 1",
            [candidates.map((field) => metadataTranslationKey(field, locale))],
          )
        ).rowCount;
      }
      const id = randomUUID();
      const context = {
        targetLocale: locale,
        items: claimed.map((field) => ({
          id: metadataTranslationKey(field, locale),
          text: field.source,
          maxLength: field.maxLength,
        })),
      };
      const snapshot = provider.prepareTextRequest?.(context)?.snapshot;
      const upper = snapshot?.reserveMicros ?? config.text.upperMicros;
      const reservation = await reserveMetadataSpend(c, config, id, upper);
      await c.query(
        `INSERT INTO platform_metadata_translation_jobs(id,adventure_id,requester_id,visibility,locale,cache_keys,
         context,provider_version,config_fingerprint,request_snapshot,reservation_id,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
        [
          id,
          first.scope.id,
          requesterId,
          first.metadata.visibility,
          locale,
          context.items.map((item) => item.id),
          JSON.stringify(context),
          provider.version,
          config.configFingerprint,
          snapshot ? JSON.stringify(snapshot) : null,
          reservation,
        ],
      );
      return true;
    });
  }
  private async sourceMatches(c: Pick<PoolClient, 'query'>, job: MetadataJob) {
    if (!job.adventure_id || !job.context) return false;
    const current = await releasedFields(
      c,
      job.adventure_id,
      job.requester_id,
      job.visibility,
      job.locale,
    );
    const keys = new Set(current.map((field) => metadataTranslationKey(field, job.locale)));
    return (
      job.context.items.length === job.cache_keys.length &&
      job.context.items.every((item) => keys.has(item.id) && job.cache_keys.includes(item.id))
    );
  }
  private async cancelQueued(c: PoolClient, job: MetadataJob) {
    // The durable dispatch transition has not occurred, so release is proven safe.
    await c.query(
      "UPDATE generation_budget_reservations SET status='released' WHERE id=$1 AND status='held'",
      [job.reservation_id],
    );
    await c.query(
      "DELETE FROM content_translations WHERE key=ANY($1::text[]) AND status='pending'",
      [job.cache_keys],
    );
    await c.query(
      "UPDATE platform_metadata_translation_jobs SET status='cancelled',context=NULL,completed_at=now() WHERE id=$1",
      [job.id],
    );
  }
  /** One local worker at a time; SKIP LOCKED plus persisted dispatch prevents a
   * second replica/restart from repeating a provider request. */
  async tick() {
    if (this.running >= 4 || this.stopped || !this.provider || !this.config) return;
    this.running++;
    try {
      const received = await this.db.query<MetadataJob>(
        "SELECT * FROM platform_metadata_translation_jobs WHERE status='result_received' ORDER BY created_at LIMIT 1",
      );
      if (received[0]) {
        await this.finish(received[0].id);
        return;
      }
      await this.db.tx(async (c) => {
        const expired = (
          await c.query<MetadataJob>(
            "UPDATE platform_metadata_translation_jobs SET status='unknown',error_code='PROVIDER_OUTCOME_UNKNOWN' WHERE status='dispatched' AND deadline_at<=now() RETURNING *",
          )
        ).rows;
        for (const job of expired)
          await c.query(
            "UPDATE content_translations SET status='failed',completed_at=now() WHERE key=ANY($1::text[]) AND status='pending'",
            [job.cache_keys],
          );
      });
      if (!this.canEnqueue()) return;
      const job = await this.db.tx(async (c) => {
        // Scope -> shared admission fence -> job is also the completion lock order.
        await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
          METADATA_BUDGET_SCOPE,
        ]);
        await fenceGenerationAdmission(c);
        const row = (
          await c.query<MetadataJob>(
            "SELECT * FROM platform_metadata_translation_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
          )
        ).rows[0];
        if (!row) return;
        const scope = (
          await c.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [
            METADATA_BUDGET_SCOPE,
          ])
        ).rows[0];
        await currentReleaseDeployment(c, this.config!);
        if (
          !this.canEnqueue() ||
          scope?.blocked ||
          row.provider_version !== this.provider!.version ||
          row.config_fingerprint !== this.config!.configFingerprint ||
          !(await this.sourceMatches(c, row))
        ) {
          await this.cancelQueued(c, row);
          return;
        }
        const prepared = this.provider!.prepareTextRequest?.(row.context, row.request_snapshot);
        if (digest(prepared?.snapshot ?? null) !== digest(row.request_snapshot ?? null)) {
          await this.cancelQueued(c, row);
          return;
        }
        await c.query(
          "UPDATE platform_metadata_translation_jobs SET status='dispatched',deadline_at=now()+($2::int*interval '1 millisecond') WHERE id=$1",
          [row.id, this.timeoutMs],
        );
        return row;
      });
      if (!job) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const result = await this.provider.generate({
          jobId: job.id,
          context: job.context,
          signal: controller.signal,
          ...(job.request_snapshot ? { textReservationSnapshot: job.request_snapshot } : {}),
          maxCostMicros: job.request_snapshot?.reserveMicros ?? this.config.text.upperMicros,
        });
        let checked: Map<string, string> | undefined;
        try {
          if (!result.failureCode)
            checked = validateTranslations(result.proposal, job.context!.items);
        } catch {
          /* known usage, invalid text */
        }
        await this.saveReceipt(
          job.id,
          result.usage,
          checked ? Object.fromEntries(checked) : null,
          result.requestId,
          checked ? null : 'TRANSLATION_INVALID_RESULT',
        );
      } catch (error) {
        if (error instanceof ProviderFailure && !error.uncertain)
          await this.saveReceipt(
            job.id,
            { inputTokens: 0, outputTokens: 0, costMicros: 0, costEvidence: 'reported' },
            null,
            null,
            'TRANSLATION_NOT_DISPATCHED',
          );
        else {
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE platform_metadata_translation_jobs SET status='unknown',error_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1 AND status='dispatched'",
              [job.id],
            );
            await c.query(
              "UPDATE content_translations SET status='failed',completed_at=now() WHERE key=ANY($1::text[]) AND status='pending'",
              [job.cache_keys],
            );
          });
        }
      } finally {
        clearTimeout(timeout);
      }
      await this.finish(job.id);
    } finally {
      this.running--;
    }
  }
  private async saveReceipt(
    id: string,
    usage: AuthoringTextResult['usage'],
    result: unknown,
    requestId: string | null,
    error: string | null,
  ) {
    await this.db.query(
      `UPDATE platform_metadata_translation_jobs SET status='result_received',provider_usage=$2,result=CASE WHEN context IS NULL THEN NULL ELSE $3::jsonb END,
       provider_request_id=$4,error_code=$5 WHERE id=$1 AND status IN ('dispatched','unknown')`,
      [id, JSON.stringify(usage), result ? JSON.stringify(result) : null, requestId, error],
    );
  }
  private async finish(id: string) {
    await this.db.tx(async (c) => {
      await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
        METADATA_BUDGET_SCOPE,
      ]);
      await fenceGenerationAdmission(c);
      const job = (
        await c.query<MetadataJob>(
          'SELECT * FROM platform_metadata_translation_jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!job || job.status !== 'result_received' || !job.provider_usage) return;
      await settleGenerationSpend(c, job.reservation_id, job.provider_usage.costMicros);
      const current =
        job.adventure_id && job.context && job.result && !job.error_code
          ? await releasedFields(c, job.adventure_id, job.requester_id, job.visibility, job.locale)
          : [];
      const validKeys = new Set(current.map((field) => metadataTranslationKey(field, job.locale)));
      const output = job.result as Record<string, string> | null;
      let ready = false;
      for (const key of job.cache_keys) {
        if (validKeys.has(key) && output?.[key]) {
          ready = true;
          await c.query(
            "UPDATE content_translations SET status='ready',translated_text=$2,completed_at=now() WHERE key=$1 AND status IN ('pending','failed')",
            [key, output[key]],
          );
        } else
          await c.query(
            "UPDATE content_translations SET status='failed',completed_at=now() WHERE key=$1 AND status='pending'",
            [key],
          );
      }
      await c.query(
        'UPDATE platform_metadata_translation_jobs SET status=$2,context=NULL,result=NULL,completed_at=now() WHERE id=$1',
        [id, ready ? 'ready' : 'failed'],
      );
    });
  }
}
