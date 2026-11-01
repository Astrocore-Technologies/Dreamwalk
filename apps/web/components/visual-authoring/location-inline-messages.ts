'use client';
import { useT } from '@/lib/i18n';
export const locationInlineMessages = {
  regenerate: ['Перегенерировать изображение', 'Regenerate image', 'Перегенерувати зображення'],
  history: [
    'Предыдущие попытки и удержания',
    'Previous attempts and holds',
    'Попередні спроби та утримання',
  ],
  pending: [
    'Изображение ещё создаётся. Дождись результата этой попытки.',
    'The image is being created. Wait for this attempt to finish.',
    'Зображення ще створюється. Дочекайся результату цієї спроби.',
  ],
  blocked: [
    'Не получен подтверждённый результат предыдущего запроса. Новые запросы временно остановлены; подробности — в истории.',
    'A previous request has no confirmed outcome. New requests are paused; see history for details.',
    'Попередній запит не має підтвердженого результату. Нові запити призупинено; подробиці — в історії.',
  ],

  preparing: [
    'Проверяем библиотеку и рассчитываем цену…',
    'Checking the library and calculating the price…',
    'Перевіряємо бібліотеку та розраховуємо ціну…',
  ],
  generate: ['Сгенерировать изображение', 'Generate image', 'Згенерувати зображення'],
  consent: [
    'Нажимая кнопку, разрешаю один запрос по показанной оценке. Резерв не ограничивает счёт OpenAI; неизвестный расход остановит запросы.',
    'By clicking, I authorize one request at the displayed estimate. The reserve does not cap OpenAI’s invoice; unknown spend stops further requests.',
    'Натискаючи кнопку, дозволяю один запит за показаною оцінкою. Резерв не обмежує рахунок OpenAI; невідома витрата зупинить запити.',
  ],
  privateRights: [
    'Изображение остаётся без разрешений другим авторам, пока ты их явно не выдашь.',
    'No other author receives a reuse grant unless you explicitly issue one.',
    'Інші автори не отримають дозволу на використання, доки ти його явно не надаси.',
  ],
  stopped: [
    'Предыдущий запрос завершился без подтверждённого расхода. Резерв удерживается. Включение модели не снимает эту остановку.',
    'A previous request has no confirmed charge. Its reserve remains held. Enabling the model does not clear this stop.',
    'Попередній запит не має підтвердженої витрати. Резерв утримується. Увімкнення моделі не знімає цю зупинку.',
  ],
  outstanding: [
    'Предыдущий запрос ещё не завершён. Новая генерация доступна после его результата.',
    'A previous request is still outstanding. Wait for its result before generating again.',
    'Попередній запит ще не завершено. Дочекайся результату перед новою генерацією.',
  ],
  authorization: [
    'Нужно подтверждение бюджета владельца. Настройки доступны ниже.',
    'Owner budget approval is required. Settings are available below.',
    'Потрібне підтвердження бюджету власника. Налаштування доступні нижче.',
  ],
  settings: [
    'Настройки бюджета и библиотеки',
    'Budget and library settings',
    'Налаштування бюджету та бібліотеки',
  ],
  refresh: ['Обновить статус', 'Refresh status', 'Оновити стан'],
  recovery: [
    'Подтвердить расход отклонённого запроса',
    'Confirm the rejected request’s charge',
    'Підтвердити витрату відхиленого запиту',
  ],
  recoveryHelp: [
    'Сверь этот Request ID с Usage OpenAI или ответом поддержки. Одного включения модели недостаточно. Введи точный подтверждённый расход и номер подтверждения, без ключей и личных данных.',
    'Match this Request ID with OpenAI Usage or a support response. Enabling the model is insufficient. Enter the confirmed exact charge and evidence reference, without keys or personal data.',
    'Зістав цей Request ID з Usage OpenAI або відповіддю підтримки. Увімкнення моделі недостатньо. Введи точну підтверджену витрату та номер підтвердження без ключів і особистих даних.',
  ],
  evidenceSource: ['Источник подтверждения', 'Evidence source', 'Джерело підтвердження'],
  usage: ['Usage OpenAI', 'OpenAI Usage', 'Usage OpenAI'],
  support: ['Ответ поддержки OpenAI', 'OpenAI support response', 'Відповідь підтримки OpenAI'],
  evidenceReference: [
    'Номер подтверждения / отчёта',
    'Evidence / report reference',
    'Номер підтвердження / звіту',
  ],
  actualCost: ['Подтверждённый расход, USD', 'Confirmed charge, USD', 'Підтверджена витрата, USD'],
  proof: [
    'Я проверил расход именно этого запроса у провайдера и восстановил доступ к модели.',
    'I checked this specific request’s charge with the provider and restored model access.',
    'Я перевірив витрату саме цього запиту у провайдера та відновив доступ до моделі.',
  ],
  reviewRecovery: ['Проверить восстановление', 'Review recovery', 'Перевірити відновлення'],
  applyRecovery: [
    'Учесть подтверждённый расход и восстановить запросы',
    'Record confirmed spend and resume requests',
    'Врахувати підтверджену витрату та відновити запити',
  ],
  recoveryReviewed: [
    'Исходная ошибка сохранится. Удержание заменится указанным расходом в том же бюджете; новый запрос автоматически не отправится.',
    'The original error is retained. The hold becomes the stated charge in the same budget; no new request is sent automatically.',
    'Початкова помилка збережеться. Утримання заміниться вказаною витратою в тому самому бюджеті; новий запит автоматично не надсилається.',
  ],
} as const;
export function useLocationInlineText() {
  const { locale } = useT();
  return (key: keyof typeof locationInlineMessages) =>
    locationInlineMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
