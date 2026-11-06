import type { Locale } from '@dreamwalk/contracts';
import type { PoolClient } from 'pg';

export const CONTENT_TRANSLATION_LOCALES: readonly Locale[] = ['ru', 'uk', 'en'];
/** No mutable drafts, NPC templates, campaign messages or runtime generated prose. */
export type ContentSourceKind = 'adventure' | 'taxonomy' | 'playable';
export interface ContentSourceRef {
  kind: ContentSourceKind;
  id: string;
}
/** System access is only for the platform-funded creation/change worker. It is
 * never inferred from an absent viewer, URL parameter, or a client-supplied DTO. */
export type ContentSourceAccess =
  { kind: 'system' } | { kind: 'viewer'; userId: string | null; campaignId?: string };

export interface ContentTranslationField {
  /** Stable semantic path, using released entity IDs instead of array positions. */
  path: string;
  text: string;
  maxLength: number;
  sourceLocale?: Locale;
  /** Current, source-validated human translations always take precedence. */
  curated?: Partial<Record<Locale, string>>;
  /** Optional proven shared artifact compartment from authoritative load only.
   * Read projections cannot select it. Public and private releases remain separate
   * even when their text is identical. Never derive this from text alone. */
  cachePartition?: string;
  /** Optional proven immutable origin shared by multiple presentation surfaces.
   * Authoritative load only: e.g. a story title in its catalog and playable package.
   * Must bind source identity and field role, never merely equal text. The worker
   * additionally binds exact text, locale, length and disclosure compartment. */
  artifactIdentity?: string;
}
export interface ContentTranslationBundle {
  source: ContentSourceRef;
  /** Exact disclosure compartment. Never a general revision or the target locale.
   * Examples: public-release, private-release, viewer:<actor ID>. */
  partition: string;
  /** Access/lifetime authority, not a content or campaign-state revision. Queued
   * jobs cannot cross a revocation/rejoin/erasure boundary. Field digests separately
   * revalidate source content, so unchanged fields remain reusable after edits. */
  authority: string;
  /** Owners, authors and audience users whose erasure must remove derived prose. */
  erasureUserIds: string[];
  fields: ContentTranslationField[];
}
export interface ContentTranslationReadField extends ContentTranslationField {
  source: ContentSourceRef;
  partition: string;
  /** Read authorization context only, never an artifact identity or provider input. */
  campaignId?: string;
  /** Mutates only a cloned presentation DTO or its explicit read-only overlay.
   * Never replace source editor values, canon, receipts, proposals or hashes. */
  apply: (translated: string) => void;
}
export interface ContentTranslationProjection<T = unknown> {
  value: T;
  fields: ContentTranslationReadField[];
}
export interface ReadyContentTranslation {
  source: ContentSourceRef;
  partition: string;
  path: string;
  sourceText: string;
  text: string;
  translationKey: string;
}
export interface ContentTranslationAdapter {
  kind: ContentSourceKind;
  /** Re-read authoritative rows and acquire source/user/access SHARE NOWAIT locks
   * retained through the caller's transaction. Return only live, currently
   * admitted compartments. Viewer access may never receive system-only fields.
   * Return [] for tombstones or revoked/inactive sources, never cached authority. */
  load(
    c: Pick<PoolClient, 'query'>,
    source: ContentSourceRef,
    access: ContentSourceAccess,
  ): Promise<ContentTranslationBundle[]>;
  /** Explicit paths only, after normal controller authorization/projection. No
   * recursive translation of arbitrary strings, identifiers or hidden state. */
  project<T>(
    path: string,
    original: T,
    locale: Locale,
    viewerId: string | null,
  ): ContentTranslationProjection<T>;
}
