import type { Locale } from '@/lib/locales';

export const npcDesignCopy = {
  title: ['Персонажи мира', 'World characters', 'Персонажі світу'],
  intro: [
    'Союзники, наставники, соперники и другие жители, которые наполняют истории жизнью.',
    'Allies, mentors, rivals and other inhabitants who bring your stories to life.',
    'Союзники, наставники, суперники та інші мешканці, які наповнюють історії життям.',
  ],
  worldCharacter: ['Персонаж мира', 'World character', 'Персонаж світу'],
  portraitEmpty: ['Портрет ещё не добавлен', 'No portrait yet', 'Портрет ще не додано'],
  character: ['Характер', 'Personality', 'Характер'],
  biography: ['Биография', 'Biography', 'Біографія'],
  speech: ['Речь', 'Speech', 'Мовлення'],
  secrets: ['Личные секреты', 'Private secrets', 'Особисті секрети'],
  private: ['Только автору и модератору', 'Author and moderator only', 'Лише автору та модератору'],
  details: ['История и характер', 'Story and personality', 'Історія та характер'],
  artwork: ['Образ на карте', 'In-world appearance', 'Образ на мапі'],
} as const;

export function npcDesignText(locale: Locale, key: keyof typeof npcDesignCopy) {
  return npcDesignCopy[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
