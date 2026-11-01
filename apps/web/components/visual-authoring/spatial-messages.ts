'use client';
import { useT } from '@/lib/i18n';
export const spatialMessages = {
  ownerUnavailable: [
    'Текстовое планирование недоступно. Проверь серверную модель, разрешение владельца и доступный бюджет.',
    'Text planning is unavailable. Check the server model, owner authorization and available budget.',
    'Текстове планування недоступне. Перевір серверну модель, дозвіл власника й доступний бюджет.',
  ],

  mapToEdit: ['Карта для редактирования', 'Map to edit', 'Карта для редагування'],
  placeholderPreview: [
    'Это просмотр геометрии с временными значками, а не сгенерированная иллюстрация. После применения можно пройти по плану в песочнице.',
    'This geometry preview uses placeholder graphics, not generated artwork. After applying it, you can walk through the sandbox plan.',
    'Це перегляд геометрії з тимчасовими позначками, а не згенерована ілюстрація. Після застосування можна пройти планом у пісочниці.',
  ],
  oneAttempt: [
    'Попытка этого проекта завершена. Для другого запроса создай новый проект с исправленным описанием и новым согласием.',
    'This project has used its planning attempt. For another request, create a new project with a revised brief and fresh consent.',
    'Цей проєкт уже використав спробу планування. Для іншого запиту створи новий проєкт зі зміненим описом і новою згодою.',
  ],
  cancelProposal: ['Отменить это предложение', 'Cancel this proposal', 'Скасувати цю пропозицію'],
  applyFirst: [
    'Сначала примени проверенное пространственное предложение. Изображения не заменяют план.',
    'Apply a validated spatial proposal first. Images do not replace the plan.',
    'Спершу застосуй перевірену просторову пропозицію. Зображення не замінюють план.',
  ],
  generated: [
    'Ответ получен, идёт проверка',
    'Response received, validating',
    'Відповідь отримано, триває перевірка',
  ],
  committed: [
    'Проверенное предложение получено',
    'Validated proposal received',
    'Перевірену пропозицію отримано',
  ],
  details: [
    'Все комнаты, входы, выходы и публичные описания',
    'All rooms, entrances, exits and public descriptions',
    'Усі кімнати, входи, виходи й публічні описи',
  ],
  entrances: ['Входные позиции', 'Entry positions', 'Вхідні позиції'],
  exits: ['Выход', 'Exit', 'Вихід'],
  mode: [
    'Как создать пространственный план',
    'How to create the spatial plan',
    'Як створити просторовий план',
  ],
  ai: [
    'ИИ по описанию — отдельный текстовый запрос',
    'AI from description — separate text request',
    'ШІ за описом — окремий текстовий запит',
  ],
  manual: [
    'Редактируемый шаблон вручную — бесплатно',
    'Editable manual template — free',
    'Редагований шаблон вручну — безкоштовно',
  ],
  title: ['ИИ: пространственное предложение', 'AI spatial proposal', 'ШІ: просторова пропозиція'],
  intro: [
    'ИИ предлагает геометрию и наполнение по сохранённому описанию. Сервер проверяет план; только твоё применение меняет этот проект.',
    'AI proposes geometry and contents from the saved description. The server validates the plan; only your Apply action changes this project.',
    'ШІ пропонує геометрію та наповнення за збереженим описом. Сервер перевіряє план; лише твоє застосування змінює цей проєкт.',
  ],
  pending: [
    'План ещё не создан ИИ. Шаблон не выдается за результат генерации.',
    'AI has not created a plan yet. A template is not presented as generated output.',
    'ШІ ще не створив план. Шаблон не видається за результат генерації.',
  ],
  validated: [
    'План получен от ИИ и прошёл серверную проверку. Перед утверждением осмотри и при необходимости измени его в песочнице.',
    'The AI plan passed server validation. Review it and make any needed sandbox edits before approval.',
    'План ШІ пройшов серверну перевірку. Перед підтвердженням оглянь його й за потреби відредагуй у пісочниці.',
  ],
  inert: [
    'Это предложение, а не текущая игровая история. Ни рисунки, ни ответ модели сами не меняют общую сцену.',
    'This is a proposal, not the current shared story. Neither artwork nor a model response changes the shared scene by itself.',
    'Це пропозиція, а не поточна спільна історія. Ані графіка, ані відповідь моделі самі не змінюють спільну сцену.',
  ],
  unavailable: [
    'Текстовое планирование сейчас недоступно. Нужна активная ручная сессия и доступный бюджет.',
    'Text planning is currently unavailable. An active manual session and available budget are required.',
    'Текстове планування зараз недоступне. Потрібні активна ручна сесія та доступний бюджет.',
  ],
  quote: ['Оценить один запрос плана', 'Estimate one plan request', 'Оцінити один запит плану'],
  upper: [
    'Резерв бюджета на этот текстовый запрос',
    'Budget reservation for this text request',
    'Резерв бюджету на цей текстовий запит',
  ],
  expires: ['Подтверждение действительно до', 'Consent is valid until', 'Підтвердження діє до'],
  expired: [
    'Оценка истекла. Получи новую перед отправкой.',
    'The estimate expired. Get a new one before dispatch.',
    'Термін оцінки минув. Отримай нову перед надсиланням.',
  ],
  consent: [
    'Подтверждаю один внешний текстовый запрос по сохранённому описанию и указанный резерв. Применение плана подтвержу отдельно.',
    'I approve one external text request using the saved brief and the displayed reservation. I will approve applying the plan separately.',
    'Підтверджую один зовнішній текстовий запит за збереженим описом і зазначений резерв. Застосування плану підтверджу окремо.',
  ],
  dispatch: [
    'Запросить одно предложение ИИ',
    'Request one AI proposal',
    'Запросити одну пропозицію ШІ',
  ],
  refresh: ['Обновить состояние плана', 'Refresh plan status', 'Оновити стан плану'],
  noRetry: [
    'Обновление статуса не вызывает ИИ. Повторный платный запрос автоматически не создаётся.',
    'Refreshing status does not call AI. No paid request is retried automatically.',
    'Оновлення стану не викликає ШІ. Платний запит автоматично не повторюється.',
  ],
  proposal: ['Предложение для проверки', 'Proposal for review', 'Пропозиція для перевірки'],
  valid: ['Серверная проверка пройдена', 'Server validation passed', 'Серверну перевірку пройдено'],
  invalid: [
    'Предложение не прошло проверку и не может быть применено.',
    'The proposal failed validation and cannot be applied.',
    'Пропозиція не пройшла перевірку й не може бути застосована.',
  ],
  review: [
    'Я проверил комнаты, входы, выходы, мебель и расположение NPC. Применить это предложение к проекту.',
    'I reviewed the rooms, entrances, exits, furniture and NPC positions. Apply this proposal to the project.',
    'Я перевірив кімнати, входи, виходи, меблі й розташування NPC. Застосувати цю пропозицію до проєкту.',
  ],
  apply: ['Применить проверенный план', 'Apply validated plan', 'Застосувати перевірений план'],
  applied: [
    'Предложение применено к проекту. До утверждения его можно редактировать; общая игровая сцена не изменена.',
    'The proposal was applied to the project. It remains editable before approval; the shared game scene has not changed.',
    'Пропозицію застосовано до проєкту. До підтвердження її можна редагувати; спільну ігрову сцену не змінено.',
  ],
  cancel: [
    'Запросить отмену планирования',
    'Request planning cancellation',
    'Запросити скасування планування',
  ],
  cancelled: ['Планирование отменено', 'Planning cancelled', 'Планування скасовано'],
  queued: ['Запрос в очереди', 'Request queued', 'Запит у черзі'],
  dispatched: ['Запрос отправлен', 'Request dispatched', 'Запит надіслано'],
  completed: ['Предложение получено', 'Proposal received', 'Пропозицію отримано'],
  failed: [
    'Планирование завершилось ошибкой',
    'Planning failed',
    'Планування завершилося помилкою',
  ],
  unknown: [
    'Исход или списание неизвестны. Резерв сохранён; новый запрос не отправляется. Обнови статус.',
    'The outcome or charge is unknown. The reservation remains; no new request is sent. Refresh status.',
    'Результат або списання невідомі. Резерв збережено; новий запит не надсилається. Онови стан.',
  ],
  failure: [
    'Не удалось выполнить действие. Проверь состояние и код ошибки.',
    'The action did not complete. Check the state and error code.',
    'Дію не виконано. Перевір стан і код помилки.',
  ],
  stale: [
    'Описание или проект изменились. Оцени новый запрос по текущей сохранённой версии.',
    'The brief or project changed. Estimate a new request against the current saved version.',
    'Опис або проєкт змінилися. Оціни новий запит за поточною збереженою версією.',
  ],
  rooms: ['Комнаты', 'Rooms', 'Кімнати'],
  objects: ['Интерактивные предметы', 'Interactive objects', 'Інтерактивні предмети'],
  npcs: ['Персонажи', 'Characters', 'Персонажі'],
  held: ['Зарезервировано', 'Reserved', 'Зарезервовано'],
  debited: [
    'Учтено в тестовом бюджете',
    'Debited from the test budget',
    'Враховано в тестовому бюджеті',
  ],
  objective: ['Предлагаемая цель', 'Proposed objective', 'Запропонована мета'],
} as const;
export type SpatialMessage = keyof typeof spatialMessages;
export function useSpatialText() {
  const { locale } = useT();
  return (key: SpatialMessage) =>
    spatialMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
