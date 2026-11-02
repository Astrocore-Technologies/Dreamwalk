'use client';
import { useT } from '@/lib/i18n';
export const generationMessages = {
  releaseBlocked: [
    'Генерация сейчас недоступна. Проверьте баланс Искр и сообщение об ошибке.',
    'Generation is currently unavailable. Check your Sparks balance and the error message.',
    'Генерація зараз недоступна. Перевірте баланс Іскор і повідомлення про помилку.',
  ],
  ownerReferencesUnavailable: [
    'Настроенный профиль изображений принимает только текст. Концепты по фото и части пакета с изображениями-референсами недоступны. Референсы не удаляются, образцы не подставляются.',
    'The configured image profile accepts text only. Photo concepts and reference-dependent package parts are unavailable. References are not removed and samples are not substituted.',
    'Налаштований профіль зображень приймає лише текст. Концепти за фото й частини пакета із зображеннями-референсами недоступні. Референси не видаляються, приклади не підставляються.',
  ],
  ownerReferenceStage: [
    'Этой стадии нужен референс, который текущий профиль не поддерживает. Можно выбрать разрешённую готовую версию; платный запрос недоступен.',
    'This stage needs a reference that the current profile does not support. A permitted existing revision can be selected; a paid request is unavailable.',
    'Цей етап потребує референсу, який поточний профіль не підтримує. Можна вибрати дозволену готову версію; платний запит недоступний.',
  ],

  ownerBlocked: [
    'Генерация недоступна. Проверь конфигурацию сервера, разрешение владельца и остаток бюджета. Образцы не подставляются автоматически.',
    'Generation is unavailable. Check server configuration, owner authorization and remaining budget. Samples are never substituted automatically.',
    'Генерація недоступна. Перевір конфігурацію сервера, дозвіл власника й залишок бюджету. Приклади не підставляються автоматично.',
  ],
  estimateNotice: [
    'Оценка и резерв не ограничивают счёт провайдера; он может быть выше.',
    'The estimate and reserve do not cap the provider invoice; it may be higher.',
    'Оцінка й резерв не обмежують рахунок провайдера; він може бути вищим.',
  ],
  estimateRiskConsent: [
    'Отдельно принимаю риск: оценка и резерв не ограничивают счёт провайдера, он может быть выше. Неизвестное списание остановит дальнейшие запросы.',
    'I separately accept the risk: the estimate and reserve do not cap the provider invoice, which may be higher. An unknown charge will stop further requests.',
    'Окремо приймаю ризик: оцінка й резерв не обмежують рахунок провайдера, він може бути вищим. Невідоме списання зупинить подальші запити.',
  ],
  estimateRequestConsent: [
    'У меня есть права на референсы. Разрешаю только этот внешний запрос и передачу выбранного приватного фото; автоматического повтора не будет.',
    'I have rights to the references. I authorize only this external request and transfer of the selected private photo; no automatic retry will occur.',
    'Маю права на референси. Дозволяю лише цей зовнішній запит і передавання вибраного приватного фото; автоматичного повтору не буде.',
  ],

  httpStatus: ['Статус HTTP', 'HTTP status', 'Стан HTTP'],
  planningEstimate: [
    'Плановая оценка, не потолок счёта',
    'Planning estimate, not an invoice cap',
    'Планова оцінка, а не межа рахунку',
  ],
  operationalReserve: ['Операционный резерв', 'Operational reserve', 'Операційний резерв'],
  noInvoiceCap: [
    'Резерв не ограничивает счёт провайдера. Отправка отключена: подтверждённая полная верхняя граница отсутствует.',
    'The reservation does not cap the provider invoice. Dispatch is disabled because a verified full upper bound is unavailable.',
    'Резерв не обмежує рахунок провайдера. Надсилання вимкнено, бо перевірена повна верхня межа відсутня.',
  ],
  'dispatch-prepared': [
    'Исход отправки ещё не подтверждён. Обнови статус; новый платный запрос недоступен.',
    'Dispatch outcome is not confirmed. Refresh status; a new paid request is unavailable.',
    'Результат надсилання ще не підтверджено. Онови стан; новий платний запит недоступний.',
  ],
  externalArtwork: ['Сгенерированная графика', 'Generated artwork', 'Згенерована графіка'],
  mode: ['Источник графики', 'Artwork source', 'Джерело графіки'],
  fixture: [
    'Бесплатный рисованный образец',
    'Free drawn sample',
    'Безкоштовний мальований приклад',
  ],
  external: [
    'Внешний API — отдельное согласие на каждый запрос',
    'External API — consent for each request',
    'Зовнішній API — згода на кожен запит',
  ],
  externalNote: [
    'Внешний проект не подменяется образцом. Каждый рисунок требует отдельной оценки, согласия и проверки; отмена не гарантирует отмену списания.',
    'An external project never falls back to sample art. Each image requires its own estimate, consent and review; cancellation does not guarantee reversal of a charge.',
    'Зовнішній проєкт не підміняється прикладом. Кожне зображення потребує окремої оцінки, згоди й перевірки; скасування не гарантує повернення списання.',
  ],
  photoTransfer: [
    'При подтверждении внешнего запроса приватное фото может быть передано настроенному провайдеру как референс. Это не разрешает публикацию фото или чужое использование результата.',
    'Approving an external request may send the private photo to the configured provider as a reference. It does not permit publishing the photo or others reusing the output.',
    'Підтвердження зовнішнього запиту може передати приватне фото налаштованому провайдеру як референс. Це не дозволяє публікувати фото чи повторно використовувати результат іншим.',
  ],
  create: [
    'Сохранить проект для внешней генерации',
    'Save external generation project',
    'Зберегти проєкт зовнішньої генерації',
  ],
  plan: [
    'План — редактируемый шаблон, не результат ИИ. Проходимость и правила задаёт сервер; графика их не меняет.',
    'The plan is an editable template, not AI output. The server defines reachability and rules; artwork does not change them.',
    'План — редагований шаблон, а не результат ШІ. Прохідність і правила визначає сервер; графіка їх не змінює.',
  ],
  stages: ['Стадии внешней генерации', 'External generation stages', 'Етапи зовнішньої генерації'],
  manual: [
    'Обновление статуса не запускает генерацию. После ошибки или неизвестного списания новый запрос автоматически не создаётся.',
    'Refreshing status does not generate images. Failures and unknown charges never create a new request automatically.',
    'Оновлення стану не запускає генерацію. Помилки та невідомі списання ніколи не створюють новий запит автоматично.',
  ],
  refresh: ['Обновить стадии', 'Refresh stages', 'Оновити етапи'],
  blocked: [
    'Внешняя генерация сейчас недоступна. Подтверждённая граница стоимости и активная ручная сессия обязательны.',
    'External generation is currently unavailable. A verified cost bound and an active manual session are required.',
    'Зовнішня генерація зараз недоступна. Перевірена межа вартості й активна ручна сесія обов’язкові.',
  ],
  quote: ['Получить оценку этого рисунка', 'Estimate this image', 'Оцінити це зображення'],
  upper: ['Верхняя оценка', 'Upper estimate', 'Верхня оцінка'],
  expires: ['Оценка действует до', 'Estimate expires', 'Оцінка діє до'],
  expired: [
    'Оценка истекла. Новая оценка не отправляет запрос провайдеру.',
    'The estimate expired. A new estimate does not call the provider.',
    'Термін оцінки минув. Нова оцінка не надсилає запит провайдеру.',
  ],
  consent: [
    'У меня есть права на указанные референсы. Разрешаю только этот внешний запрос в пределах оценки, включая передачу выбранного приватного фото.',
    'I have rights to the specified references. I authorize only this external request up to its estimate, including transfer of the selected private photo.',
    'Я маю права на зазначені референси. Дозволяю лише цей зовнішній запит у межах оцінки, включно з передаванням вибраного приватного фото.',
  ],
  dispatch: ['Отправить один запрос', 'Dispatch one request', 'Надіслати один запит'],
  cancelJob: [
    'Запросить отмену задания',
    'Request job cancellation',
    'Запросити скасування завдання',
  ],
  held: ['Удерживается', 'Reserved', 'Утримується'],
  actual: ['Учтено провайдером', 'Provider reported', 'Враховано провайдером'],
  unknown: [
    'Исход или списание неизвестны. Удержание сохраняется. Обнови статус; повторная генерация недоступна.',
    'The outcome or charge is unknown. Its reservation remains. Refresh status; regeneration is unavailable.',
    'Результат або списання невідомі. Утримання зберігається. Онови стан; повторна генерація недоступна.',
  ],
  failure: [
    'Действие не выполнено. Проверь код и состояние задания.',
    'The action did not complete. Check the code and job state.',
    'Дію не виконано. Перевір код і стан завдання.',
  ],
  valid: [
    'Структурная проверка пройдена',
    'Structural validation passed',
    'Структурну перевірку пройдено',
  ],
  invalid: [
    'Результат не прошёл проверку и не готов к игре',
    'The result failed validation and is not playable',
    'Результат не пройшов перевірку й не готовий до гри',
  ],
  review: [
    'Автопроверка не подтверждает красоту и согласованность. Осмотри все части перед сохранением набора.',
    'Automatic checks do not verify visual quality or consistency. Review every part before saving the package.',
    'Автоперевірка не підтверджує красу та узгодженість. Оглянь усі частини перед збереженням набору.',
  ],
  reviewCharacter: [
    'Я проверил лицо, одежду, прозрачность и все 24 кадра четырёх направлений. Части согласованы.',
    'I reviewed the face, outfit, transparency and all 24 frames across four directions. The parts are consistent.',
    'Я перевірив обличчя, одяг, прозорість та всі 24 кадри чотирьох напрямків. Частини узгоджені.',
  ],
  reviewLocation: [
    'Я проверил фон, отдельные предметы, глубину и персонажей. Графика согласована с подтверждённым планом.',
    'I reviewed the background, separate objects, depth and characters. The art is consistent with the approved plan.',
    'Я перевірив тло, окремі предмети, глибину й персонажів. Графіка узгоджена з підтвердженим планом.',
  ],
  complete: ['Сохранить проверенный набор', 'Save reviewed package', 'Зберегти перевірений набір'],
  approveNeeded: [
    'Сначала требуется готовый и проверенный концепт; затем можно подтвердить образ.',
    'An admitted and validated concept is required before approval.',
    'Перед підтвердженням потрібен готовий концепт, що пройшов перевірку.',
  ],
  candidates: ['Кандидаты библиотеки', 'Library candidates', 'Кандидати бібліотеки'],
  candidateNote: [
    'Совместимость размера и камеры не означает соответствие истории. Проверь образ и стиль отдельно. Здесь можно использовать только собственный набор.',
    'Size and camera compatibility do not establish story relevance. Review appearance and style separately. Only owned revisions can be used here.',
    'Сумісність розміру й камери не означає відповідності історії. Окремо перевір образ і стиль. Тут можна використати лише власні версії.',
  ],
  semantic: [
    'Я проверил соответствие этого рисунка истории и образу.',
    'I reviewed this image for story and appearance consistency.',
    'Я перевірив відповідність цього зображення історії та образу.',
  ],
  reuse: [
    'Использовать собственную версию бесплатно',
    'Use owned revision for free',
    'Використати власну версію безкоштовно',
  ],
  declineReuse: [
    'Просмотрел кандидатов и хочу получить отдельную оценку нового рисунка.',
    'I reviewed the candidates and want an estimate for a new image.',
    'Я переглянув кандидатів і хочу отримати окрему оцінку нового зображення.',
  ],
  idle: ['Ещё не запрошено', 'Not requested', 'Ще не запитано'],
  prepared: ['Подготовлено', 'Prepared', 'Підготовлено'],
  quoted: ['Оценка готова', 'Estimate ready', 'Оцінка готова'],
  queued: ['В очереди', 'Queued', 'У черзі'],
  dispatched: ['Отправлено', 'Dispatched', 'Надіслано'],
  generated: ['Получено, идёт проверка', 'Received, validating', 'Отримано, перевіряється'],
  admitted: ['Принято в библиотеку', 'Admitted to library', 'Прийнято до бібліотеки'],
  reused: ['Использована собственная версия', 'Owned revision reused', 'Використано власну версію'],
  rejected: ['Отклонено', 'Rejected', 'Відхилено'],
  cancelled: ['Отменено', 'Cancelled', 'Скасовано'],
  cancel_requested: ['Отмена запрошена', 'Cancellation requested', 'Скасування запитано'],
  concept: ['Концепт полного роста', 'Full-body concept', 'Концепт на повний зріст'],
  portrait: ['Портрет', 'Portrait', 'Портрет'],
  sheet: [
    'Прозрачный атлас: 4 направления, 24 кадра',
    'Transparent atlas: 4 directions, 24 frames',
    'Прозорий атлас: 4 напрямки, 24 кадри',
  ],
  background: ['Фон мастерской', 'Atelier background', 'Тло майстерні'],
  'annex-background': ['Фон второй комнаты', 'Annex background', 'Тло другої кімнати'],
  table: ['Стол', 'Table', 'Стіл'],
  counter: ['Прилавок', 'Counter', 'Прилавок'],
  shelf: ['Стеллаж', 'Shelf', 'Стелаж'],
  plant: ['Растение', 'Plant', 'Рослина'],
  rug: ['Ковёр', 'Rug', 'Килим'],
  'door-open': ['Открытая дверь', 'Open door', 'Відчинені двері'],
  'door-closed': ['Закрытая дверь', 'Closed door', 'Зачинені двері'],
  'sample-sheet': ['Атлас героя предпросмотра', 'Preview hero atlas', 'Атлас героя перегляду'],
  'quest-item': ['Предмет цели', 'Quest item', 'Предмет мети'],
  'npc-sheet': ['Атлас NPC', 'NPC atlas', 'Атлас NPC'],
} as const;
export type GenerationMessage = keyof typeof generationMessages;
export function useGenerationText() {
  const { locale } = useT();
  return (key: GenerationMessage) =>
    generationMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
