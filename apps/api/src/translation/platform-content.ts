import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Locale } from '@dreamwalk/contracts';
import type { Db } from '../db';
import { digest } from '../ai/context';
import { ProviderFailure } from '../ai/types';
import { ownerPricingIsCurrent, type ReleaseGenerationConfig } from '../generation/config';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import { currentReleaseDeployment } from '../generation/release-deployment';
import { settleGenerationSpend } from '../image-generation/budget';
import type { AuthoringTextProvider, AuthoringTextResult } from '../live-test/authoring-provider';
import { validateTranslations } from './definition';
import {
  METADATA_BUDGET_SCOPE,
  lockMetadataSpendScope,
  reserveMetadataSpend,
} from './metadata-budget';
import {
  CONTENT_TRANSLATION_LOCALES,
  type ContentSourceRef,
  type ContentTranslationAdapter,
  type ReadyContentTranslation,
} from './content-types';
import {
  assembleContentTranslation,
  contentFieldDigest,
  contentTranslationUnits,
} from './content-fields';

type Client = Pick<PoolClient, 'query'>;
interface CacheRow extends QueryResultRow {
  key: string;
  status: string;
  translated_text: string | null;
}
interface ContentJob extends QueryResultRow {
  id: string;
  source_kind: ContentSourceRef['kind'];
  source_id: string;
  partition: string;
  authority: string;
  field_path: string;
  locale: Locale;
  cache_key: string;
  context: {
    targetLocale: Locale;
    items: { id: string; text: string; maxLength: number }[];
  } | null;
  provider_version: string;
  config_fingerprint: string;
  reservation_id: string;
  status: string;
  request_snapshot: Parameters<AuthoringTextProvider['generate']>[0]['textReservationSnapshot'];
  provider_usage: AuthoringTextResult['usage'] | null;
  result: Record<string, string> | null;
  error_code: string | null;
}

/** Creation/release-triggered durable work. Reads never authorize or dispatch a
 * provider call. Every loaded source is an explicitly released adapter; neither
 * draft/editor data nor gameplay messages have an adapter or an outbox trigger. */
