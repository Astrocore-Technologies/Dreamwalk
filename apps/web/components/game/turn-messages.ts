'use client';
import { useT } from '@/lib/i18n';
export const turnMessages = {
  unconscious: ['Без сознания', 'Unconscious', 'Непритомний'],
  dead: ['Мёртв', 'Dead', 'Мертвий'],
  cannotRespond: [
    'Персонаж не может говорить или действовать.',
    'This character cannot speak or act.',
    'Персонаж не може говорити чи діяти.',
  ],
  worldWaiting: [
    'Мир разрешает ответы и действия. Если нужна генерация, проверьте её подтверждение под полем истории.',
    'The world is resolving replies and actions. If generation needs confirmation, review it below the story input.',
    'Світ завершує відповіді та дії. Якщо генерація потребує підтвердження, перевірте його під полем історії.',
  ],
  localInput: ['Действия хода · бесплатно', 'Turn actions · free', 'Дії ходу · безкоштовно'],
  lobbyIntro: [
    'Пошаговая история: ходи по сцене, говори с несколькими NPC, затем передай ход миру.',
    'A turn-based story: walk through the scene, address several NPCs, then pass the turn to the world.',
    'Покрокова історія: ходи сценою, говори з кількома NPC, а потім передай хід світу.',
  ],
  locked: [
    'Действие недоступно в этой фазе или ресурс хода исчерпан.',
    'This action is unavailable in this phase or its turn resource is exhausted.',
    'Дія недоступна в цій фазі або ресурс ходу вичерпано.',
  ],
  observedHarm: [
    'Замечена физическая попытка',
    'A physical attempt was observed',
    'Помічено фізичну спробу',
  ],
  rules: ['Правила нового прохождения', 'Rules for new campaigns', 'Правила нового проходження'],
  enableRules: [
    'Пошаговый режим Dreamwalk',
    'Dreamwalk turn-based mode',
    'Покроковий режим Dreamwalk',
  ],
  rulesHint: [
    'Правила закрепляются в новой игровой версии. Уже начатые прохождения не меняются.',
    'Rules are pinned in the new playable version. Existing campaigns keep their original rules.',
    'Правила закріплюються в новій ігровій версії. Уже розпочаті проходження не змінюються.',
  ],
  movementSetting: ['Клеток движения за ход', 'Movement cells per turn', 'Клітин руху за хід'],
  mainSetting: ['Основных действий', 'Main actions', 'Основних дій'],
  additionalSetting: ['Дополнительных действий', 'Additional actions', 'Додаткових дій'],
  reactionSetting: ['Реакций за раунд', 'Reactions per round', 'Реакцій за раунд'],
  vitalitySetting: ['Начальная стойкость', 'Initial vitality', 'Початкова стійкість'],
  damageSetting: [
    'Сила поддерживаемого удара',
    'Supported hit damage',
    'Сила підтримуваного удару',
  ],
  pushSetting: ['Клеток отталкивания', 'Push distance in cells', 'Клітин відштовхування'],

  label: ['Ход приключения', 'Adventure turn', 'Хід пригоди'],
  round: ['Раунд', 'Round', 'Раунд'],
  yours: ['Твой ход', 'Your turn', 'Твій хід'],
  player: ['Ход игрока', 'Player turn', 'Хід гравця'],
  world: ['Ход мира', 'World turn', 'Хід світу'],
  reaction: ['Реакция', 'Reaction', 'Реакція'],
  resolving: ['Завершаем действие…', 'Resolving the action…', 'Завершуємо дію…'],
  movement: ['Движение', 'Movement', 'Рух'],
  main: ['Основное', 'Main', 'Основна'],
  additional: ['Дополнительное', 'Additional', 'Додаткова'],
  reactionResource: ['Реакция', 'Reaction', 'Реакція'],
  end: ['Завершить ход', 'End turn', 'Завершити хід'],
  waiting: [
    'Сейчас действует другой игрок. Мир остаётся на месте, пока он обдумывает ход.',
    'Another player is acting. The world stays still while they compose their turn.',
    'Зараз діє інший гравець. Світ залишається на місці, поки він обмірковує хід.',
  ],
  frozen: [
    'На твоём ходу мир не двигается сам. Слова сохраняются сразу; NPC ответят в свой ход.',
    'The world does not advance on its own during your turn. Words are saved immediately; NPCs reply on their turns.',
    'На твоєму ході світ не рухається сам. Слова зберігаються одразу; NPC дадуть відповідь у свій хід.',
  ],
  pending: ['Ожидаются реплики NPC', 'Pending NPC replies', 'Очікуються репліки NPC'],
  deferred: [
    'Сообщение сохранено. NPC ответит в свой ход; можешь обратиться к другому персонажу.',
    'Message saved. The NPC will reply on its turn; you can address another character now.',
    'Повідомлення збережено. NPC відповість у свій хід; можеш звернутися до іншого персонажа.',
  ],
  worldPending: [
    'Мир отвечает на подтверждённые действия и сообщения игроков.',
    'The world is responding to confirmed player actions and messages.',
    'Світ відповідає на підтверджені дії та повідомлення гравців.',
  ],
  defend: ['Защититься', 'Defend', 'Захиститися'],
  decline: ['Пропустить реакцию', 'Pass reaction', 'Пропустити реакцію'],
  reactionHint: [
    'Подтверждённая попытка ждёт твоей реакции. После неё продолжается исходный ход.',
    'A confirmed attempt is waiting for your reaction. The original turn resumes afterward.',
    'Підтверджена спроба очікує твоєї реакції. Після неї продовжиться початковий хід.',
  ],
  inspect: ['Осмотреть', 'Inspect', 'Оглянути'],
  inspectHint: [
    'ПКМ по NPC — осмотр. На сенсорном экране используй кнопку осмотра.',
    'Right-click an NPC to inspect. On touch screens, use the inspect button.',
    'ПКМ по NPC — огляд. На сенсорному екрані скористайся кнопкою огляду.',
  ],
  noDescription: [
    'Публичное описание ещё не добавлено.',
    'No public description has been added yet.',
    'Публічний опис ще не додано.',
  ],
  close: ['Закрыть осмотр', 'Close inspection', 'Закрити огляд'],
  talk: ['Поговорить', 'Talk', 'Поговорити'],
  push: ['Толкнуть', 'Push', 'Штовхнути'],
  hit: ['Ударить', 'Hit', 'Ударити'],
  outOfTurn: [
    'Сейчас ход другого участника.',
    'It is another participant’s turn.',
    'Зараз хід іншого учасника.',
  ],
  exhausted: [
    'Для этого действия не осталось ресурса хода.',
    'There is no turn resource left for this action.',
    'Для цієї дії не залишилося ресурсу ходу.',
  ],
  stale: [
    'Ход уже изменился. Обнови состояние перед действием.',
    'The turn has changed. Refresh before acting.',
    'Хід уже змінився. Онови стан перед дією.',
  ],
  paused: [
    'Ждём активного игрока. Его ход не пропускается автоматически.',
    'Waiting for the active player. Their turn is not skipped automatically.',
    'Очікуємо активного гравця. Його хід не пропускається автоматично.',
  ],
} as const;
export type TurnMessage = keyof typeof turnMessages;
export function useTurnText() {
  const { locale } = useT();
  return (key: TurnMessage) => turnMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
