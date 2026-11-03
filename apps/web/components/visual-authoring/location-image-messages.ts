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
    'Изображение — иллюстрация. Стены, двери и проходимость задаёт отдельный игровой план; картинка не создаёт коллизии.',
    'The image is an illustration. Walls, doors and reachability come from a separate playable plan; the picture does not create collisions.',
    'Зображення — ілюстрація. Стіни, двері й прохідність визначає окремий ігровий план; картинка не створює колізій.',
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
    'Сначала сохрани черновик истории. Кнопка изображения останется здесь; игровой план для иллюстрации не нужен.',
    'Save the story draft first. The image control stays here; an illustration does not require a playable plan.',
    'Спершу збережи чернетку історії. Кнопка зображення залишиться тут; для ілюстрації ігровий план не потрібен.',
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
  attach: ['Назначение изображения', 'Image attachment', 'Призначення зображення'],
  illustration: [
    'Только иллюстрация локации',
    'Location illustration only',
    'Лише ілюстрація локації',
  ],
  map: [
    'Фон связанной игровой карты',
    'Linked playable-map background',
    'Тло пов’язаної ігрової карти',
  ],
  noMap: [
    'Связанной сохранённой карты пока нет. Изображение можно сохранить сейчас и назначить фоном карты позже.',
    'There is no linked saved map yet. Save the illustration now and attach it to a map later.',
    'Пов’язаної збереженої карти ще немає. Збережи ілюстрацію зараз і признач її тлом карти пізніше.',
  ],
  dirtyMap: [
    'Есть несохранённые изменения игрового плана или графики. Сначала сохрани их для привязки к карте; иллюстрацию можно сохранить отдельно.',
    'The playable plan or art has unsaved changes. Save them before attaching to a map; the illustration can still be saved separately.',
    'Ігровий план або графіка мають незбережені зміни. Збережи їх перед прив’язкою до карти; ілюстрацію можна зберегти окремо.',
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
