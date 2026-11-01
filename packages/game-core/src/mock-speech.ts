import type { Locale } from '@dreamwalk/contracts';

/** Curated fixture copy only. This is not an automatic authored-content translator. */
const observatoryRoofHelp = {
  npcId: 'keeper',
  observationId: 'initial:keeper:fact:two-stairways',
  title: 'How do we reach the roof?',
  source:
    'The brass key on the floor opens the main stair door. Ask me for my service token and accept my offer to use the side stair door instead. The observation journal is on the roof.',
  replies: {
    en: 'The brass key on the floor opens the main stair door. Ask me for my service token and accept my offer to use the side stair door instead. The observation journal is on the roof.',
    uk: 'Латунний ключ на підлозі відчиняє двері головних сходів. Попросіть у мене службову перепустку й прийміть мою пропозицію, щоб скористатися бічними сходами. Журнал спостережень лежить на даху.',
    ru: 'Латунный ключ на полу открывает дверь главной лестницы. Попросите у меня служебный пропуск и примите моё предложение, чтобы воспользоваться боковой лестницей. Журнал наблюдений лежит на крыше.',
  },
} as const;

const originalSource = {
  uk: 'В авторському описі сказано (цитата мовою оригіналу):',
  en: 'The authored description says (quoted in its original language):',
  ru: 'В авторском описании сказано (цитата на языке оригинала):',
} as const;

export const mockAcknowledgement: Record<Locale, string> = {
  uk: 'Я вас чую. Продовжуйте, будь ласка.',
  en: 'I hear you. Please go on.',
  ru: 'Я вас слышу. Продолжайте, пожалуйста.',
};

export function mockFactReply(
  npcId: string,
  observationId: string,
  fact: { title: string; text: string },
  locale: Locale,
): string {
  if (
    npcId === observatoryRoofHelp.npcId &&
    observationId === observatoryRoofHelp.observationId &&
    fact.title === observatoryRoofHelp.title &&
    fact.text === observatoryRoofHelp.source
  )
    return observatoryRoofHelp.replies[locale];
  // Arbitrary author prose remains literal source evidence, not a fake translation.
  // Bound the reply separately from storage and mark any shortened quote with an ellipsis.
  const prefix = `${originalSource[locale]} «`,
    maxQuote = 1000 - prefix.length - 1;
  let quote = fact.text;
  if (quote.length > maxQuote) {
    quote = quote.slice(0, maxQuote - 1);
    // Do not split a supplementary Unicode character at the bounded excerpt edge.
    const last = quote.charCodeAt(quote.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) quote = quote.slice(0, -1);
    quote += '…';
  }
  return `${prefix}${quote}»`;
}
