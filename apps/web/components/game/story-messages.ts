'use client';
import { useT } from '@/lib/i18n';
export const storyMessages = {
  title: ['История', 'Story', 'Історія'],
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
  chooseWhisper: [
    'Для шёпота выбери NPC на сцене.',
    'Select an NPC in the scene to whisper.',
    'Для шепоту обери NPC на сцені.',
  ],
  send: ['Отправить', 'Send', 'Надіслати'],
  confirm: ['Подтвердить ход', 'Confirm turn', 'Підтвердити хід'],
  dismiss: ['Отмена', 'Cancel', 'Скасувати'],
  estimatedCost: ['Примерно {amount} Искр', 'About {amount} Sparks', 'Приблизно {amount} Іскор'],
  freeTurn: ['Искры не списываются', 'No Sparks charge', 'Іскри не списуються'],
  worldBatchPosting: [
    'Сообщение фиксирует твои слова и проверенные действия без платы за генерацию. После завершения ходов игроков решения NPC, их ответы и продолжение ведущего оцениваются вместе.',
    'Posting records your speech and validated actions without a generation charge. After players end their turns, NPC decisions, replies and the director’s continuation are estimated together.',
    'Повідомлення фіксує твої слова й перевірені дії без плати за генерацію. Після завершення ходів гравців рішення NPC, їхні відповіді та продовження ведучого оцінюються разом.',
  ],
  worldBatchCost: [
    'За отправку Искры не списываются. Ответы мира ждут завершения ходов игроков и отдельного подтверждения общей стоимости.',
    'Posting costs no Sparks. World responses wait for players to end their turns and for approval of the combined cost.',
    'За надсилання Іскри не списуються. Відповіді світу чекають завершення ходів гравців і окремого підтвердження загальної вартості.',
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
    'Идёт ход мира. Если дополнительные ответы ждут согласия, их стоимость подтверждает владелец кампании.',
    'The world turn is in progress. The campaign owner reviews the cost of any additional responses awaiting consent.',
    'Триває хід світу. Якщо додаткові відповіді очікують згоди, їхню вартість підтверджує власник кампанії.',
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
  worldGenerationUnavailable: [
    'Ход мира ещё ожидает обработки. Сейчас нет доступной сметы для подтверждения; это не подтверждает запуск AI.',
    'The world turn is still waiting. No cost estimate is currently available to confirm; this does not confirm that AI work has started.',
    'Хід світу ще очікує обробки. Зараз немає доступного кошторису для підтвердження; це не підтверджує запуск AI.',
  ],
  worldEstimate: [
    'Мир готовит следующий ход. Проверь общую стоимость ожидающих решений NPC, ответов и продолжения ведущего.',
    'The world is preparing its next turn. Review the combined cost of pending NPC decisions, replies and the director’s continuation.',
    'Світ готує наступний хід. Перевір загальну вартість очікуваних рішень NPC, відповідей і продовження ведучого.',
  ],
  estimateWorld: ['Узнать стоимость', 'Estimate cost', 'Дізнатися вартість'],
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
