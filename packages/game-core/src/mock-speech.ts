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

/** Deterministic fixture wording, not a measured model-quality result. It never
 * quotes private examples, asserts a new fact, promises an action or speaks for a player. */
export function mockCharacterAcknowledgement(
  locale: Locale,
  performance: { stance: string; register: string; humor: string; cadence: string },
): string {
  const variants = {
    reserved: {
      en: 'I heard you. I will consider it.',
      ru: 'Просьба понятна. Нужно это обдумать.',
      uk: 'Прохання зрозуміле. Потрібно це обміркувати.',
    },
    friendly: {
      en: 'I am listening. Tell me what matters to you.',
      ru: 'Я слушаю. Расскажи, что для тебя важно.',
      uk: 'Я слухаю. Розкажи, що для тебе важливо.',
    },
    firm: {
      en: 'I heard the request. That is not a promise.',
      ru: 'Просьба понятна. Но это ещё не обещание.',
      uk: 'Прохання зрозуміле. Але це ще не обіцянка.',
    },
    guarded: {
      en: 'I am listening, but I remain cautious.',
      ru: 'Я слушаю, но сохраняю осторожность.',
      uk: 'Я слухаю, але зберігаю обережність.',
    },
  } as const;
  const stance =
    performance.stance in variants ? (performance.stance as keyof typeof variants) : 'reserved';
  if (performance.cadence === 'brief') return variants[stance][locale].split('. ')[0] + '.';
  return variants[stance][locale];
}

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
