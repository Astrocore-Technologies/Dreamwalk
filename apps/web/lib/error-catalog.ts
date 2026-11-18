/**
 * Plain-language messages for API error codes a player can meet. A specific entry wins; any other
 * code falls into a recovery category by its name, so a new server code never degrades to a bare
 * "request failed". Sentences say what happened and what to do next. No code names are shown.
 */
type Text = { ru: string; en: string; uk: string };
const message = (ru: string, en: string, uk: string): Text => ({ ru, en, uk });

const STALE = message(
  'Данные изменились, пока вы действовали. Обновите страницу и повторите.',
  'The data changed while you were acting. Refresh the page and try again.',
  'Дані змінилися, поки ви діяли. Оновіть сторінку й повторіть.',
);
const UNAVAILABLE = message(
  'Сервис временно недоступен. Подождите немного и попробуйте снова.',
  'The service is temporarily unavailable. Wait a moment and try again.',
  'Сервіс тимчасово недоступний. Зачекайте трохи й спробуйте знову.',
);
const NEEDS_STEP = message(
  'Не хватает подтверждения или подготовки. Обновите страницу и пройдите шаг заново.',
  'A confirmation or preparation step is missing. Refresh the page and go through the step again.',
  'Бракує підтвердження або підготовки. Оновіть сторінку й пройдіть крок знову.',
);
const FUNDS = message(
  'Не хватает средств или лимит исчерпан. Проверьте баланс или попробуйте позже.',
  'Not enough funds or a limit was reached. Check your balance or try later.',
  'Не вистачає коштів або ліміт вичерпано. Перевірте баланс або спробуйте пізніше.',
);
const DENIED = message(
  'У вас нет доступа к этому действию.',
  'You do not have access to this action.',
  'У вас немає доступу до цієї дії.',
);
const TOO_BIG = message(
  'Текст или запрос слишком большой для ИИ. Сократите историю или описание и повторите.',
  'The text or request is too large for the AI. Shorten the story or description and try again.',
  'Текст або запит завеликий для ШІ. Скоротіть історію чи опис і повторіть.',
);
const MISSING = message(
  'Не найдено. Возможно, это уже удалили или изменили.',
  'Not found. It may have been removed or changed.',
  'Не знайдено. Можливо, це вже видалили або змінили.',
);
const INVALID = message(
  'Данные не подходят. Проверьте введённое и повторите.',
  'The data is not acceptable. Check what you entered and try again.',
  'Дані не підходять. Перевірте введене й повторіть.',
);
const WRONG_MODE = message(
  'Это действие недоступно в текущем режиме игры.',
  'This action is not available in the current game mode.',
  'Ця дія недоступна в поточному режимі гри.',
);
const PAID_UNSETTLED = message(
  'Предыдущий платный запрос ещё уточняется. Повторять его не нужно: подождите и обновите страницу.',
  'A previous paid request is still being settled. Do not repeat it: wait and refresh the page.',
  'Попередній платний запит ще уточнюється. Повторювати його не потрібно: зачекайте й оновіть сторінку.',
);

