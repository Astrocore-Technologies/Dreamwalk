/** Editable prose, not a parser format or instructions that override world rules. */
export const npcAuthoringTemplates = {
  personality: {
    label: ['Характер', 'Personality', 'Характер'],
    text: [
      'Обычно сдержан, но становится настойчивым, когда нужно защитить близких.',
      'Usually reserved, but becomes assertive when protecting loved ones.',
      'Зазвичай стриманий, але стає наполегливим, коли треба захистити близьких.',
    ],
  },
  motivation: {
    label: ['Мотив', 'Motive', 'Мотив'],
    text: [
      'Хочет заслужить доверие общины. Боится снова подвести тех, кто на него рассчитывает.',
      'Wants to earn the community’s trust. Fears letting down those who rely on them again.',
      'Хоче заслужити довіру громади. Боїться знову підвести тих, хто на нього розраховує.',
    ],
  },
  reaction: {
    label: ['Реакция', 'Reaction', 'Реакція'],
    text: [
      'На угрозу сначала отвечает предупреждением. На искреннюю просьбу предлагает посильную помощь.',
      'Responds to threats with a warning first. Offers practical help when asked sincerely.',
      'На загрозу спочатку відповідає попередженням. На щире прохання пропонує посильну допомогу.',
    ],
  },
  speech: {
    label: ['Манера речи', 'Speech style', 'Манера мовлення'],
    text: [
      'Говорит короткими спокойными фразами, без вычурных слов. В тревоге задаёт уточняющие вопросы.',
      'Uses short, calm sentences and simple words. Asks clarifying questions when worried.',
      'Говорить короткими спокійними фразами, без пишних слів. У тривозі ставить уточнювальні запитання.',
    ],
  },
  example: {
    label: ['Пример', 'Example', 'Приклад'],
    text: [
      '«Давай не спешить. Расскажи, что случилось».',
      '“Let’s take our time. Tell me what happened.”',
      '«Не поспішаймо. Розкажи, що сталося».',
    ],
  },
} as const;
export type NpcTemplateKey = keyof typeof npcAuthoringTemplates;
export type AuthoringLocale = 'ru' | 'en' | 'uk';
export const templateCopy = {
  hint: [
    'Вставьте пример и измените под своего персонажа.',
    'Insert an example and adapt it to your character.',
    'Вставте приклад і змініть під свого персонажа.',
  ],
  insert: ['Вставить', 'Insert', 'Вставити'],
  full: [
    'Недостаточно места для примера. Сократите текст или напишите свой.',
    'Not enough room for this example. Shorten the text or write your own.',
    'Недостатньо місця для прикладу. Скоротіть текст або напишіть власний.',
  ],
} as const;
export function authoringText(locale: AuthoringLocale, values: readonly [string, string, string]) {
  return values[locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
/** Never replace a selection or silently truncate the author's text. */
export function insertNpcTemplate(value: string, snippet: string, cursor: number, limit: number) {
  const at = Math.max(0, Math.min(value.length, cursor));
  const before = value.slice(0, at);
  const after = value.slice(at);
  const inserted = `${before && !/\s$/.test(before) ? '\n' : ''}${snippet}${after && !/^\s/.test(after) ? '\n' : ''}`;
  const next = before + inserted + after;
  return next.length > limit ? null : { value: next, cursor: at + inserted.length };
}
