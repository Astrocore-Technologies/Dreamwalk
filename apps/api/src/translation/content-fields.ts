import type { Locale } from '@dreamwalk/contracts';
import { digest } from '../ai/context';
import type { ContentTranslationBundle, ContentTranslationField } from './content-types';

export const CONTENT_TRANSLATION_VERSION = 'released-content-v1';
export interface ContentTranslationUnit {
  key: string;
  text: string;
  maxLength: number;
  separator: string;
  prefix: string;
}
/** Partition long prose at a sentence/word boundary so the existing reviewed
 * provider's output envelope is respected without truncating the source field.
 * Separators are retained locally, not entrusted to a model that trims output. */
function pieces(text: string) {
  const result: { text: string; separator: string; prefix: string }[] = [];
  const prefix = /^\s*/u.exec(text)![0];
  let remaining = text.slice(prefix.length);
  while (remaining.length > 1200) {
    const window = remaining.slice(0, 1201);
    const boundaries = [...window.matchAll(/[.!?。！？][\s]+|\n+/gu)];
    let boundary = boundaries.filter((m) => m.index! >= 400).at(-1);
    if (!boundary) boundary = [...window.matchAll(/\s+/gu)].filter((m) => m.index! >= 400).at(-1);
    let at = boundary?.index ?? 1200;
    if (boundary && /[.!?。！？]/u.test(boundary[0][0])) at++;
    // Do not bisect a UTF-16 surrogate pair when a source has no whitespace.
    if (at > 0 && /[\uD800-\uDBFF]/u.test(remaining[at - 1])) at--;
    const part = remaining.slice(0, at);
    const tail = remaining.slice(at);
    const separator = /^\s*/u.exec(tail)![0];
    result.push({ text: part, separator, prefix: result.length ? '' : prefix });
    remaining = tail.slice(separator.length);
  }
  if (remaining)
    result.push({
      text: remaining.trimEnd(),
      separator: remaining.slice(remaining.trimEnd().length),
      prefix: result.length ? '' : prefix,
    });
  return result;
}
export function contentFieldDigest(field: ContentTranslationField) {
  return digest([field.text, field.maxLength, field.sourceLocale ?? null]);
}
export function contentTranslationUnits(
  bundle: ContentTranslationBundle,
  field: ContentTranslationField,
  locale: Locale,
): ContentTranslationUnit[] {
  if (!field.text.trim() || field.sourceLocale === locale || field.curated?.[locale]?.trim())
    return [];
  if (!Number.isSafeInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 12000)
    throw new Error('CONTENT_TRANSLATION_FIELD_LIMIT_INVALID');
  const sourceDigest = contentFieldDigest(field);
  const parts = pieces(field.text);
  const separators = parts.reduce(
    (sum, part) => sum + part.separator.length + part.prefix.length,
    0,
  );
  const sourceLength = parts.reduce((sum, part) => sum + part.text.length, 0);
  const available = field.maxLength - separators;
  if (available < sourceLength) throw new Error('CONTENT_TRANSLATION_SOURCE_LIMIT_INVALID');
  let allocated = 0;
  return parts.map((piece, index) => {
    const allowance =
      index === parts.length - 1
        ? available - allocated
        : Math.floor((available * piece.text.length) / sourceLength);
    allocated += allowance;
    return {
      ...piece,
      maxLength: Math.min(allowance, 6000),
      key: digest([
        CONTENT_TRANSLATION_VERSION,
        field.artifactIdentity ?? [bundle.source.kind, bundle.source.id, field.path],
        field.cachePartition ?? bundle.partition,
        sourceDigest,
        locale,
        index,
      ]),
    };
  });
}
export function assembleContentTranslation(
  units: ContentTranslationUnit[],
  rows: ReadonlyMap<string, { status: string; translated_text: string | null }>,
  maxLength: number,
) {
  if (!units.length) return undefined;
  const translated: string[] = [];
  for (const unit of units) {
    const row = rows.get(unit.key);
    if (row?.status !== 'ready' || !row.translated_text?.trim()) return undefined;
    translated.push(unit.prefix, row.translated_text, unit.separator);
  }
  const value = translated.join('');
  return value.length <= maxLength ? value : undefined;
}