/** Codes with their own wording, most useful first. */
const specific: Record<string, Text> = {
  STALE_STATE: STALE,
  OUT_OF_RANGE: message(
    'Слишком далеко. Сначала подойдите ближе.',
    'Too far away. Move closer first.',
    'Надто далеко. Спершу підійдіть ближче.',
  ),
  PATH_BLOCKED: message('Путь перекрыт.', 'The path is blocked.', 'Шлях перекрито.'),
  SELF_GRANT_UNNECESSARY: message(
    'Это действие не требуется.',
    'That action is not needed.',
    'Ця дія не потрібна.',
  ),
  STALE_REVISION: STALE,
  STALE_CANON: STALE,
  TURN_PHASE_STALE: message(
    'Ход уже перешёл дальше. Обновите страницу.',
    'The turn has already moved on. Refresh the page.',
    'Хід уже перейшов далі. Оновіть сторінку.',
  ),
  IDEMPOTENCY_CONFLICT: message(
    'Это действие уже отправлялось с другими данными. Обновите страницу и повторите.',
    'This action was already sent with different data. Refresh the page and try again.',
    'Цю дію вже надсилали з іншими даними. Оновіть сторінку й повторіть.',
  ),
  QUOTE_EXPIRED: message(
    'Цена устарела. Запросите её заново.',
    'The price has expired. Request it again.',
    'Ціна застаріла. Запросіть її знову.',
  ),
  GENERATION_QUOTE_STALE: message(
    'Цена устарела. Запросите её заново.',
    'The price has expired. Request it again.',
    'Ціна застаріла. Запросіть її знову.',
  ),
  QUOTE_CONSUMED: message(
    'Эта цена уже использована. Запросите новую.',
    'This price was already used. Request a new one.',
    'Цю ціну вже використано. Запросіть нову.',
  ),
  INVALID_ACTION: message(
    'Такое действие сейчас невозможно.',
    'That action is not possible right now.',
    'Така дія зараз неможлива.',
  ),
  MAP_GRID_REQUIRED: message(
    'Карту этой истории нужно подготовить заново. Вернитесь на страницу истории и начните снова.',
    'This story’s map must be prepared again. Go back to the story page and start again.',
    'Карту цієї історії потрібно підготувати заново. Поверніться на сторінку історії й почніть знову.',
  ),
  START_SOURCE_CHANGED: message(
    'История изменилась после подготовки. Подготовьте игру заново.',
    'The story changed after preparation. Prepare the game again.',
    'Історія змінилася після підготовки. Підготуйте гру заново.',
  ),
  NOT_PLAYABLE: message(
    'Эту историю пока нельзя начать.',
    'This story cannot be started yet.',
    'Цю історію поки що не можна почати.',
  ),
  OPENING_ART_REQUIRED: message(
    'У этой истории ещё нет стартовой картинки, поэтому начать её пока нельзя.',
    'This story has no opening picture yet, so it cannot be started for now.',
    'У цієї історії ще немає стартової картинки, тому почати її поки що не можна.',
  ),
  CAMPAIGN_FULL: message(
    'В этой игре нет свободных мест.',
    'This game has no free seats.',
    'У цій грі немає вільних місць.',
  ),
  HERO_NOT_FOUND: message(
    'Герой не найден. Выберите другого.',
    'Hero not found. Choose another one.',
    'Героя не знайдено. Оберіть іншого.',
  ),
  HERO_CHANGED: message(
    'Герой изменился. Выберите его ещё раз.',
    'The hero changed. Choose them again.',
    'Герой змінився. Оберіть його ще раз.',
  ),
  HERO_SELECTION_LOCKED: message(
    'Героя нельзя сменить в уже начатой игре.',
    'The hero cannot be changed in a game that has started.',
    'Героя не можна змінити в уже розпочатій грі.',
  ),
  NPC_AI_BUSY: message(
    'Персонажи сейчас заняты. Попробуйте через минуту.',
    'The characters are busy right now. Try again in a minute.',
    'Персонажі зараз зайняті. Спробуйте за хвилину.',
  ),
  DIRECTOR_UNAVAILABLE: UNAVAILABLE,
  PROVIDER_DISABLED: message(
    'ИИ сейчас отключён. Попробуйте позже.',
    'The AI is switched off right now. Try again later.',
    'ШІ зараз вимкнено. Спробуйте пізніше.',
  ),
  RECOVERY_REQUIRED: PAID_UNSETTLED,
  LIVE_OUTCOME_UNRESOLVED: PAID_UNSETTLED,
  PRIOR_LIABILITY_UNRESOLVED: PAID_UNSETTLED,
  PRIOR_NPC_LIABILITY_UNRESOLVED: PAID_UNSETTLED,
  CONTEXT_BUDGET_EXCEEDED: TOO_BIG,
  TEXT_CONTEXT_WINDOW_EXCEEDED: TOO_BIG,
  GENERATION_INPUT_TOO_LARGE: TOO_BIG,
  AUTHORING_CONTEXT_TOO_LARGE: TOO_BIG,
  MEDIA_CONTEXT_TOO_LARGE: TOO_BIG,
  STORY_PLAN_CAPACITY: TOO_BIG,
  DATA_ERASED: message(
    'Эти данные удалены по запросу и недоступны.',
    'These data were erased on request and are unavailable.',
    'Ці дані видалено на запит і вони недоступні.',
  ),
};

/** Recovery categories by name, first match wins. */
const categories: [RegExp, Text][] = [
  [/UNRESOLVED|RECOVER|OUTSTANDING|NOT_RECONCILING/, PAID_UNSETTLED],
  [/TOO_LARGE|TOO_BIG|EXCEEDS|CAPACITY|CONTEXT_WINDOW|INPUT_TOO/, TOO_BIG],
  [/_ONLY$|^USE_|NOT_AUTHORIZED|BOUNDED_/, WRONG_MODE],
  [/BUDGET|LIMIT|QUOTA|INSUFFICIENT|SPONSOR|ALLOWANCE|CAP_|_CAP\b|SPARK|RESERV|FUNDS|COST/, FUNDS],
  [
    /FORBIDDEN|OWNER|OPERATOR|ADMIN|AUTHORIZATION|NOT_ATTESTED|PERMISSION|ACCESS|ACCOUNT_REVIEW/,
    DENIED,
  ],
  [/NOT_FOUND|MISSING|NO_PROVIDER/, MISSING],
  [/INVALID|VALIDATION|INTEGRITY|INCOMPATIBLE|CONFIG_/, INVALID],
  [/STALE|CHANGED|CONFLICT|MISMATCH|EXPIRED|CONSUMED|DISPATCHED|ALREADY|IMMUTABLE|MODIFIED/, STALE],
  [
    /UNAVAILABLE|BUSY|RELEASE_|SUPERSEDED|PLANNER|PROVIDER|DISABLED|STOPPED|STARTING|INCOMPLETE|NOT_READY|IN_PROGRESS/,
    UNAVAILABLE,
  ],
  [/REQUIRED|CONSENT|NOT_PENDING|ATTESTED|MODE_/, NEEDS_STEP],
];
/** Generic recovery advice for any code that matches none of the above. */
const GENERIC = message(
  'Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.',
  'The action could not be completed. Refresh the page and try again.',
  'Не вдалося виконати дію. Оновіть сторінку й спробуйте ще раз.',
);

export function describeErrorCode(code: string): Text {
  const exact = specific[code];
  if (exact) return exact;
  for (const [pattern, text] of categories) if (pattern.test(code)) return text;
  return GENERIC;
}
/** Every sentence above, keyed by its Russian text, for the translation dictionaries. */
export const errorMessages: Record<string, Text> = Object.fromEntries(
  [
    STALE,
    UNAVAILABLE,
    NEEDS_STEP,
    FUNDS,
    DENIED,
    TOO_BIG,
    MISSING,
    INVALID,
    WRONG_MODE,
    PAID_UNSETTLED,
    GENERIC,
    ...Object.values(specific),
  ].map((text) => [text.ru, text]),
);
