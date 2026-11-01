'use client';
import { useT } from '@/lib/i18n';
export const liveMessages = {
  adminLive: [
    'Настроен локальный ручной API-тест. Внешние запросы требуют согласия владельца; доступный бюджет показан ниже.',
    'A local manual API test is configured. External requests need owner consent; the available budget is shown below.',
    'Налаштовано локальний ручний API-тест. Зовнішні запити потребують згоди власника; доступний бюджет показано нижче.',
  ],
  adminProfiles: [
    'Каталог редактирует профили и демонстрационные данные. Он сам не включает внешние запросы; состояние ручного API-теста доступно только назначенному локальному владельцу.',
    'This catalog edits profiles and demo data. It does not enable external requests by itself; manual API-test status is available only to the designated local owner.',
    'Каталог редагує профілі та демонстраційні дані. Він сам не вмикає зовнішні запити; стан ручного API-тесту доступний лише призначеному локальному власнику.',
  ],
  title: ['Ручной API-тест', 'Manual API test', 'Ручний API-тест'],
  intro: [
    'Каждый внешний запрос требует отдельного подтверждения. Открытие панели не запускает ИИ.',
    'Every external request needs separate consent. Opening this panel does not call AI.',
    'Кожен зовнішній запит потребує окремої згоди. Відкриття панелі не запускає ШІ.',
  ],
  cap: ['Общий лимит', 'Combined cap', 'Загальний ліміт'],
  used: ['Списано по бюджету', 'Budget debited', 'Списано з бюджету'],
  held: ['Зарезервировано', 'Reserved', 'Зарезервовано'],
  remaining: ['Осталось', 'Remaining', 'Залишилося'],
  expiry: ['Действует до', 'Expires', 'Діє до'],
  debit: [
    'Списание рассчитано по консервативным настроенным ставкам. Это не фактический счёт OpenAI; неизвестные списания остаются зарезервированными.',
    'Debits use conservative configured rates. This is not the actual OpenAI invoice; unknown charges stay reserved.',
    'Списання розраховане за консервативними налаштованими ставками. Це не фактичний рахунок OpenAI; невідомі списання залишаються зарезервованими.',
  ],
  claimConsent: [
    'Я разрешаю эту ручную тестовую сессию в пределах общего лимита. Каждый запрос подтвержу отдельно.',
    'I authorize this manual test session within its combined cap. I will approve each request separately.',
    'Я дозволяю цю ручну тестову сесію в межах загального ліміту. Кожен запит підтверджу окремо.',
  ],
  claim: ['Активировать ручную сессию', 'Activate manual session', 'Активувати ручну сесію'],
  refresh: ['Обновить статус', 'Refresh status', 'Оновити стан'],
  active: ['Сессия активна', 'Session active', 'Сесія активна'],
  unclaimed: ['Сессия ещё не активирована', 'Session not activated', 'Сесію ще не активовано'],
  stopped: ['Сессия остановлена', 'Session stopped', 'Сесію зупинено'],
  expired: ['Срок сессии истёк', 'Session expired', 'Термін сесії минув'],
  imageBlocked: [
    'Внешние изображения отключены: подтверждённая верхняя граница стоимости отсутствует.',
    'External images are disabled: a verified cost upper bound is unavailable.',
    'Зовнішні зображення вимкнено: перевірена верхня межа вартості відсутня.',
  ],
  imageAvailable: [
    'Изображения доступны только с отдельной оценкой и согласием в мастерской.',
    'Images require a separate estimate and consent in the workshop.',
    'Зображення потребують окремої оцінки та згоди в майстерні.',
  ],
  pending: ['Запросы хода мира', 'World-turn requests', 'Запити ходу світу'],
  load: ['Проверить запросы мира', 'Check world requests', 'Перевірити запити світу'],
  worldOnly: [
    'Запросы можно подтвердить на ходе мира. Ход игрока не вызывает внешнюю модель.',
    'Requests can be approved during the world turn. The player turn does not call the external model.',
    'Запити можна підтвердити на ході світу. Хід гравця не викликає зовнішню модель.',
  ],
  empty: [
    'Запросов для подтверждения нет.',
    'No requests await consent.',
    'Немає запитів для підтвердження.',
  ],
  requestConsent: [
    'Разрешаю только этот запрос в пределах указанной суммы.',
    'I approve only this request up to the displayed amount.',
    'Дозволяю лише цей запит у межах зазначеної суми.',
  ],
  dispatch: ['Подтвердить этот запрос', 'Approve this request', 'Підтвердити цей запит'],
  upper: ['Верхняя оценка', 'Upper estimate', 'Верхня оцінка'],
  approved: ['Разрешён', 'Authorized', 'Дозволено'],
  dispatched: ['Отправлен', 'Dispatched', 'Надіслано'],
  settled: ['Завершён', 'Settled', 'Завершено'],
  unknown: [
    'Результат или списание неизвестны. Обнови статус; новый платный запрос автоматически не создаётся.',
    'The result or charge is unknown. Refresh status; no new paid request is created automatically.',
    'Результат або списання невідомі. Онови стан; новий платний запит автоматично не створюється.',
  ],
  cancelled: ['Отменён', 'Cancelled', 'Скасовано'],
  stale: [
    'Ход изменился. Сначала обнови список запросов.',
    'The turn changed. Refresh requests first.',
    'Хід змінився. Спершу онови список запитів.',
  ],
  failure: [
    'Запрос не выполнен. Проверь код и обнови статус перед дальнейшими действиями.',
    'The request did not complete. Check the code and refresh status before continuing.',
    'Запит не виконано. Перевір код та онови стан перед наступними діями.',
  ],
  historical: [
    'Предыдущие удержания в этой базе',
    'Prior reservations in this database',
    'Попередні утримання в цій базі',
  ],
  model: ['Модель текста', 'Text model', 'Модель тексту'],
  noBudget: [
    'Лимит исчерпан или зарезервирован.',
    'The cap is spent or reserved.',
    'Ліміт вичерпано або зарезервовано.',
  ],
} as const;
export type LiveMessage = keyof typeof liveMessages;
export function useLiveText() {
  const { locale } = useT();
  return (key: LiveMessage) => liveMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
