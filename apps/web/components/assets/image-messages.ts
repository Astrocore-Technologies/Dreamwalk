'use client';
import { useT } from '@/lib/i18n';
const rows = {
  advanced: ['Дополнительные настройки', 'Advanced options', 'Додаткові налаштування'],
  confirmTitle: ['Подтверждение генерации', 'Confirm image generation', 'Підтвердження генерації'],
  confirm: ['Подтвердить и создать', 'Confirm and generate', 'Підтвердити й створити'],
  cancelQuote: ['Отмена', 'Cancel', 'Скасувати'],
  quoteRights: [
    'Запрашивая оценку, вы подтверждаете права на описание и выбранные референсы. Сам запрос оценки не запускает генерацию.',
    'By requesting an estimate, you confirm rights to the description and selected references. Requesting an estimate does not start generation.',
    'Запитуючи оцінку, ви підтверджуєте права на опис і вибрані референси. Запит оцінки не запускає генерацію.',
  ],
  confirmNotice: [
    'Будет зарезервирована показанная сумма: сначала Грёзы, затем Искры. Подтверждение запускает один запрос; автоматического повтора не будет.',
    'The displayed amount will be held: Dreams first, then Sparks. Confirmation starts one request, with no automatic retry.',
    'Буде зарезервовано показану суму: спочатку Мрії, потім Іскри. Підтвердження запускає один запит, без автоматичного повтору.',
  ],
  confirmProviderNotice: [
    'Один запрос оплачивается через счёт провайдера; кошелёк игрока не используется.',
    'One request is billed to the provider account; the player wallet is not used.',
    'Один запит оплачується через рахунок провайдера; гаманець гравця не використовується.',
  ],
  confirmProviderRisk: [
    'Оценка не ограничивает счёт провайдера: фактический расход может быть выше.',
    'The estimate does not cap the provider invoice: actual cost may be higher.',
    'Оцінка не обмежує рахунок провайдера: фактичні витрати можуть бути вищими.',
  ],
  confirmRisk: [
    'Списание не превысит показанную сумму. Если расход провайдера выше или неизвестен, запрос останется на сверке без дополнительного списания.',
    'The charge will not exceed the displayed amount. Higher or unknown provider costs remain pending reconciliation without an additional charge.',
    'Списання не перевищить показану суму. Вищі або невідомі витрати провайдера залишаться на звірці без додаткового списання.',
  ],

  referencesUnavailable: [
    'Референсы недоступны в настроенном профиле. Сними их выбор для запроса только по тексту; автоматически они не удаляются.',
    'References are unavailable in the configured profile. Deselect them for a text-only request; they are never removed automatically.',
    'Референси недоступні в налаштованому профілі. Зніми їх вибір для запиту лише за текстом; автоматично вони не видаляються.',
  ],

  ownerUnavailable: [
    'Внешняя генерация недоступна из-за настроек или разрешений сервера. Проверь причины ниже. Тестовый образец не заменяет результат API.',
    'External generation is unavailable because of server configuration or authorization. Check the reasons below. A test sample does not replace an API result.',
    'Зовнішня генерація недоступна через налаштування або дозволи сервера. Перевір причини нижче. Тестовий приклад не замінює результат API.',
  ],

  runExternal: ['Создать одно изображение', 'Generate one image', 'Створити одне зображення'],
  declineExternal: [
    'Не использовать найденное; подготовить новую оценку',
    'Decline these matches; prepare a new quote',
    'Не використовувати знайдене; підготувати нову оцінку',
  ],
  externalConsent: [
    'Разрешаю только этот внешний запрос и передачу выбранных референсов. Повторной генерации без нового согласия не будет.',
    'I authorize only this external request and transfer of the selected references. Regeneration requires new consent.',
    'Дозволяю лише цей зовнішній запит і передавання вибраних референсів. Повторна генерація потребує нової згоди.',
  ],
  estimateRiskConsent: [
    'Отдельно принимаю риск: оценка и резерв не ограничивают счёт провайдера, он может быть выше. Неизвестное списание остановит дальнейшие запросы.',
    'I separately accept the risk: the estimate and reserve do not cap the provider invoice, which may be higher. An unknown charge will stop further requests.',
    'Окремо приймаю ризик: оцінка й резерв не обмежують рахунок провайдера, він може бути вищим. Невідоме списання зупинить подальші запити.',
  ],

  estimatedCost: ['Оценка полной стоимости', 'Estimated total cost', 'Оцінка повної вартості'],
  reserveCost: ['Операционный резерв', 'Operational reserve', 'Операційний резерв'],
  estimateNotice: [
    'Оценка и резерв не гарантируют максимальный счёт провайдера.',
    'The estimate and reserve do not guarantee a maximum provider invoice.',
    'Оцінка й резерв не гарантують максимальний рахунок провайдера.',
  ],
  estimatePending: [
    'Запуск по оценке выключен до отдельного согласия на этот риск.',
    'Estimate-based dispatch is disabled pending separate risk approval.',
    'Запуск за оцінкою вимкнений до окремої згоди на цей ризик.',
  ],
  usd: ['USD', 'USD', 'USD'],
  httpStatus: ['Статус HTTP', 'HTTP status', 'Статус HTTP'],
  diagnostics: ['Условия подключения API', 'API connection conditions', 'Умови підключення API'],
  providerError: [
    'Провайдер сообщил об ошибке. Списание не подтверждено; автоматического повтора нет.',
    'The provider reported an error. Billing is unconfirmed; there is no automatic retry.',
    'Провайдер повідомив про помилку. Списання не підтверджене; автоматичного повтору немає.',
  ],
  heldCost: ['Зарезервировано', 'Reserved', 'Зарезервовано'],
  actualCost: ['Фактическая стоимость', 'Actual cost', 'Фактична вартість'],
  mode: ['Режим создания', 'Creation mode', 'Режим створення'],
  mockMode: ['Тест без API', 'Fixture without API', 'Тест без API'],
  externalMode: ['OpenAI API', 'OpenAI API', 'OpenAI API'],
  upperCost: [
    'Подтверждённый потолок стоимости',
    'Verified upper cost',
    'Підтверджена межа вартості',
  ],
  title: ['Подготовка изображения', 'Image preparation', 'Підготовка зображення'],
  source: [
    'Создание изображения доступно в графике конкретного приключения.',
    'Create images from an adventure’s art editor.',
    'Створення зображень доступне в графіці конкретної пригоди.',
  ],
  mock: [
    'Тестовый режим: готовый образец, не новая AI-иллюстрация. Внешних запросов и расходов нет.',
    'Test mode: a fixed sample, not a new AI illustration. No external requests or charges.',
    'Тестовий режим: готовий зразок, не нова AI-ілюстрація. Зовнішніх запитів і витрат немає.',
  ],
  unavailable: [
    'Внешняя генерация недоступна: строгая верхняя граница стоимости не подтверждена. Одобренный лимит не является ценой запроса.',
    'External generation is unavailable: a strict cost upper bound is not verified. An approved allowance is not a request price.',
    'Зовнішня генерація недоступна: сувору верхню межу вартості не підтверджено. Схвалений ліміт не є ціною запиту.',
  ],
  prompt: ['Описание рисунка', 'Artwork description', 'Опис малюнка'],
  background: ['Фон изображения', 'Image background', 'Тло зображення'],
  opaque: ['Непрозрачный', 'Opaque', 'Непрозорий'],
  transparent: ['Прозрачный', 'Transparent', 'Прозорий'],
  rights: [
    'Подтверждаю права на запрос и выбранные собственные референсы.',
    'I confirm rights to this request and the selected owned references.',
    'Підтверджую права на запит і вибрані власні референси.',
  ],
  references: [
    'Собственные референсы (до двух)',
    'Owned references (up to two)',
    'Власні референси (до двох)',
  ],
  derivative: [
    'Чужое разрешение на повторное использование не разрешает отправлять рисунок генератору для переработки.',
    'Another author’s reuse grant does not authorize sending their art to a generator for editing.',
    'Чужий дозвіл на повторне використання не дозволяє надсилати малюнок генератору для переробки.',
  ],
  quote: ['Узнать стоимость', 'Estimate cost', 'Дізнатися вартість'],
  matches: [
    'Найдены совместимые материалы. Можно использовать их без генерации.',
    'Compatible art exists. You can reuse it without generating.',
    'Знайдено сумісні матеріали. Їх можна використати без генерації.',
  ],
  decline: [
    'Не использовать найденные варианты; подготовить отдельный тест',
    'Decline these matches; prepare a separate test',
    'Не використовувати знайдені варіанти; підготувати окремий тест',
  ],
  consent: [
    'Подтверждаю один тестовый запуск по этой цене. Повторная генерация не выполняется автоматически.',
    'I confirm one test run at this quote. Regeneration is never automatic.',
    'Підтверджую один тестовий запуск за цією ціною. Повторна генерація не виконується автоматично.',
  ],
  cost: [
    'Верхняя стоимость теста: 0 USD.',
    'Test upper cost: USD 0.',
    'Верхня вартість тесту: 0 USD.',
  ],
  expires: [
    'Предложение истекло. Подготовь новое и подтверди его отдельно.',
    'Quote expired. Prepare and explicitly confirm a new one.',
    'Пропозиція спливла. Підготуй нову й підтверди її окремо.',
  ],
  run: ['Запустить один тест', 'Run one test', 'Запустити один тест'],
  jobs: ['Сохранённые задачи', 'Saved jobs', 'Збережені завдання'],
  queued: ['В очереди', 'Queued', 'У черзі'],
  dispatched: ['Запрос отправлен', 'Dispatched', 'Запит надіслано'],
  unknown: [
    'Результат неизвестен; резерв удерживается, автоматического повтора нет.',
    'Outcome unknown; reserve is held and no automatic retry occurs.',
    'Результат невідомий; резерв утримується, автоматичного повтору немає.',
  ],
  generated: [
    'Проверка полученного изображения',
    'Validating received image',
    'Перевірка отриманого зображення',
  ],
  admitted: [
    'Сохранено как неизменяемая ревизия',
    'Saved as an immutable revision',
    'Збережено як незмінну ревізію',
  ],
  rejected: [
    'Отклонено без повторной генерации',
    'Rejected without regeneration',
    'Відхилено без повторної генерації',
  ],
  cancelled: ['Отменено', 'Cancelled', 'Скасовано'],
  expired: ['Срок истёк', 'Expired', 'Строк сплив'],
  cancel: ['Запросить отмену задачи', 'Request job cancellation', 'Запросити скасування завдання'],
  cancelNote: [
    'После отправки отмена не означает возврат стоимости; неизвестный расход остаётся зарезервированным.',
    'After dispatch, cancellation does not imply a refund; uncertain cost remains reserved.',
    'Після надсилання скасування не означає повернення вартості; невідомі витрати залишаються зарезервованими.',
  ],
  result: [
    'Результат не привязан к сцене и не опубликован автоматически.',
    'The result is not automatically bound to a scene or published.',
    'Результат не прив’язується до сцени й не публікується автоматично.',
  ],
  refresh: ['Обновить состояние', 'Refresh status', 'Оновити стан'],
} as const;
export function useImageText() {
  const { locale } = useT();
  return (key: keyof typeof rows) => rows[key][locale === 'ru' ? 0 : locale === 'uk' ? 2 : 1];
}
