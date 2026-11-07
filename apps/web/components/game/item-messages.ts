'use client';
import { useT } from '@/lib/i18n';
export const itemMessages = {
  recoveryTitle: [
    'Игра приостановлена: нужна клеточная карта',
    'Game paused: a verified grid is required',
    'Гру призупинено: потрібна клітинна карта',
  ],
  recoveryDetail: [
    'В этом сохранении не для всех сцен есть проверенная сетка и позиции на исходном изображении. Изображение, участники и история доступны для просмотра. Продолжить игру можно после восстановления недостающих карт. Персонажи не перемещены.',
    'This save does not yet have verified grids and positions on the original images for every scene. The image, participants and history remain available to view. Play can resume after the missing maps are recovered. Characters have not been moved.',
    'У цьому збереженні не для всіх сцен є перевірена сітка й позиції на початковому зображенні. Зображення, учасники та історія доступні для перегляду. Продовжити гру можна після відновлення відсутніх карт. Персонажів не переміщено.',
  ],
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
    'Нажми на персонажа — откроется его арт. ПКМ по персонажу или предмету — действия; на сенсорном экране коснись предмета или кнопки «…».',
    'Tap a character to see their art. Right-click a character or item for actions; on touch screens, tap an item or the “…” button.',
    'Торкнись персонажа — відкриється його арт. ПКМ по персонажу або предмету — дії; на сенсорному екрані торкнися предмета або кнопки «…».',
  ],
  unavailable: ['Сейчас недоступно', 'Currently unavailable', 'Зараз недоступно'],
  actions: ['Действия', 'Actions', 'Дії'],
} as const;
export function useItemText() {
  const { locale } = useT();
  return (key: keyof typeof itemMessages) =>
    itemMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
