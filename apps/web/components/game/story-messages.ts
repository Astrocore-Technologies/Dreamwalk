'use client';
import { useT } from '@/lib/i18n';
export const storyMessages = {
  title: ['История', 'Story', 'Історія'],
  declineLocation: [
    'Продолжить без новой локации',
    'Continue without the new location',
    'Продовжити без нової локації',
  ],
  locationDeclined: [
    'Создание локации «{name}» отменено. Предыдущие действия сохранены.',
    'Location creation cancelled: {name}. Earlier actions are preserved.',
    'Створення локації «{name}» скасовано. Попередні дії збережено.',
  ],
  declineUnknown: [
    'Ответ на отмену ещё не получен. Повторим только ту же отмену, без генерации.',
    'Cancellation result is not known yet. Retry the same cancellation without generating.',
    'Відповідь на скасування ще не отримано. Повторимо лише те саме скасування, без генерації.',
  ],
  locationPreparing: [
    'Подготавливается локация: {name}. Переход произойдёт после готовности карты и текста.',
    'Preparing {name}. Arrival will happen after the map and text are ready.',
    'Готується локація: {name}. Перехід відбудеться після готовності карти й тексту.',
  ],
  locationReady: ['Локация готова: {name}.', 'Location ready: {name}.', 'Локація готова: {name}.'],
  locationFailed: [
    'Переход в {name} не состоялся. Уже выполненная генерация может иметь стоимость; повторная оплата не запускается автоматически.',
    'Travel to {name} did not complete. Completed generation may have a cost; another paid attempt will not start automatically.',
    'Перехід до {name} не відбувся. Уже виконана генерація може мати вартість; повторна оплата не запускається автоматично.',
  ],
  locationUnknown: [
    'Результат генерации {name} уточняется. Новый платный запрос не запускается.',
    'The generation outcome for {name} is being reconciled. No new paid request will start.',
    'Результат генерації {name} уточнюється. Новий платний запит не запускається.',
  ],
  locationImageCost: ['Карта: ', 'Map: ', 'Карта: '],
  locationSeparatePost: [
    'Отправь переход в новое место отдельным действием между звёздочками. Остальные действия и слова можно отправить отдельно; генерация ещё не оплачена.',
    'Send travel to a new place as a separate action between asterisks. Send other actions or speech separately; no generation has been charged.',
    'Надішли перехід до нового місця окремою дією між зірочками. Інші дії та слова можна надіслати окремо; генерацію ще не оплачено.',
  ],
  locationRequiresTurns: [
    'Для создания новой локации с картой и единым подтверждением стоимости включи пошаговые ходы. Переходы в существующие локации доступны и сейчас.',
    'Enable turn-based play to create a new illustrated location with one combined cost approval. Existing locations are available now.',
    'Для створення нової локації з картою та єдиним підтвердженням вартості ввімкни покрокові ходи. Перехід до наявних локацій доступний зараз.',
  ],
  ooc: ['Вне игры', 'Out of character', 'Поза грою'],
  mock: ['Тестовый ведущий', 'Test director', 'Тестовий ведучий'],
  external: ['AI-ведущий', 'AI director', 'AI-ведучий'],
  composer: ['Твой ход', 'Your turn', 'Твій хід'],
  placeholder: [
    '*Осматриваю дверь* Кто проходил здесь последним?',
    '*I inspect the door* Who was the last person here?',
    '*Оглядаю двері* Хто проходив тут останнім?',
  ],
  hint: [
    'Действие — между *звёздочками*, слова — обычным текстом. Попытка станет фактом только после проверки.',
    'Put an attempted action between *asterisks* and speech in plain text. An attempt becomes fact only after validation.',
    'Дія — між *зірочками*, слова — звичайним текстом. Спроба стане фактом лише після перевірки.',
  ],
  scene: ['Ведущему · общая сцена', 'Director · shared scene', 'Ведучому · спільна сцена'],
  director: ['Ведущему', 'To director', 'Ведучому'],
  approach: ['Подойти', 'Approach', 'Підійти'],
  target: ['Собеседник', 'Recipient', 'Співрозмовник'],
  choose: ['Выбрать собеседником', 'Choose as recipient', 'Обрати співрозмовником'],
  clear: ['Обратиться к ведущему', 'Address the director', 'Звернутися до ведучого'],
  whisper: ['Шёпот', 'Whisper', 'Шепіт'],
  missingTarget: [
    'Собеседник недоступен. Выбери видимого NPC; шёпот не станет публичной репликой.',
    'Recipient unavailable. Choose a visible NPC; a whisper will never become public speech.',
    'Співрозмовник недоступний. Обери видимого NPC; шепіт не стане публічною реплікою.',
  ],
  legacyWhisper: ['Шёпот · старое сохранение', 'Whisper · old save', 'Шепіт · старе збереження'],
  legacySpeech: [
    'Это старое сохранение. Для новой системы NPC нужно отдельно включить пошаговые ходы; автоматического перехода нет. Пока сообщение без собеседника адресуется ведущему, а не всем рядом.',
    'This is an old save. The new NPC system requires explicitly enabling turn-based play; saves are not switched automatically. For now, a message without a recipient goes to the director, not everyone nearby.',
    'Це старе збереження. Для нової системи NPC потрібно окремо ввімкнути покрокові ходи; автоматичного переходу немає. Поки повідомлення без співрозмовника адресоване ведучому, а не всім поруч.',
  ],
  legacyChooseWhisper: [
    'В старом сохранении шёпот без собеседника недоступен. Для речи ко всем рядом нужно явно включить пошаговые ходы.',
    'Whispering without a recipient is unavailable in this old save. Speech to everyone nearby requires explicitly enabling turn-based play.',
    'У старому збереженні шепіт без співрозмовника недоступний. Для мови до всіх поруч потрібно явно ввімкнути покрокові ходи.',
  ],
  nearbySpeech: ['Речь рядом', 'Speech nearby', 'Мова поруч'],
  nearbyWhisper: ['Шёпот рядом', 'Nearby whisper', 'Шепіт поруч'],
  areaSpeech: [
    'Речь слышат все в пределах дальности: обычную — до 3 клеток, с ! — до 6, шёпот — до 1. Стены и закрытые двери мешают слышимости.',
    'Everyone in range can hear you: normal speech reaches 3 cells, speech with ! reaches 6, and whispers reach 1. Walls and closed doors block hearing.',
    'Мову чують усі в межах дальності: звичайну — до 3 клітинок, з ! — до 6, шепіт — до 1. Стіни й зачинені двері заважають чутності.',
  ],
  areaWhisper: [
    'Шёпот услышат все, кто рядом: до 1 клетки с учётом препятствий.',
    'Everyone nearby can hear your whisper: within 1 cell, subject to obstacles.',
    'Шепіт почують усі, хто поруч: до 1 клітинки з урахуванням перешкод.',
  ],
  postingRejected: [
    'Не удалось применить сообщение. Изменения не подтверждены.',
    'The message could not be applied. No changes are confirmed.',
    'Не вдалося застосувати повідомлення. Зміни не підтверджені.',
  ],
  send: ['Отправить', 'Send', 'Надіслати'],
  confirm: ['Подтвердить ход', 'Confirm turn', 'Підтвердити хід'],
  dismiss: ['Отмена', 'Cancel', 'Скасувати'],
  estimatedCost: ['Примерно {amount} Искр', 'About {amount} Sparks', 'Приблизно {amount} Іскор'],
  freeTurn: ['Искры не списываются', 'No Sparks charge', 'Іскри не списуються'],
  worldBatchPosting: [
    'Отправь сообщение, затем заверши ход. Обычный ход оплачивается без дополнительного подтверждения: сначала Грёзы, затем Искры. Новая локация с изображением требует отдельного подтверждения.',
    'Send your message, then end your turn. Normal turn costs are charged without another confirmation: Dreams first, then Sparks. A new location with an image requires separate confirmation.',
    'Надішли повідомлення, потім заверши хід. Звичайний хід оплачується без додаткового підтвердження: спочатку Мрії, потім Іскри. Нова локація із зображенням потребує окремого підтвердження.',
  ],
  worldBatchCost: [
    'Отправка бесплатна. Завершение хода запускает обычную генерацию; сначала используются Грёзы, затем Искры.',
    'Posting is free. Ending your turn starts normal generation, using Dreams first, then Sparks.',
    'Надсилання безкоштовне. Завершення ходу запускає звичайну генерацію: спочатку Мрії, потім Іскри.',
  ],
  worldMembersError: [
    'Не удалось проверить участников и владельца кампании. Повторяем проверку; подтверждение генерации пока недоступно.',
    'Could not verify the campaign members and owner. Retrying; generation confirmation is unavailable until verification succeeds.',
    'Не вдалося перевірити учасників і власника кампанії. Повторюємо перевірку; підтвердження генерації поки недоступне.',
  ],
  worldCheckingOwner: [
    'Проверяем владельца кампании…',
    'Checking the campaign owner…',
    'Перевіряємо власника кампанії…',
  ],
  worldOwnerReview: [
    'Идёт ход мира. Обычная генерация запускается после завершения ходов игроков.',
    'The world turn is in progress. Normal generation starts after players end their turns.',
    'Триває хід світу. Звичайна генерація запускається після завершення ходів гравців.',
  ],
  worldCheckingStatus: [
    'Проверяем состояние хода мира…',
    'Checking world-turn status…',
    'Перевіряємо стан ходу світу…',
  ],
  worldManualAuthorization: [
    'Решения NPC ждут ручного разрешения. В этом режиме генерации стандартная смета недоступна; ожидание не означает, что AI уже работает.',
    'NPC decisions await manual authorization. Standard cost confirmation is unavailable in this generation mode; waiting does not mean the AI is running.',
    'Рішення NPC очікують ручного дозволу. У цьому режимі генерації стандартний кошторис недоступний; очікування не означає, що AI вже працює.',
  ],
  worldNoPendingGeneration: [
    'Ожидающей генерации нет. Ход мира завершится после обработки игровых действий.',
    'No generation is pending. The world turn can finish after game actions are processed.',
    'Генерація не очікується. Хід світу завершиться після обробки ігрових дій.',
  ],
  worldProviderUnavailable: [
    'Провайдер AI недоступен. Ход мира не запущен.',
    'The AI provider is unavailable. The world turn has not started.',
    'Провайдер ШІ недоступний. Хід світу не запущено.',
  ],
  worldProviderBudget: [
    'Достигнут лимит расходов на генерацию. Ход мира не запущен.',
    'The generation spending limit has been reached. The world turn has not started.',
    'Досягнуто ліміту витрат на генерацію. Хід світу не запущено.',
  ],
  worldContextBudget: [
    'Контекст хода превышает допустимый размер. Генерация не запущена.',
    'The turn context exceeds the allowed size. Generation has not started.',
    'Контекст ходу перевищує допустимий розмір. Генерацію не запущено.',
  ],
  worldPriceUnverified: [
    'Стоимость генерации не проверена. Ход мира не запущен.',
    'Generation pricing is unverified. The world turn has not started.',
    'Вартість генерації не перевірена. Хід світу не запущено.',
  ],
  worldWalletUnavailable: [
    'Кошелёк Искр недоступен. Ход мира не запущен.',
    'The Sparks wallet is unavailable. The world turn has not started.',
    'Гаманець Іскор недоступний. Хід світу не запущено.',
  ],
  worldGenerationBlocked: [
    'Не удалось запустить ход мира. Проверь баланс и доступность генерации.',
    'The world turn could not start. Check your balance and generation availability.',
    'Не вдалося запустити хід світу. Перевір баланс і доступність генерації.',
  ],
  worldGenerationUnavailable: [
    'Ход мира ожидает обработки. Генерация пока недоступна.',
    'The world turn is waiting for processing. Generation is currently unavailable.',
    'Хід світу очікує обробки. Генерація поки недоступна.',
  ],
  worldEstimate: [
    'Мир готовит следующий ход. Проверь общую стоимость ожидающих решений NPC, ответов и продолжения ведущего.',
    'The world is preparing its next turn. Review the combined cost of pending NPC decisions, replies and the director’s continuation.',
    'Світ готує наступний хід. Перевір загальну вартість очікуваних рішень NPC, відповідей і продовження ведучого.',
  ],
  worldCostForecast: [
    'Ход: примерно {amount} в эквиваленте Искр',
    'Turn: about {amount} Sparks equivalent',
    'Хід: приблизно {amount} в еквіваленті Іскор',
  ],
  worldCostForecastHint: [
    'Предварительно, без анализа карты. Завершение хода оплачивает обычную генерацию: сначала Грёзы, затем Искры.',
    'Preliminary, before map analysis. Ending your turn pays for normal generation: Dreams first, then Sparks.',
    'Попередньо, без аналізу мапи. Завершення ходу оплачує звичайну генерацію: спочатку Мрії, потім Іскри.',
  ],
  worldCostUnavailable: [
    'Стоимость хода пока недоступна',
    'Turn estimate is currently unavailable',
    'Вартість ходу поки недоступна',
  ],
  worldCostUnresolved: [
    'Стоимость прошлого запроса ещё на сверке. Новая генерация приостановлена, повторно подтверждать ход не нужно.',
    'The previous request’s cost is still being reconciled. New generation is paused; do not confirm the turn again.',
    'Вартість попереднього запиту ще на звірці. Нову генерацію призупинено, повторно підтверджувати хід не потрібно.',
  ],
  worldCostTitle: ['Стоимость хода', 'Turn cost', 'Вартість ходу'],
  worldCostCalculating: ['Рассчитываем стоимость…', 'Calculating cost…', 'Розраховуємо вартість…'],
  retryEstimate: ['Повторить расчёт', 'Retry estimate', 'Повторити розрахунок'],
  worldPending: [
    'Мир обдумывает ход…',
    'The world is considering its turn…',
    'Світ обмірковує хід…',
  ],
  replyEstimateChanged: [
    'Ситуация изменилась. Обнови стоимость ответа — сообщение уже отправлено, повторно отправлять его не нужно.',
    'The situation changed. Refresh the reply estimate — your message is already sent and will not be sent again.',
    'Ситуація змінилася. Онови вартість відповіді — повідомлення вже надіслано, повторювати його не потрібно.',
  ],
  refreshEstimate: [
    'Обновить стоимость ответа',
    'Refresh reply estimate',
    'Оновити вартість відповіді',
  ],
  providerEstimateOnly: [
    'Оценка расходов провайдера в Искрах, без списания из кошелька.',
    'Provider cost expressed in Sparks, without a wallet charge.',
    'Оцінка витрат провайдера в Іскрах, без списання з гаманця.',
  ],
  estimatedHold: [
    'Резерв: {amount} Искр. Спишем фактический расход, остаток вернём после сверки.',
    'Hold: {amount} Sparks. We charge actual usage and release the remainder after reconciliation.',
    'Резерв: {amount} Іскор. Спишемо фактичну витрату, решту повернемо після звірки.',
  ],
  requestReserve: [
    'Резерв запроса: {amount} USD. Это плановая сумма; фактический счёт может отличаться.',
    'Request reserve: USD {amount}. This is a planning amount; the actual invoice may differ.',
    'Резерв запиту: {amount} USD. Це планова сума; фактичний рахунок може відрізнятися.',
  ],
  cost: ['Стоимость: {credits} искр', 'Price: {credits} Sparks', 'Вартість: {credits} іскор'],
  replyLanguage: [
    'Язык ответа: {language}',
    'Reply language: {language}',
    'Мова відповіді: {language}',
  ],
  demo: ['DEMO · не реальные деньги', 'DEMO · not real money', 'DEMO · не справжні гроші'],
  ceiling: [
    'Предел внешних расходов: {amount} USD',
    'External spending ceiling: USD {amount}',
    'Межа зовнішніх витрат: {amount} USD',
  ],
  noBound: [
    'Расходы не подтверждены. Отправка недоступна.',
    'Spending bound unverified. Sending is unavailable.',
    'Витрати не підтверджені. Надсилання недоступне.',
  ],
  preview: ['Проверенные попытки', 'Validated action preview', 'Перевірені спроби'],
  changed: [
    'Мир или адресат изменился. Подготовь ход заново; текст сохранён.',
    'The world or recipient changed. Prepare the turn again; your text is retained.',
    'Світ або адресат змінився. Підготуй хід знову; текст збережено.',
  ],
  pending: [
    'Ведущий обдумывает ход…',
    'The director is considering your turn…',
    'Ведучий обмірковує хід…',
  ],
  unknown: [
    'Результат запроса пока неизвестен. Проверяем сохранённый ход без повторной отправки.',
    'The request outcome is unknown. Checking the saved turn without resending it.',
    'Результат запиту поки невідомий. Перевіряємо збережений хід без повторного надсилання.',
  ],
  retrySame: ['Повторить тот же запрос', 'Retry the same request', 'Повторити той самий запит'],
  refresh: ['Проверить результат', 'Check result', 'Перевірити результат'],
  actionConfirm: ['Подтвердить это действие', 'Confirm this action', 'Підтвердити цю дію'],
  decline: ['Не выполнять', 'Do not perform', 'Не виконувати'],
  actionHint: [
    'Предложение ещё не изменило мир. Подтверждение не вызывает модель повторно.',
    'This proposal has not changed the world. Confirmation does not call the model again.',
    'Пропозиція ще не змінила світ. Підтвердження не викликає модель повторно.',
  ],
  generationCost: [
    'Обработка хода: {credits} искр. Подтверждение действия: 0.',
    'Turn processing: {credits} Sparks. Action confirmation: 0.',
    'Обробка ходу: {credits} іскор. Підтвердження дії: 0.',
  ],
  unavailable: [
    'Новые ходы сейчас недоступны. История и сохранение остаются здесь.',
    'New turns are unavailable right now. History and your save remain here.',
    'Нові ходи зараз недоступні. Історія та збереження залишаються тут.',
  ],
  empty: [
    'История продолжится с твоего хода.',
    'The story continues with your turn.',
    'Історія продовжиться з твого ходу.',
  ],
  you: ['Ты', 'You', 'Ти'],
  narrator: ['Ведущий', 'Director', 'Ведучий'],
  nearby: ['Голос рядом', 'Nearby voice', 'Голос поруч'],
  outcome: ['Результат', 'Outcome', 'Результат'],
  legacy: ['Ранее в истории', 'Earlier in the story', 'Раніше в історії'],
  ambiguous: [
    'Уточни, что именно ты хочешь сделать.',
    'Clarify what you want to do.',
    'Уточни, що саме хочеш зробити.',
  ],
  unsupported: [
    'Такое действие пока не поддерживается. Опиши другую попытку.',
    'That action is not supported yet. Describe another attempt.',
    'Таку дію поки не підтримано. Опиши іншу спробу.',
  ],
  walkFirst: [
    'Сначала подойди ближе, нажав на свободное место рядом.',
    'First move closer by clicking a free nearby spot.',
    'Спершу підійди ближче, натиснувши на вільне місце поруч.',
  ],
  clearTarget: [
    'Чтобы продолжить историю мира, убери выбранного собеседника и отправь ход в сцену.',
    'To continue the world’s story, clear the recipient and send the turn to the scene.',
    'Щоб продовжити історію світу, прибери співрозмовника й надішли хід до сцени.',
  ],
  privateExtension: [
    'Шёпот не создаёт общие сцены. Для общего продолжения явно переключись на публичный ход.',
    'Whispers cannot create shared scenes. Explicitly switch to a public turn to continue the shared story.',
    'Шепіт не створює спільні сцени. Для спільного продовження явно перемкнися на публічний хід.',
  ],
  markup: [
    'Проверь пары *звёздочек* вокруг попытки действия.',
    'Check the paired *asterisks* around attempted actions.',
    'Перевір пари *зірочок* навколо спроби дії.',
  ],
  segments: [
    'Сократи ход: не более шести частей действия и речи.',
    'Shorten the turn to at most six action and speech segments.',
    'Скороти хід: не більше шести частин дії та мовлення.',
  ],
  failed: [
    'Ход не применён. Текст сохранён; можно уточнить его.',
    'The turn was not applied. Your text is retained for editing.',
    'Хід не застосовано. Текст збережено для уточнення.',
  ],
  expired: [
    'Предложение истекло. Подготовь новое перед подтверждением.',
    'The quote expired. Prepare a new one before confirming.',
    'Пропозиція спливла. Підготуй нову перед підтвердженням.',
  ],
  newEvents: ['К последним событиям', 'Jump to latest', 'До останніх подій'],
} as const;
export type StoryMessageKey = keyof typeof storyMessages;
export function useStoryText() {
  const { locale } = useT();
  return (key: StoryMessageKey, values: Record<string, string | number> = {}) => {
    let text: string = storyMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
    for (const [name, value] of Object.entries(values))
      text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}
