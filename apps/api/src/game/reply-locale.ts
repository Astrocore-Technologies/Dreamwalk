import { localeSchema, type Locale } from '@dreamwalk/contracts';
import type { Request } from 'express';

/** Output preference, never the authored source language or an authorization input. */
export function resolveReplyLocale(
  req: Pick<Request, 'headers'>,
  explicit?: unknown,
  accountLocale?: unknown,
): Locale {
  const selected = localeSchema.safeParse(explicit);
  if (selected.success) return selected.data;
  const accepted = (req.headers['accept-language'] ?? '')
    .slice(0, 512)
    .split(',')
    .slice(0, 20)
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const weight = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const quality = weight ? Number(weight.trim().slice(2)) : 1;
      const locale = localeSchema.safeParse(tag.toLowerCase().split('-')[0]);
      return { locale, quality, index };
    })
    .filter(({ locale, quality }) => locale.success && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)[0];
  if (accepted?.locale.success) return accepted.locale.data;
  const account = localeSchema.safeParse(accountLocale);
  return account.success ? account.data : 'en';
}