export class PlatformContentTranslations {
  private timer?: ReturnType<typeof setInterval>;
  private running = 0;
  private reconciling = false;
  private stopped = false;
  private readonly adapters: Map<ContentSourceRef['kind'], ContentTranslationAdapter>;
  constructor(
    private readonly db: Pick<Db, 'query' | 'tx'>,
    adapters: ContentTranslationAdapter[],
    private readonly provider?: AuthoringTextProvider,
    private readonly config?: ReleaseGenerationConfig,
    private readonly enabled: () => boolean = () => true,
    private readonly timeoutMs = 60000,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    if (this.adapters.size !== adapters.length) throw new Error('DUPLICATE_TRANSLATION_ADAPTER');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000)
      throw new Error('INVALID_TRANSLATION_TIMEOUT');
  }
  onModuleInit() {
    if (!this.provider || !this.config) return;
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {});
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
  private load(c: Client, source: ContentSourceRef) {
    return (
      this.adapters.get(source.kind)?.load(c, source, { kind: 'system' }) ?? Promise.resolve([])
    );
  }
  /** A bounded admission window is scheduling, not a spending ceiling. The event
   * remains durable until every currently eligible field/language has been seen. */
  async reconcile() {
    if (this.reconciling || !this.canEnqueue()) return;
    this.reconciling = true;
    try {
      return await this.db.tx(async (c) => {
        // Same order as dispatch/cancellation: scope -> admission -> event/job ->
        // NOWAIT source locks. Never hold an event while waiting on its canceller.
        await lockMetadataSpendScope(c, this.config!);
        const event = (
          await c.query<{ source_kind: ContentSourceRef['kind']; source_id: string }>(
            `SELECT source_kind,source_id FROM platform_content_translation_events WHERE source_kind=ANY($1::text[])
           ORDER BY updated_at,source_kind,source_id FOR UPDATE SKIP LOCKED LIMIT 1`,
            [[...this.adapters.keys()]],
          )
        ).rows[0];
        if (!event || !this.adapters.has(event.source_kind)) return;
        const source = { kind: event.source_kind, id: event.source_id };
        const bundles = await this.load(c, source);
        const bindings: { partition: string; field_path: string; locale: Locale }[] = [];
        let admitted = 0;
        let remaining = false;
        for (const bundle of bundles)
          for (const field of bundle.fields) {
            for (const locale of CONTENT_TRANSLATION_LOCALES) {
              const units = contentTranslationUnits(bundle, field, locale);
              if (!units.length) continue;
              bindings.push({ partition: bundle.partition, field_path: field.path, locale });
              await c.query(
                `INSERT INTO platform_content_translation_bindings
               (source_kind,source_id,partition,field_path,locale,source_digest,cache_keys,erasure_user_ids)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(source_kind,source_id,partition,field_path,locale)
               DO UPDATE SET source_digest=EXCLUDED.source_digest,cache_keys=EXCLUDED.cache_keys,
                 erasure_user_ids=EXCLUDED.erasure_user_ids`,
                [
                  source.kind,
                  source.id,
                  bundle.partition,
                  field.path,
                  locale,
                  contentFieldDigest(field),
                  units.map((unit) => unit.key),
                  bundle.erasureUserIds,
                ],
              );
              const cached = new Set(
                (
                  await c.query<{ key: string }>(
                    'SELECT key FROM platform_content_translation_cache WHERE key=ANY($1::text[])',
                    [units.map((unit) => unit.key)],
                  )
                ).rows.map((row) => row.key),
              );
              for (const unit of units) {
                if (cached.has(unit.key)) continue; // Known failure/unknown never causes a paid retry.
                if (
                  (
                    await c.query(
                      "SELECT 1 FROM platform_content_translation_jobs WHERE cache_key=$1 AND status<>'cancelled'",
                      [unit.key],
                    )
                  ).rowCount
                )
                  continue; // Durable attempt barrier survives erasure/cache removal.
                if (admitted >= (this.config!.allowance === 'unlimited' ? 16 : 1)) {
                  remaining = true;
                  continue;
                }
                const id = randomUUID();
                const claim = await c.query(
                  `INSERT INTO platform_content_translation_cache(key,locale,status,erasure_user_ids,claim_job_id)
                 VALUES($1,$2,'pending',$3,$4) ON CONFLICT DO NOTHING RETURNING key`,
                  [unit.key, locale, bundle.erasureUserIds, id],
                );
                if (!claim.rowCount) continue;
                // One source fragment per request: hidden lore cannot contaminate
                // another public field through a shared model context.
                const context = {
                  targetLocale: locale,
                  items: [{ id: unit.key, text: unit.text, maxLength: unit.maxLength }],
                };
                const snapshot = this.provider!.prepareTextRequest?.(context)?.snapshot;
                const reservation = await reserveMetadataSpend(
                  c,
                  this.config!,
                  id,
                  snapshot?.reserveMicros ?? this.config!.text.upperMicros,
                );
                await c.query(
                  `INSERT INTO platform_content_translation_jobs
                 (id,source_kind,source_id,partition,authority,field_path,locale,cache_key,erasure_user_ids,
                  context,provider_version,config_fingerprint,request_snapshot,reservation_id,status)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued')`,
                  [
                    id,
                    source.kind,
                    source.id,
                    bundle.partition,
                    bundle.authority,
                    field.path,
                    locale,
                    unit.key,
                    bundle.erasureUserIds,
                    JSON.stringify(context),
                    this.provider!.version,
                    this.config!.configFingerprint,
                    snapshot ? JSON.stringify(snapshot) : null,
                    reservation,
                  ],
                );
                admitted++;
              }
            }
          }
        await c.query(
          `DELETE FROM platform_content_translation_bindings b WHERE source_kind=$1 AND source_id=$2
           AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS live(partition text,field_path text,locale text)
             WHERE live.partition=b.partition AND live.field_path=b.field_path AND live.locale=b.locale)`,
          [source.kind, source.id, JSON.stringify(bindings)],
        );
        // Retain exact-text artifacts and unknown-outcome barriers across normal
        // edits. A -> B -> A must never pay twice; erasure scrubs prose explicitly.
        if (remaining)
          await c.query(
            'UPDATE platform_content_translation_events SET updated_at=now() WHERE source_kind=$1 AND source_id=$2',
            [source.kind, source.id],
          );
        else
          await c.query(
            'DELETE FROM platform_content_translation_events WHERE source_kind=$1 AND source_id=$2',
            [source.kind, source.id],
          );
        return { admitted, remaining };
      });
    } finally {
      this.reconciling = false;
    }
  }
  /** ACL + cache read in one transaction. No synthetic DTO can select another
   * compartment, immutable origin, or source text: load supplies all key material. */
  async localize<T>(
    path: string,
    original: T,
    locale: Locale,
    viewerId: string | null,
    onReady?: (field: ReadyContentTranslation) => void,
  ) {
    let value = original;
    let pending = false;
    for (const adapter of this.adapters.values()) {
      const projected = adapter.project(path, value, locale, viewerId);
      value = projected.value;
      const groups = new Map<string, typeof projected.fields>();
      for (const field of projected.fields) {
        const id = JSON.stringify([field.source, field.campaignId ?? null]);
        const group = groups.get(id) ?? [];
        group.push(field);
        groups.set(id, group);
      }
      for (const group of groups.values()) {
        const changes = await this.db.tx(async (c) => {
          const first = group[0];
          const loaded = await adapter.load(c, first.source, {
            kind: 'viewer',
            userId: viewerId,
            ...(first.campaignId ? { campaignId: first.campaignId } : {}),
          });
          const updates: { index: number; text: string; translationKey: string }[] = [];
          let waiting = false;
          for (const [index, field] of group.entries()) {
            const bundle = loaded.find((item) => item.partition === field.partition);
            const current = bundle?.fields.find(
              (item) =>
                item.path === field.path &&
                item.text === field.text &&
                item.maxLength === field.maxLength,
            );
            if (!bundle || !current) continue;
            const curated = current.curated?.[locale];
            if (curated?.trim()) {
              updates.push({
                index,
                text: curated,
                translationKey: digest([
                  'curated-released-content-v1',
                  bundle.source,
                  bundle.partition,
                  current.path,
                  contentFieldDigest(current),
                  locale,
                  curated,
                ]),
              });
              continue;
            }
            const units = contentTranslationUnits(bundle, current, locale);
            if (!units.length) continue;
            const rows = (
              await c.query<CacheRow>(
                'SELECT key,status,translated_text FROM platform_content_translation_cache WHERE key=ANY($1::text[])',
                [units.map((unit) => unit.key)],
              )
            ).rows;
            const map = new Map(rows.map((row) => [row.key, row]));
            const translated = assembleContentTranslation(units, map, current.maxLength);
            if (translated)
              updates.push({
                index,
                text: translated,
                translationKey: digest(units.map((unit) => unit.key)),
              });
            else if (rows.some((row) => row.status === 'pending')) waiting = true;
            else if (rows.length < units.length && this.canEnqueue())
              waiting ||= !!(
                await c.query(
                  'SELECT 1 FROM platform_content_translation_events WHERE source_kind=$1 AND source_id=$2',
                  [first.source.kind, first.source.id],
                )
              ).rowCount;
          }
          return { updates, waiting };
        });
        for (const update of changes.updates) {
          const field = group[update.index];
          field.apply(update.text);
          onReady?.({
            source: field.source,
            partition: field.partition,
            path: field.path,
            sourceText: field.text,
            text: update.text,
            translationKey: update.translationKey,
          });
        }
        pending ||= this.canEnqueue() && changes.waiting;
      }
    }
    return { value, pending };
  }
  /** Server-only ready presentation evidence for immutable alias admission. This
   * method has no enqueue path; caller still binds actor/input/source label and
   * revalidates the original action's authority at atomic gameplay admission. */
  async readyFields(path: string, original: unknown, locale: Locale, viewerId: string | null) {
    const fields: ReadyContentTranslation[] = [];
    await this.localize(path, original, locale, viewerId, (field) => fields.push(field));
    return fields;
  }
  private async currentUnit(c: Client, job: ContentJob, allowSharedCompletion = false) {
    if (!job.context || job.context.items.length !== 1) return undefined;
    const dispatched = job.context.items[0];
    const bundles = await this.load(c, { kind: job.source_kind, id: job.source_id });
    const original = bundles.find(
      (item) => item.partition === job.partition && item.authority === job.authority,
    );
    // An alternate surface cannot revive a revoked/rejoined/erased authority.
    if (!original) return undefined;
    const exactUnit = (bundle: (typeof bundles)[number], path: string) => {
      const field = bundle.fields.find((item) => item.path === path);
      return (
        field &&
        contentTranslationUnits(bundle, field, job.locale).find(
          (unit) =>
            unit.key === job.cache_key &&
            dispatched.id === unit.key &&
            dispatched.text === unit.text &&
            dispatched.maxLength === unit.maxLength,
        )
      );
    };
    const direct = exactUnit(original, job.field_path);
    if (direct || !allowSharedCompletion) return direct;
    // An ordinary source edit may leave another released version/surface needing
    // the exact already-paid text. Bindings only locate candidates; fresh locked
    // source loads prove their current ACL and regenerate every piece of key data.
    const candidates = (
      await c.query<{
        source_kind: ContentSourceRef['kind'];
        source_id: string;
        partition: string;
        field_path: string;
      }>(
        `SELECT DISTINCT source_kind,source_id,partition,field_path
       FROM platform_content_translation_bindings WHERE locale=$1 AND $2=ANY(cache_keys)
       ORDER BY source_kind,source_id,partition,field_path`,
        [job.locale, job.cache_key],
      )
    ).rows;
    for (const candidate of candidates) {
      const loaded = await this.load(c, { kind: candidate.source_kind, id: candidate.source_id });
      const bundle = loaded.find((item) => item.partition === candidate.partition);
      const unit = bundle && exactUnit(bundle, candidate.field_path);
      if (unit) return unit;
    }
    return undefined;
  }
  private async cancelQueued(c: PoolClient, job: ContentJob) {
    await c.query(
      "UPDATE generation_budget_reservations SET status='released' WHERE id=$1 AND status='held'",
      [job.reservation_id],
    );
    // Wake every still-live presentation binding after a proven undispatched
    // cancellation, including another reader/source of the same immutable text.
    await c.query(
      `INSERT INTO platform_content_translation_events(source_kind,source_id)
       SELECT DISTINCT source_kind,source_id FROM platform_content_translation_bindings WHERE $1=ANY(cache_keys)
       ON CONFLICT(source_kind,source_id) DO UPDATE SET generation=platform_content_translation_events.generation+1,updated_at=now()`,
      [job.cache_key],
    );
    await c.query(
      "DELETE FROM platform_content_translation_cache WHERE key=$1 AND claim_job_id=$2 AND status='pending'",
      [job.cache_key, job.id],
    );
    await c.query(
      "UPDATE platform_content_translation_jobs SET status='cancelled',context=NULL,completed_at=now() WHERE id=$1",
      [job.id],
    );
  }
  async tick() {
    if (this.running >= 4 || this.stopped || !this.provider || !this.config) return;
    this.running++;
    try {
      const received = await this.db.query<ContentJob>(
        "SELECT * FROM platform_content_translation_jobs WHERE status='result_received' ORDER BY created_at LIMIT 1",
      );
      if (received[0]) {
        await this.finish(received[0].id);
        return;
      }
      await this.db.tx(async (c) => {
        const expired = (
          await c.query<ContentJob>(
            "UPDATE platform_content_translation_jobs SET status='unknown',error_code='PROVIDER_OUTCOME_UNKNOWN' WHERE status='dispatched' AND deadline_at<=now() RETURNING *",
          )
        ).rows;
        for (const job of expired)
          await c.query(
            "UPDATE platform_content_translation_cache SET status='failed',completed_at=now() WHERE key=$1 AND claim_job_id=$2 AND status='pending'",
            [job.cache_key, job.id],
          );
      });
      if (!this.canEnqueue()) return;
      const job = await this.db.tx(async (c) => {
        await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
          METADATA_BUDGET_SCOPE,
        ]);
        await fenceGenerationAdmission(c);
        const row = (
          await c.query<ContentJob>(
            "SELECT * FROM platform_content_translation_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
          )
        ).rows[0];
        if (!row) return;
        await currentReleaseDeployment(c, this.config!);
        const scope = (
          await c.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [
            METADATA_BUDGET_SCOPE,
          ])
        ).rows[0];
        const unit = await this.currentUnit(c, row);
        if (
          !this.canEnqueue() ||
          scope?.blocked ||
          !unit ||
          row.provider_version !== this.provider!.version ||
          row.config_fingerprint !== this.config!.configFingerprint ||
          row.context?.items.length !== 1 ||
          row.context.items[0].id !== unit.key ||
          row.context.items[0].text !== unit.text ||
          row.context.items[0].maxLength !== unit.maxLength
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
          "UPDATE platform_content_translation_jobs SET status='dispatched',deadline_at=now()+($2::int*interval '1 millisecond') WHERE id=$1",
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
          /* settle known usage, reject invalid output */
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
        else
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE platform_content_translation_jobs SET status='unknown',error_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1 AND status='dispatched'",
              [job.id],
            );
            await c.query(
              "UPDATE platform_content_translation_cache SET status='failed',completed_at=now() WHERE key=$1 AND claim_job_id=$2 AND status='pending'",
              [job.cache_key, job.id],
            );
          });
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
      `UPDATE platform_content_translation_jobs SET status='result_received',provider_usage=$2,
       result=CASE WHEN context IS NULL THEN NULL ELSE $3::jsonb END,provider_request_id=$4,error_code=$5
       WHERE id=$1 AND status IN ('dispatched','unknown')`,
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
        await c.query<ContentJob>(
          'SELECT * FROM platform_content_translation_jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!job || job.status !== 'result_received' || !job.provider_usage) return;
      await settleGenerationSpend(c, job.reservation_id, job.provider_usage.costMicros);
      const unit = job.result && !job.error_code ? await this.currentUnit(c, job, true) : undefined;
      const text = unit && job.result?.[job.cache_key];
      const ready = typeof text === 'string' && text.trim() && text.length <= unit!.maxLength;
      if (ready)
        await c.query(
          "UPDATE platform_content_translation_cache SET status='ready',translated_text=$2,completed_at=now() WHERE key=$1 AND claim_job_id=$3 AND status IN ('pending','failed')",
          [job.cache_key, text, job.id],
        );
      else
        await c.query(
          "UPDATE platform_content_translation_cache SET status='failed',completed_at=now() WHERE key=$1 AND claim_job_id=$2 AND status='pending'",
          [job.cache_key, job.id],
        );
      await c.query(
        'UPDATE platform_content_translation_jobs SET status=$2,context=NULL,result=NULL,completed_at=now() WHERE id=$1',
        [job.id, ready ? 'ready' : 'failed'],
      );
    });
  }
}
