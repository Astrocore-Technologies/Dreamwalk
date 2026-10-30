'use client';
import { useT } from '@/lib/i18n';
const rows = {
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
  quote: [
    'Проверить библиотеку и подготовить цену',
    'Check library and prepare quote',
    'Перевірити бібліотеку й підготувати ціну',
  ],
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
