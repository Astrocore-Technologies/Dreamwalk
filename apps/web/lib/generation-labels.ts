import type { Locale } from './locales';

/** Display labels only. Keep provider parameters and task identifiers unchanged on the wire. */
const qualityLabels = {
  low: ['Низкое качество', 'Low quality', 'Низька якість'],
  medium: ['Среднее качество', 'Medium quality', 'Середня якість'],
  high: ['Высокое качество', 'High quality', 'Висока якість'],
  auto: ['Автоматическое качество', 'Automatic quality', 'Автоматична якість'],
} as const;
const purposeLabels = {
  supporting_npc: ['Новый второстепенный NPC', 'New supporting NPC', 'Новий другорядний NPC'],
  plan: ['Решение NPC', 'NPC decision', 'Рішення NPC'],
  summary: ['Сводка памяти NPC', 'NPC memory summary', 'Підсумок пам’яті NPC'],
  speech: ['Реплика NPC', 'NPC reply', 'Репліка NPC'],
  intent: ['Разбор действия', 'Action interpretation', 'Розбір дії'],
  narrative: ['Продолжение истории', 'Story continuation', 'Продовження історії'],
  story_turn: ['Ход истории', 'Story turn', 'Хід історії'],
  story_plan: ['Игровой план истории', 'Playable story plan', 'Ігровий план історії'],
} as const;
const column = (locale: Locale) => (locale === 'ru' ? 0 : locale === 'uk' ? 2 : 1);
export function imageQualityLabel(locale: Locale, value: string): string {
  // Unknown provider-specific parameters remain exact diagnostic identifiers.
  return Object.hasOwn(qualityLabels, value)
    ? qualityLabels[value as keyof typeof qualityLabels][column(locale)]
    : value;
}
export function imageSizeLabel(locale: Locale, value: string): string {
  return value === 'auto'
    ? ['Автоматический размер', 'Automatic size', 'Автоматичний розмір'][column(locale)]
    : value;
}
export function requestPurposeLabel(locale: Locale, value: string): string {
  return Object.hasOwn(purposeLabels, value)
    ? purposeLabels[value as keyof typeof purposeLabels][column(locale)]
    : ['Задача ИИ', 'AI task', 'Завдання ШІ'][column(locale)];
}
