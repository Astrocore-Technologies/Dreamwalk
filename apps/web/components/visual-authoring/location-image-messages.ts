'use client';
import { useT } from '@/lib/i18n';
export const locationImageMessages = {
  profileEstimate: [
    'Пример оценки профиля; запрос рассчитывается отдельно',
    'Profile example estimate; each request is calculated separately',
    'Приклад оцінки профілю; кожен запит розраховується окремо',
  ],
  profileReserve: ['Пример резерва профиля', 'Profile example reserve', 'Приклад резерву профілю'],

  ownerAuthorization: [
    'Нужно подтверждение бюджета владельца. Открой панель изображения; каждый запрос подтверждается отдельно.',
    'Owner budget authorization is required. Open image details; each request is approved separately.',
    'Потрібне підтвердження бюджету власника. Відкрий панель зображення; кожен запит підтверджується окремо.',
  ],
  estimateRisk: [
    'Настроена генерация по оценке: резерв не ограничивает счёт провайдера. Перед каждым запросом нужно отдельное согласие на риск.',
    'Estimate-based generation is configured: the reserve does not cap the provider invoice. Every request requires separate risk consent.',
    'Налаштовано генерацію за оцінкою: резерв не обмежує рахунок провайдера. Кожен запит потребує окремої згоди на ризик.',
  ],

  title: ['Изображение локации', 'Location image', 'Зображення локації'],
  generate: ['Сгенерировать изображение', 'Generate image', 'Згенерувати зображення'],
  manage: ['Изображение и библиотека', 'Image details and library', 'Зображення й бібліотека'],
  intro: [
    'Изображение строится по сохранённому названию и описанию этой локации. Открытие панели не отправляет запрос ИИ.',
    'The image uses this location’s saved name and description. Opening the panel does not call AI.',
    'Зображення використовує збережені назву й опис цієї локації. Відкриття панелі не викликає ШІ.',
  ],
  geometry: [
    'Это игровая карта локации. При подготовке игры изображение используется для размещения персонажей. Нарисованные стены и двери сами по себе не создают коллизии или интерактивные объекты.',
    'This image is the location’s game map. Game preparation uses it to place characters. Drawn walls and doors do not automatically create collisions or interactive objects.',
    'Це ігрова карта локації. Підготовка гри використовує зображення для розміщення персонажів. Намальовані стіни й двері самі по собі не створюють колізій або інтерактивних об’єктів.',
  ],
  provider: ['Провайдер', 'Provider', 'Провайдер'],
  model: ['Модель', 'Model', 'Модель'],
  estimate: [
    'Плановая оценка, не потолок счёта',
    'Planning estimate, not an invoice cap',
    'Планова оцінка, а не межа рахунку',
  ],
  reserve: ['Операционный резерв', 'Operational reserve', 'Операційний резерв'],
  bound: ['Подтверждённая верхняя граница', 'Verified upper bound', 'Перевірена верхня межа'],
  unverified: [
    'Полная верхняя граница стоимости не подтверждена. Реальная отправка заблокирована.',
    'The full cost upper bound is unverified. Real dispatch is blocked.',
    'Повну верхню межу вартості не підтверджено. Реальне надсилання заблоковано.',
  ],
  unavailable: [
    'Реальная генерация сейчас отключена настройками или разрешениями. Причины указаны ниже.',
    'Real generation is disabled by the current configuration or permissions. Reasons are listed below.',
    'Реальну генерацію вимкнено поточними налаштуваннями або дозволами. Причини наведено нижче.',
  ],
  session: [
    'Нужна активная ручная сессия владельца. Открой панель изображения, чтобы проверить бюджет.',
    'An active owner manual session is required. Open image details to check the budget.',
    'Потрібна активна ручна сесія власника. Відкрий панель зображення, щоб перевірити бюджет.',
  ],
  saveFirst: [
    'Сначала сохрани черновик истории. Карту локации можно выбрать до подготовки игрового плана.',
    'Save the story draft first. You can choose the location map before preparing its playable layout.',
    'Спершу збережи чернетку історії. Карту локації можна вибрати до підготовки ігрового плану.',
  ],
  loading: [
    'Загружается конфигурация изображения…',
    'Loading image configuration…',
    'Завантажується конфігурація зображення…',
  ],
  notConfigured: ['Не настроено', 'Not configured', 'Не налаштовано'],
  library: [
    'Выбрать готовое изображение бесплатно',
    'Choose an existing image for free',
    'Вибрати готове зображення безкоштовно',
  ],
  saved: [
    'Изображение сохранено для локации.',
    'The image was saved for this location.',
    'Зображення збережено для цієї локації.',
  ],
  current: ['Сохранённое изображение', 'Saved image', 'Збережене зображення'],
  candidate: ['Изображение для проверки', 'Image for review', 'Зображення для перевірки'],
  stale: [
    'Название, описание или связанная карта изменились. Обнови панель и проверь изображение заново; повторной генерации не будет.',
    'The name, description or linked map changed. Refresh the panel and review the image again; it will not regenerate.',
    'Назва, опис або пов’язана карта змінилися. Онови панель і перевір зображення ще раз; повторної генерації не буде.',
  ],
  refresh: ['Обновить сохранённые данные', 'Refresh saved data', 'Оновити збережені дані'],
  review: [
    'Проверь изображение перед сохранением выбранной ревизии для локации.',
    'Review the preview, then save this image to use it for the location.',
    'Перевір зображення перед збереженням вибраної ревізії для локації.',
  ],
  bind: [
    'Сохранить изображение для локации',
    'Save image for location',
    'Зберегти зображення для локації',
  ],
  reuseCurrent: [
    'Использовать сохранённую версию',
    'Use the saved revision',
    'Використати збережену версію',
  ],
  attach: ['Связь с игровым планом', 'Playable layout link', 'Зв’язок з ігровим планом'],
  illustration: [
    'Карта локации без привязки к готовому плану',
    'Location map without an existing layout link',
    'Карта локації без прив’язки до готового плану',
  ],
  map: [
    'Фон связанной игровой карты',
    'Linked playable-map background',
    'Тло пов’язаної ігрової карти',
  ],
  noMap: [
    'Игровой план ещё не подготовлен. Сохрани выбранную карту локации сейчас; при подготовке игры будет использовано это изображение.',
    'The playable layout is not prepared yet. Save the location map now; game preparation will use this image.',
    'Ігровий план ще не підготовлено. Збережи карту локації зараз; підготовка гри використає це зображення.',
  ],
  dirtyMap: [
    'Есть несохранённые изменения игрового плана или графики. Сначала сохрани их для привязки к готовому плану. Выбранную карту можно сохранить для локации уже сейчас.',
    'The playable layout or art has unsaved changes. Save them before linking to that layout. You can save the selected map for this location now.',
    'Ігровий план або графіка мають незбережені зміни. Збережи їх перед прив’язкою до готового плану. Вибрану карту можна зберегти для локації вже зараз.',
  ],
  prompt: [
    'Сохранённое описание для генерации',
    'Saved generation description',
    'Збережений опис для генерації',
  ],
  missing: [
    'Изображение недоступно или отозвано. Выбери другую разрешённую версию.',
    'The image is unavailable or withdrawn. Choose another permitted revision.',
    'Зображення недоступне або відкликане. Вибери іншу дозволену версію.',
  ],
} as const;
export type LocationImageMessage = keyof typeof locationImageMessages;
export function useLocationImageText() {
  const { locale } = useT();
  return (key: LocationImageMessage) =>
    locationImageMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
