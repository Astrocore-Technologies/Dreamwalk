'use client';
import { useT } from '@/lib/i18n';
const rows = {
  testArt: [
    'Подготовить тестовый рисунок по текущей сцене',
    'Prepare test artwork from this scene',
    'Підготувати тестовий малюнок за поточною сценою',
  ],
  title: ['Продолжить историю', 'Continue the story', 'Продовжити історію'],
  hint: [
    'Опиши действие или новое направление истории. Ведущий предложит продолжение в рамках мира; только проверенные сервером изменения станут общими для группы.',
    'Describe an action or a new direction for the story. The director continues within the world’s rules; only server-validated changes become shared reality.',
    'Опиши дію або новий напрям історії. Ведучий продовжить у межах світу; лише перевірені сервером зміни стануть спільними для групи.',
  ],
  input: ['Твой ход в истории', 'Your story turn', 'Твій хід в історії'],
  shared: [
    'Этот ход и принятое продолжение видны участникам кампании. Для личного разговора используй шёпот NPC.',
    'This turn and its accepted continuation are visible to campaign members. Use NPC whisper for private conversation.',
    'Цей хід і прийняте продовження видимі учасникам кампанії. Для особистої розмови використовуй шепіт NPC.',
  ],
  placeholder: [
    'Я ищу следы за дверью и спрашиваю, куда ведёт этот путь…',
    'I look for clues beyond the door and ask where this path leads…',
    'Я шукаю сліди за дверима й питаю, куди веде цей шлях…',
  ],
  mock: [
    'Тестовый ведущий: проверяемое продолжение по заготовке, не ответ внешней модели.',
    'Test director: a validated fixture continuation, not an external model response.',
    'Тестовий ведучий: перевірюване продовження за заготовкою, не відповідь зовнішньої моделі.',
  ],
  external: [
    'Внешний AI-ведущий. Каждый запрос требует показанного разрешения на расходы.',
    'External AI director. Each request requires the displayed spending authorization.',
    'Зовнішній AI-ведучий. Кожен запит потребує показаного дозволу на витрати.',
  ],
  unavailable: [
    'Продолжение истории сейчас недоступно. Сохранение и обычные действия остаются доступны.',
    'Story continuation is currently unavailable. Your save and ordinary actions remain available.',
    'Продовження історії зараз недоступне. Збереження та звичайні дії залишаються доступними.',
  ],
  prepare: ['Подготовить ход', 'Prepare turn', 'Підготувати хід'],
  confirm: ['Подтвердить ход и стоимость', 'Confirm turn and price', 'Підтвердити хід і вартість'],
  cancel: ['Отменить предложение', 'Dismiss quote', 'Скасувати пропозицію'],
  cost: ['Стоимость: {credits} искр', 'Price: {credits} Sparks', 'Вартість: {credits} іскор'],
  providerBound: [
    'Предел расходов на внешний запрос: {amount} USD. Это расходы провайдера, отдельно от DEMO-искр.',
    'External request spending ceiling: {amount} USD. Provider costs are separate from DEMO Sparks.',
    'Межа витрат на зовнішній запит: {amount} USD. Витрати провайдера — окремо від DEMO-іскор.',
  ],
  missingBound: [
    'Верхняя граница внешних расходов не подтверждена. Подтверждение недоступно.',
    'The external spending bound is unverified. Confirmation is unavailable.',
    'Верхню межу зовнішніх витрат не підтверджено. Підтвердження недоступне.',
  ],
  demo: ['DEMO · не реальные деньги', 'DEMO · not real money', 'DEMO · не справжні гроші'],
  expires: [
    'Предложение действует до {time}',
    'Quote expires at {time}',
    'Пропозиція діє до {time}',
  ],
  changed: [
    'История изменилась. Текст сохранён — подготовь ход заново с актуальным состоянием.',
    'The story changed. Your text is preserved — prepare the turn again using the current state.',
    'Історія змінилася. Текст збережено — підготуй хід знову з актуальним станом.',
  ],
  pending: [
    'Ведущий готовит продолжение. Ожидаем подтверждённый результат.',
    'The director is preparing the continuation. Waiting for a confirmed result.',
    'Ведучий готує продовження. Очікуємо підтверджений результат.',
  ],
  failed: [
    'Продолжение не применено. Автоматического повторного запроса нет.',
    'The continuation was not applied. There is no automatic retry.',
    'Продовження не застосовано. Автоматичного повторного запиту немає.',
  ],
  stale: [
    'Продолжение устарело и не применено.',
    'The continuation became stale and was not applied.',
    'Продовження застаріло й не застосоване.',
  ],
  unknown: [
    'Результат запроса уточняется. Не отправляй его заново: расходы могут быть зарезервированы.',
    'The request result is being reconciled. Do not resubmit: costs may remain reserved.',
    'Результат запиту уточнюється. Не надсилай його знову: витрати можуть залишатися зарезервованими.',
  ],
  journal: ['Общая история', 'Shared story', 'Спільна історія'],
  empty: [
    'Здесь появятся только принятые продолжения истории.',
    'Only accepted story continuations will appear here.',
    'Тут з’являться лише прийняті продовження історії.',
  ],
  player: ['Ход игрока', 'Player turn', 'Хід гравця'],
  director: ['Ведущий', 'Director', 'Ведучий'],
  mediaKind: ['Тип оформления', 'Artwork type', 'Тип оформлення'],
  background: ['Фон текущей сцены', 'Current scene background', 'Тло поточної сцени'],
  portrait: ['Портрет видимого NPC', 'Visible NPC portrait', 'Портрет видимого NPC'],
  mediaNpc: ['Персонаж для портрета', 'Character for portrait', 'Персонаж для портрета'],
  findArt: ['Подобрать готовое оформление', 'Find existing artwork', 'Підібрати готове оформлення'],
  attachArt: [
    'Применить к этой кампании',
    'Apply to this campaign',
    'Застосувати до цієї кампанії',
  ],
  noArt: [
    'Подходящих разрешённых изображений не найдено. Временная графика остаётся; генерация не запущена.',
    'No matching authorized artwork was found. Temporary graphics remain; generation has not started.',
    'Відповідних дозволених зображень не знайдено. Тимчасова графіка залишається; генерацію не запущено.',
  ],
  hostArt: [
    'Применить оформление может только организатор кампании.',
    'Only the campaign host can apply artwork.',
    'Застосувати оформлення може лише організатор кампанії.',
  ],
  artApplied: [
    'Оформление сохранено сервером. Сцена обновится после синхронизации.',
    'Artwork was saved by the server. The scene updates after synchronization.',
    'Оформлення збережено сервером. Сцена оновиться після синхронізації.',
  ],
  artFree: [
    'Повторное использование готового изображения: без генерации и списания средств.',
    'Reusing existing artwork: no generation or spending.',
    'Повторне використання готового зображення: без генерації та списання коштів.',
  ],
  mediaTitle: ['Графика новых сцен', 'Artwork for new scenes', 'Графіка нових сцен'],
  media: [
    'Новые места и персонажи сначала могут использовать временную графику. Поиск готовых изображений и создание новых — отдельный процесс с отдельным разрешением; этот ход не запускает платную генерацию изображений.',
    'New places and characters may initially use temporary graphics. Finding existing art and creating new art are separate processes with separate authorization; this turn does not start paid image generation.',
    'Нові місця й персонажі спершу можуть використовувати тимчасову графіку. Пошук готових зображень і створення нових — окремий процес з окремим дозволом; цей хід не запускає платну генерацію зображень.',
  ],
  refresh: ['Проверить результат', 'Check result', 'Перевірити результат'],
} as const;
export function useNarrativeText() {
  const { locale } = useT();
  return (key: keyof typeof rows, values: Record<string, string | number> = {}) => {
    let text: string = rows[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
    for (const [name, value] of Object.entries(values))
      text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}
