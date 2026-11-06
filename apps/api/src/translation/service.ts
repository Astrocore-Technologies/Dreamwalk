import { createHash } from 'node:crypto';
import type { Locale } from '@dreamwalk/contracts';
import type { Db } from '../db';
import { TRANSLATION_VERSION, validateTranslations } from './definition';
import { translationProjection, type TranslationScope, type VisibleText } from './projection';
import type { PlatformMetadataTranslations } from './platform-metadata';

export interface TranslationInput {
  id: string;
  text: string;
  maxLength: number;
}
export interface TranslationRequest {
  scope: TranslationScope;
  targetLocale: Locale;
  items: TranslationInput[];
  signal: AbortSignal;
}
/** The generic/gameplay pipeline remains cache-only in production. The separately
 * authorized platform metadata service owns its durable budget and source/ACL checks.
 * Only local synthetic dispatchers are accepted by this generic interface.
 */
export interface SyntheticTranslationDispatcher {
  readonly external: false;
  translate(request: TranslationRequest): Promise<unknown>;
}
export interface CachedText {
  key: string;
  translated_text: string | null;
  status: string;
}
export interface TranslationCache {
  read(keys: string[]): Promise<CachedText[]>;
  claim(scope: TranslationScope, locale: Locale, items: TranslationInput[]): Promise<string[]>;
  complete(values: Map<string, string>): Promise<void>;
  fail(keys: string[]): Promise<void>;
}
export class PostgresTranslationCache implements TranslationCache {
  constructor(private readonly db: Pick<Db, 'query' | 'tx'>) {}
  read(keys: string[]) {
    return this.db.query<CachedText>(
      'SELECT key,translated_text,status FROM content_translations WHERE key=ANY($1::text[])',
      [keys],
    );
  }
  async claim(scope: TranslationScope, locale: Locale, items: TranslationInput[]) {
    const rows = await this.db.query<{ key: string }>(
      `INSERT INTO content_translations(key,adventure_id,campaign_id,viewer_id,locale,version,status)
       SELECT key,$2,$3,$4,$5,$6,'pending' FROM unnest($1::text[]) AS key
       ON CONFLICT(key) DO NOTHING RETURNING key`,
      [
        items.map((item) => item.id),
        scope.kind === 'adventure' ? scope.id : null,
        scope.kind === 'campaign' ? scope.id : null,
        scope.viewerId,
        locale,
        TRANSLATION_VERSION,
      ],
    );
    return rows.map((row) => row.key);
  }
  async complete(values: Map<string, string>) {
    await this.db.tx(async (client) => {
      for (const [key, text] of values)
        await client.query(
          "UPDATE content_translations SET status='ready',translated_text=$2,completed_at=now() WHERE key=$1 AND status='pending'",
          [key, text],
        );
    });
  }
  async fail(keys: string[]) {
    await this.db.query(
      "UPDATE content_translations SET status='failed',completed_at=now() WHERE key=ANY($1::text[]) AND status='pending'",
      [keys],
    );
  }
}
export function translationKey(field: VisibleText, locale: Locale) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        TRANSLATION_VERSION,
        field.scope.kind,
        field.scope.id,
        field.scope.viewerId,
        locale,
        field.revision,
        field.maxLength,
        field.source,
      ]),
    )
    .digest('hex');
}
export class CachedTranslations {
  constructor(
    private readonly cache: TranslationCache,
    private readonly dispatcher?: SyntheticTranslationDispatcher,
    private readonly timeoutMs = 2000,
    private readonly metadata?: PlatformMetadataTranslations,
  ) {
    // An inherited key cannot enable paid gameplay translation through this interface.
    if (dispatcher && dispatcher.external !== false)
      throw new Error('TRANSLATION_PAYMENT_POLICY_REQUIRED');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw new Error('INVALID_TRANSLATION_TIMEOUT');
  }
  async localize<T>(
    path: string,
    original: T,
    locale: Locale,
    viewerId: string | null,
    onPending?: () => void,
  ): Promise<T> {
    if (this.metadata) {
      try {
        const localized = await this.metadata.localize(path, original, locale, viewerId);
        original = localized.value;
        if (localized.pending) onPending?.();
      } catch {
        /* Cache/queue failure cannot block ordinary reads. */
      }
    }
    const { value, fields } = translationProjection(path, original, locale, viewerId);
    if (!fields.length) return original;
    // Bound work before touching storage. Never recursively traverse arbitrary DTOs.
    const selected = fields.slice(0, 512);
    const unique = new Map(selected.map((field) => [translationKey(field, locale), field]));
    let rows: CachedText[];
    try {
      rows = await this.cache.read([...unique.keys()]);
    } catch {
      return original;
    } // Translation outages cannot block a story or gameplay.
    const existing = new Map(rows.map((row) => [row.key, row]));
    const translated = new Map<string, string>();
    for (const [key, field] of unique) {
      const row = existing.get(key);
      if (
        row?.status === 'ready' &&
        row.translated_text?.trim() &&
        row.translated_text.length <= field.maxLength
      )
        translated.set(key, row.translated_text);
    }
    if (this.dispatcher) {
      const groups = new Map<string, { scope: TranslationScope; items: TranslationInput[] }>();
      for (const [id, field] of unique) {
        // Pending/failed attempts never become an automatic paid retry after a crash.
        if (existing.has(id)) continue;
        const scopeKey = JSON.stringify(field.scope);
        const group = groups.get(scopeKey) ?? { scope: field.scope, items: [] };
        group.items.push({ id, text: field.source, maxLength: field.maxLength });
        groups.set(scopeKey, group);
      }
      // One bounded batch per read. Later reads may fill the remaining cache.
      const group = groups.values().next().value;
      if (group) {
        const batch: TranslationInput[] = [];
        let bytes = 0;
        for (const item of group.items.slice(0, 64)) {
          const size = Buffer.byteLength(JSON.stringify(item));
          if (bytes + size > 24000) continue;
          bytes += size;
          batch.push(item);
        }
        if (batch.length) {
          let claimed: string[] = [];
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            claimed = await this.cache.claim(group.scope, locale, batch);
            const input = batch.filter((item) => claimed.includes(item.id));
            if (input.length) {
              const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error('TRANSLATION_TIMEOUT'));
                }, this.timeoutMs);
              });
              const proposal = await Promise.race([
                this.dispatcher.translate({
                  scope: group.scope,
                  targetLocale: locale,
                  items: input,
                  signal: controller.signal,
                }),
                timeout,
              ]);
              const checked = validateTranslations(proposal, input);
              await this.cache.complete(checked);
              checked.forEach((text, key) => translated.set(key, text));
            }
          } catch {
            // No request/source/provider error text is logged or returned.
            if (claimed.length) await this.cache.fail(claimed).catch(() => {});
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
    }
    for (const field of selected) {
      const text = translated.get(translationKey(field, locale));
      if (text) field.apply(text);
    }
    return value;
  }
}
