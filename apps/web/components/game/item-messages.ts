'use client';
import { useT } from '@/lib/i18n';
export const itemMessages = {
  locationMap: ['Карта локации', 'Location map', 'Карта локації'],
  sceneParticipants: ['В этой сцене', 'In this scene', 'У цій сцені'],
  sceneParticipant: ['Участник сцены', 'Scene participant', 'Учасник сцени'],
  inventory: ['Инвентарь', 'Inventory', 'Інвентар'],
  empty: ['Инвентарь пуст', 'Your inventory is empty', 'Інвентар порожній'],
  close: ['Закрыть', 'Close', 'Закрити'],
  eat: ['Поесть', 'Eat', 'Поїсти'],
  take: ['Взять', 'Take', 'Взяти'],
  say: ['Сказать', 'Say', 'Сказати'],
  inspect: ['Осмотреть', 'Inspect', 'Оглянути'],
  approach: ['Подойти', 'Approach', 'Підійти'],
  push: ['Толкнуть', 'Push', 'Штовхнути'],
  hit: ['Ударить', 'Hit', 'Вдарити'],
  open: ['Открыть', 'Open', 'Відкрити'],
  shut: ['Закрыть дверь', 'Close door', 'Зачинити двері'],
  unlock: ['Отпереть', 'Unlock', 'Відімкнути'],
  transition: ['Перейти', 'Enter', 'Перейти'],
  knock: ['Постучать', 'Knock', 'Постукати'],
  help: [
    'ПКМ по персонажу или предмету — действия. На сенсорном экране коснись предмета или персонажа.',
    'Right-click a character or item for actions. On touch screens, tap the item or character.',
    'ПКМ по персонажу або предмету — дії. На сенсорному екрані торкнися предмета чи персонажа.',
  ],
  unavailable: ['Сейчас недоступно', 'Currently unavailable', 'Зараз недоступно'],
  actions: ['Действия', 'Actions', 'Дії'],
} as const;
export function useItemText() {
  const { locale } = useT();
  return (key: keyof typeof itemMessages) =>
    itemMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
