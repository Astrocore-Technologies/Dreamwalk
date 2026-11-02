'use client';
import { useT } from '@/lib/i18n';
export const liveMessages = {
  walletNotEnabled: [
    'Кошелёк Искр ещё не активирован для этого аккаунта.',
    'The Sparks wallet is not enabled for this account yet.',
    'Гаманець Іскор ще не активовано для цього акаунта.',
  ],
  insufficientSparks: [
    'Недостаточно доступных Искр для генерации.',
    'Not enough available Sparks for generation.',
    'Недостатньо доступних Іскор для генерації.',
  ],
  accountReview: [
    'Расход по предыдущему запросу требует проверки. Резерв сохранён; повтор автоматически не запускается.',
    'A previous request needs a cost review. Its reservation is retained; no automatic retry is made.',
    'Витрати за попереднім запитом потребують перевірки. Резерв збережено; автоматичного повтору немає.',
  ],
  policyChanged: [
    'Настройки генерации изменились. Обновите страницу и получите новую оценку.',
    'Generation settings changed. Refresh and request a new estimate.',
    'Налаштування генерації змінилися. Оновіть сторінку й отримайте нову оцінку.',
  ],
  releaseUnlimited: [
    'Общий потолок расходов не задан. Генерация оплачивается Искрами.',
    'There is no aggregate spending ceiling. Generation is paid with Sparks.',
    'Загальну межу витрат не встановлено. Генерація оплачується Іскрами.',
  ],
  releaseWalletAvailable: ['Доступно в кошельке', 'Available in wallet', 'Доступно в гаманці'],
  releaseTitle: ['Генерация', 'Generation', 'Генерація'],
  releaseReady: ['Генерация доступна', 'Generation is available', 'Генерація доступна'],
  releaseUnavailable: [
    'Генерация сейчас недоступна',
    'Generation is currently unavailable',
    'Генерація зараз недоступна',
  ],
  releaseBilling: [
    'Стоимость показывается в Искрах перед запуском. Резерв удерживается до получения результата; повтор неизвестного запроса не запускается автоматически.',
    'The Sparks cost is shown before generation. A reservation remains until the outcome is known; uncertain requests are never retried automatically.',
    'Вартість показується в Іскрах перед запуском. Резерв утримується до отримання результату; запит із невідомим результатом не повторюється автоматично.',
  ],
  countSucceeded: ['Подсчёт сохранён', 'Count saved', 'Підрахунок збережено'],
  countDispatched: ['Подсчёт выполняется', 'Count in progress', 'Підрахунок виконується'],
  countUnknown: [
    'Результат или расход неизвестен; повторы остановлены',
    'Outcome or spend unknown; retries stopped',
    'Результат або витрати невідомі; повтори зупинено',
  ],
  countOverflow: [
    'Контекст превышает выбранное окно',
    'Context exceeds the selected window',
    'Контекст перевищує вибране вікно',
  ],
  countStale: [
    'Подсчёт устарел и не применён',
    'Count is stale and was not adopted',
    'Підрахунок застарів і не застосований',
  ],
  countErased: ['Приватные данные удалены', 'Private input erased', 'Приватні дані видалено'],

  countTitle: [
    'Точный подсчёт контекста',
    'Exact context preflight',
    'Точний підрахунок контексту',
  ],
  countIntro: [
    'Отдельный ручной запрос передаёт полный разрешённый контекст OpenAI. Чтение панели ничего не отправляет.',
    'A separate manual request sends the full permitted context to OpenAI. Reading this panel sends nothing.',
    'Окремий ручний запит передає повний дозволений контекст OpenAI. Перегляд панелі нічого не надсилає.',
  ],
  countInvoice: [
    'Точный подсчёт токенов не означает точную стоимость счёта. Цена подсчёта требует отдельной проверки и принятой ревизии политики.',
    'Exact token counting does not mean an exact invoice. Counting needs separately reviewed pricing and an accepted policy revision.',
    'Точний підрахунок токенів не означає точну суму рахунку. Ціна підрахунку потребує окремої перевірки та прийнятої ревізії політики.',
  ],
  countPrice: [
    'Резерв отдельного подсчёта',
    'Separate count reserve',
    'Резерв окремого підрахунку',
  ],
  countPriceUnknown: [
    'Цена подсчёта не проверена: настоящий вызов заблокирован.',
    'Count pricing is unreviewed: real dispatch is blocked.',
    'Ціну підрахунку не перевірено: справжній виклик заблоковано.',
  ],
  countPricingEvidence: [
    'Источник и даты цены подсчёта',
    'Count price source and dates',
    'Джерело та дати ціни підрахунку',
  ],
  countHistoryLimit: [
    'Последних записей истории (пусто — все; обязательные сохраняются)',
    'Recent history records (blank means all; required records remain)',
    'Останніх записів історії (порожньо — усі; обов’язкові зберігаються)',
  ],
  countConsent: [
    'Разрешаю один подсчёт с показанным отдельным резервом. Это не запуск ответа.',
    'I authorize one count with the displayed separate reserve. This does not generate a reply.',
    'Дозволяю один підрахунок із показаним окремим резервом. Це не генерація відповіді.',
  ],
  countRun: ['Посчитать один раз', 'Count once', 'Порахувати один раз'],
  countResult: ['Результат подсчёта', 'Count result', 'Результат підрахунку'],
  countReconcile: [
    'Узнать результат без повтора',
    'Check result without retry',
    'Перевірити результат без повтору',
  ],
  countApproximate: [
    'Для короткого теста можно оставить приблизительную оценку. При переполнении уменьшите историю и явно запросите новый подсчёт; не более трёх на запрос.',
    'Approximate counting remains available for a short test. On overflow, reduce history and explicitly request another count; at most three per request.',
    'Для короткого тесту можна залишити приблизну оцінку. За переповнення зменште історію та явно замовте новий підрахунок; не більше трьох на запит.',
  ],

  contextModelCapacity: [
    'Ёмкость контекста модели',
    'Model context capacity',
    'Місткість контексту моделі',
  ],
  contextRequested: [
    'Выбранное окно на запрос, включая ответ',
    'Requested window per request, including reply',
    'Вибране вікно на запит, включно з відповіддю',
  ],
  contextEffective: [
    'Доступное окно с учётом модели',
    'Effective window within model capacity',
    'Доступне вікно з урахуванням моделі',
  ],
  contextAnswer: [
    'Отдельный предел ответа, токенов',
    'Separate reply limit, tokens',
    'Окрема межа відповіді, токенів',
  ],
  contextEstimate: [
    'Консервативная оценка полного запроса; точный токенизатор для этой модели не подключён. Доступная история может быть короче лимита фактических токенов.',
    'Conservative complete-request estimate; an exact tokenizer for this model is not connected. Available history may be shorter than the actual-token limit.',
    'Консервативна оцінка повного запиту; точний токенізатор для цієї моделі не підключений. Доступна історія може бути коротшою за межу фактичних токенів.',
  ],
  contextExact: [
    'Точный подсчёт полного запроса',
    'Exact complete-request count',
    'Точний підрахунок повного запиту',
  ],
  contextHistory: [
    'Это окно одного запроса, не квота игры и не стоимость. История сохраняется; при переполнении выбираются целые разрешённые записи, существующая память, канон и последние события. Автоматических платных сводок нет.',
    'This is a per-request window, not a game quota or a price. History stays saved; overflow selects whole permitted records, existing memory, canon and recent events. No automatic paid summaries.',
    'Це вікно одного запиту, а не квота гри чи вартість. Історія зберігається; при переповненні відбираються цілі дозволені записи, наявна памʼять, канон і останні події. Автоматичних платних підсумків немає.',
  ],
  policyClosePending: [
    'Закрыть просмотр; операция не отменяется',
    'Close review; the operation is not cancelled',
    'Закрити перегляд; операція не скасовується',
  ],

  requestReserveConsent: [
    'Разрешаю только этот запрос с показанным расчётным резервом. Он не ограничивает счёт провайдера.',
    'I approve only this request with the displayed planning reserve. It does not cap the provider invoice.',
    'Дозволяю лише цей запит із показаним розрахунковим резервом. Він не обмежує рахунок провайдера.',
  ],

  reserveTextOutput: ['Вывод текста', 'Text output', 'Виведення тексту'],
  reserveBodyBytes: ['Полный запрос, байтов', 'Serialized request bytes', 'Повний запит, байтів'],
  reserveInputTokens: [
    'Оценка входных токенов',
    'Estimated input tokens',
    'Оцінка вхідних токенів',
  ],
  policyEstimator: [
    'Все параметры расчёта резерва',
    'Complete reserve estimator settings',
    'Усі параметри розрахунку резерву',
  ],

  policyRetry: [
    'Повторить ту же проверенную операцию',
    'Retry the same reviewed operation',
    'Повторити ту саму перевірену операцію',
  ],
  reserveTextInput: ['Ввод текста', 'Text input', 'Введення тексту'],
  reserveImageInput: ['Ввод референсов', 'Reference input', 'Введення референсів'],
  reserveImageOutput: ['Вывод изображения', 'Image output', 'Виведення зображення'],

  policyModel: ['Модель', 'Model', 'Модель'],
  policyTotal: ['Всего', 'Total', 'Усього'],
  policyTitle: [
    'Пересмотр политики генерации',
    'Generation policy review',
    'Перегляд політики генерації',
  ],
  policyOpen: [
    'Проверить политику и изменения',
    'Review policy and changes',
    'Перевірити політику та зміни',
  ],
  policyCurrent: ['Действующая политика', 'Active policy', 'Чинна політика'],
  policyProposed: ['Предложенная политика', 'Proposed policy', 'Запропонована політика'],
  policyField: ['Условие', 'Setting', 'Умова'],
  policyNoProposal: [
    'Новых условий для применения нет.',
    'There are no proposed changes to apply.',
    'Нових умов для застосування немає.',
  ],
  policyUnknownProfile: [
    'Прежний профиль недоступен. Старые цены не восстанавливаются предположениями.',
    'The previous profile is unavailable. Historical prices are not reconstructed by guessing.',
    'Попередній профіль недоступний. Старі ціни не відновлюються припущеннями.',
  ],
  policyNoActive: [
    'Сначала подтвердите исходную конфигурацию владельца.',
    'Acknowledge the initial owner configuration first.',
    'Спочатку підтвердьте початкову конфігурацію власника.',
  ],
  policyRevision: ['Версия', 'Revision', 'Версія'],
  policyHistory: ['История подтверждений', 'Acknowledgement history', 'Історія підтверджень'],
  policyEvidence: ['Источник цен', 'Pricing evidence', 'Джерело цін'],
  policyReviewed: ['Цены проверены', 'Pricing reviewed', 'Ціни перевірено'],
  policyValidUntil: ['Цены действуют до', 'Pricing valid until', 'Ціни чинні до'],
  policyText: ['Текст', 'Text', 'Текст'],
  policyImage: ['Изображения', 'Images', 'Зображення'],
  policyTextCap: ['Лимит текста', 'Text cap', 'Ліміт тексту'],
  policyImageCap: ['Лимит изображений', 'Image cap', 'Ліміт зображень'],
  policyInputRate: [
    'Ввод за миллион токенов',
    'Input per million tokens',
    'Введення за мільйон токенів',
  ],
  policyOutputRate: [
    'Вывод за миллион токенов',
    'Output per million tokens',
    'Виведення за мільйон токенів',
  ],
  policyImageInputRate: [
    'Ввод изображений за миллион токенов',
    'Image input per million tokens',
    'Введення зображень за мільйон токенів',
  ],
  policyContext: ['Контекст, токенов', 'Context tokens', 'Токени контексту'],
  policyOutputTokens: [
    'Максимум выходных токенов',
    'Maximum output tokens',
    'Максимум вихідних токенів',
  ],
  policyInputBytes: ['Максимум байтов ввода', 'Maximum input bytes', 'Максимум байтів введення'],
  policyImageProfile: [
    'Размер / качество / число изображений',
    'Size / quality / image count',
    'Розмір / якість / кількість зображень',
  ],
  policyReferences: ['Максимум референсов', 'Maximum references', 'Максимум референсів'],
  policyLiabilities: [
    'Сохранённые обязательства',
    'Existing liabilities',
    'Збережені зобов’язання',
  ],
  policyUnchanged: [
    'Применение условий не сбрасывает расходы, резервы или неизвестные списания. Старые запросы сохраняют свои снимки условий.',
    'Applying a policy does not reset spending, reservations or unknown charges. Existing requests retain their policy snapshots.',
    'Застосування умов не скидає витрати, резерви чи невідомі списання. Попередні запити зберігають свої знімки умов.',
  ],
  policyUnknown: ['Неизвестные списания', 'Unknown charges', 'Невідомі списання'],
  policyAccounted: ['Всего учтено', 'Total accounted', 'Усього враховано'],
  policyConsent: [
    'Я сравнил модели, цены, лимиты и сроки подтверждения. Разрешаю только показанную новую версию; прежние обязательства сохраняются.',
    'I reviewed the models, rates, caps and evidence dates. I authorize only this displayed revision; existing liabilities remain.',
    'Я порівняв моделі, ціни, ліміти та дати підтвердження. Дозволяю лише показану нову версію; попередні зобов’язання зберігаються.',
  ],
  policyApply: [
    'Применить проверенную версию',
    'Apply reviewed revision',
    'Застосувати перевірену версію',
  ],
  policyClose: ['Закрыть без применения', 'Close without applying', 'Закрити без застосування'],
  policyApplied: [
    'Новая версия подтверждена. Условия обновлены без сброса обязательств.',
    'The new revision is acknowledged. Existing liabilities were preserved.',
    'Нову версію підтверджено. Попередні зобов’язання збережено.',
  ],
  policyPending: [
    'Ответ о применении неизвестен. Проверяйте результат по тому же идентификатору; повторное применение не отправляется.',
    'The apply result is uncertain. Check the same operation; no second apply request is sent.',
    'Результат застосування невідомий. Перевіряйте ту саму операцію; повторний запит не надсилається.',
  ],
  policyReconcile: [
    'Проверить результат применения',
    'Check apply result',
    'Перевірити результат застосування',
  ],
  policyNotFound: [
    'Применение пока не подтверждено. Это не гарантирует отмену; новый запрос не отправляется.',
    'The apply is not confirmed yet. This does not prove cancellation; no new request is sent.',
    'Застосування ще не підтверджено. Це не гарантує скасування; новий запит не надсилається.',
  ],
  policyStale: [
    'Условия изменились. Загрузите и проверьте их заново перед подтверждением.',
    'The policy changed. Reload and review it again before confirming.',
    'Умови змінилися. Завантажте й перевірте їх знову перед підтвердженням.',
  ],
  reserveTitle: ['Резерв этого запроса', 'This request’s reserve', 'Резерв цього запиту'],
  reserveEstimate: ['Расчётная стоимость', 'Planning estimate', 'Орієнтовна вартість'],
  reserveMargin: ['Процентный запас', 'Percentage margin', 'Відсотковий запас'],
  reserveFixed: ['Фиксированный запас', 'Fixed margin', 'Фіксований запас'],
  reserveReferences: ['Запас для референсов', 'Reference allowance', 'Запас для референсів'],
  reserveTotal: ['Итого резерв', 'Total reserve', 'Усього резерв'],
  reserveLegacy: [
    'Использован прежний фиксированный резерв; детализация расчёта недоступна.',
    'This request uses a legacy fixed reserve; an itemized estimate is unavailable.',
    'Використано попередній фіксований резерв; деталізація розрахунку недоступна.',
  ],
  reserveNotCap: [
    'Оценка и запас не являются пределом счёта провайдера. Неизвестные списания остаются зарезервированными.',
    'The estimate and margin do not cap the provider invoice. Unknown charges remain reserved.',
    'Оцінка та запас не обмежують рахунок провайдера. Невідомі списання залишаються зарезервованими.',
  ],
  reserveReferenceRisk: [
    'Стоимость обработки референсов неопределённа. Проверьте отдельное подтверждение риска перед отправкой изображения.',
    'Reference processing cost is uncertain. Review the separate image risk consent before dispatch.',
    'Вартість обробки референсів невизначена. Перевірте окреме підтвердження ризику перед надсиланням зображення.',
  ],
  reservePrompt: ['Размер описания, байтов', 'Prompt bytes', 'Розмір опису, байтів'],
  reserveReferenceCount: ['Число референсов', 'Reference count', 'Кількість референсів'],
  reserveUnavailable: ['Недоступно', 'Unavailable', 'Недоступно'],

  textRemaining: ['Доступно для текста', 'Available for text', 'Доступно для тексту'],
  imageRemaining: ['Доступно для изображений', 'Available for images', 'Доступно для зображень'],
  ownerTitle: ['Генерация на сервере', 'Server generation', 'Генерація на сервері'],
  adminOwner: [
    'Настроена генерация на частном сервере владельца. Бюджет и разрешения показаны ниже; каждый внешний запрос требует отдельного согласия.',
    'Generation is configured on the owner’s private server. Budget and authorization are shown below; each external request requires separate consent.',
    'Генерацію налаштовано на приватному сервері власника. Бюджет і дозволи показано нижче; кожен зовнішній запит потребує окремої згоди.',
  ],
  ownerProfiles: [
    'Каталог не включает внешние запросы. Модели, ключи и бюджет настраиваются владельцем на сервере; секреты в браузер не передаются.',
    'The catalog does not enable external requests. The owner configures models, keys and budget on the server; secrets are never sent to the browser.',
    'Каталог не вмикає зовнішні запити. Власник налаштовує моделі, ключі й бюджет на сервері; секрети не передаються до браузера.',
  ],
  ownerIntro: [
    'Обычная конфигурация сервера, не временный API-тест. Открытие панели не запускает ИИ. Каждый запрос требует отдельного подтверждения.',
    'Normal server configuration, not a temporary API test. Opening this panel does not call AI. Every request requires separate consent.',
    'Звичайна конфігурація сервера, а не тимчасовий API-тест. Відкриття панелі не запускає ШІ. Кожен запит потребує окремої згоди.',
  ],
  ownerClaimConsent: [
    'Я владелец этой конфигурации. Принимаю общий бюджет, включая прежние удержания и неизвестные списания. Каждый запрос подтвержу отдельно.',
    'I own this configuration. I acknowledge the combined budget, including prior reservations and unknown charges. I will approve each request separately.',
    'Я власник цієї конфігурації. Приймаю загальний бюджет, включно з попередніми утриманнями та невідомими списаннями. Кожен запит підтверджу окремо.',
  ],
  ownerClaim: [
    'Подтвердить бюджет владельца',
    'Authorize owner budget',
    'Підтвердити бюджет власника',
  ],
  ownerActive: [
    'Разрешение владельца активно',
    'Owner authorization active',
    'Дозвіл власника активний',
  ],
  ownerUnclaimed: [
    'Настроено; бюджет ещё не подтверждён',
    'Configured; budget not yet authorized',
    'Налаштовано; бюджет ще не підтверджено',
  ],
  ownerStopped: ['Генерация приостановлена', 'Generation stopped', 'Генерацію призупинено'],
  ownerDuration: [
    'Разрешение владельца без таймера сессии. Свежесть тарифов, бюджет, права и согласие проверяются отдельно для каждого запроса.',
    'Owner authorization has no session timer. Pricing freshness, budget, access and consent are checked separately for every request.',
    'Дозвіл власника не має таймера сесії. Актуальність тарифів, бюджет, права й згода перевіряються окремо для кожного запиту.',
  ],
  pricingExpiry: ['Тарифы подтверждены до', 'Pricing verified until', 'Тарифи підтверджено до'],
  pricingExpired: [
    'Тарифы устарели. Запросы недоступны до обновления конфигурации.',
    'Pricing is stale. Requests are unavailable until configuration is updated.',
    'Тарифи застаріли. Запити недоступні до оновлення конфігурації.',
  ],
  unavailableTitle: ['Генерация недоступна', 'Generation unavailable', 'Генерація недоступна'],
  unavailable: [
    'Конфигурация сервера недоступна или не разрешена для этого аккаунта. Внешние запросы не запускаются; подмены образцом нет.',
    'Server configuration is unavailable or not authorized for this account. External requests will not run; no sample fallback is used.',
    'Конфігурація сервера недоступна або не дозволена для цього акаунта. Зовнішні запити не запускаються; підміни прикладом немає.',
  ],
  imageUnavailable: [
    'Внешние изображения недоступны. Проверь настройки и код причины.',
    'External images are unavailable. Check the configuration and reason code.',
    'Зовнішні зображення недоступні. Перевір налаштування й код причини.',
  ],

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
