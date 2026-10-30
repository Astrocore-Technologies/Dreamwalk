'use client';
import { useT } from '@/lib/i18n';
const messages = {
  brand: ['Dreamwalk', 'Dreamwalk', 'Dreamwalk'],
  carousel: ['карусель', 'carousel', 'карусель'],
  intro: ['Куда отправимся сегодня?', 'Where will the story take you?', 'Куди вирушимо сьогодні?'],
  library: ['Моя библиотека', 'My library', 'Моя бібліотека'],
  featured: ['Истории в центре внимания', 'Featured adventures', 'Історії в центрі уваги'],
  spotlight: ['В центре внимания', 'In the spotlight', 'У центрі уваги'],
  previous: ['Предыдущая история', 'Previous adventure', 'Попередня історія'],
  next: ['Следующая история', 'Next adventure', 'Наступна історія'],
  start: ['Начать', 'Start', 'Почати'],
  open: ['Открыть историю', 'Explore story', 'Відкрити історію'],
  details: ['Подробнее', 'Story details', 'Докладніше'],
  solo: ['Соло', 'Solo', 'Соло'],
  coop: ['С друзьями', 'Co-op', 'З друзями'],
  sourceLanguage: ['Язык оригинала', 'Original language', 'Мова оригіналу'],
  meet: ['Тебя встретят', 'Meet along the way', 'Тебе зустрінуть'],
  portraitMissing: ['Портрет ещё не добавлен', 'Portrait not added yet', 'Портрет ще не додано'],
  continue: ['Продолжить путешествие', 'Continue your journey', 'Продовжити подорож'],
  saved: ['Твоя сохранённая кампания', 'Your saved campaign', 'Твоя збережена кампанія'],
  resume: ['Продолжить', 'Continue', 'Продовжити'],
  saves: ['Все сохранения', 'All saved campaigns', 'Усі збереження'],
  noSave: [
    'Здесь появится твоё путешествие',
    'Your journey will wait here',
    'Тут з’явиться твоя подорож',
  ],
  noSaveHint: [
    'Начни доступную игровую историю — прогресс сохранится автоматически.',
    'Start an available playable adventure. Your progress saves automatically.',
    'Почни доступну ігрову історію — прогрес збережеться автоматично.',
  ],
  signIn: ['Войти и продолжить', 'Sign in to continue', 'Увійти й продовжити'],
  signInHint: [
    'Твои сохранения доступны после входа.',
    'Sign in to find your saved campaigns.',
    'Твої збереження доступні після входу.',
  ],
  mystery: ['Тайны и открытия', 'Mysteries & discoveries', 'Таємниці й відкриття'],
  mysteryHint: [
    'Для тех, кто всегда заглядывает за следующую дверь.',
    'For those who always open one more door.',
    'Для тих, хто завжди зазирає за наступні двері.',
  ],
  wonder: [
    'Миры, в которых хочется остаться',
    'Worlds worth lingering in',
    'Світи, у яких хочеться залишитись',
  ],
  wonderHint: [
    'Немного магии. Неожиданные встречи. Твоя история.',
    'A little wonder. An unexpected encounter. Your story.',
    'Трохи магії. Несподівані зустрічі. Твоя історія.',
  ],
  browse: ['Все приключения', 'Explore all', 'Усі пригоди'],
  curated: [
    'Подборки из публичной библиотеки',
    'Collections from the public library',
    'Добірки з публічної бібліотеки',
  ],
  railPrevious: ['Прокрутить подборку назад', 'Scroll collection back', 'Прокрутити добірку назад'],
  railNext: [
    'Прокрутить подборку вперёд',
    'Scroll collection forward',
    'Прокрутити добірку вперед',
  ],
  empty: [
    'Первые миры уже в пути',
    'The first worlds are on their way',
    'Перші світи вже в дорозі',
  ],
  emptyHint: [
    'Опубликованные истории появятся здесь после проверки.',
    'Published stories appear here after review.',
    'Опубліковані історії з’являться тут після перевірки.',
  ],
  numbered: ['История', 'Adventure', 'Історія'],
} as const;
export function useHomeText() {
  const { locale } = useT();
  return (key: keyof typeof messages) =>
    messages[key][locale === 'ru' ? 0 : locale === 'uk' ? 2 : 1];
}
