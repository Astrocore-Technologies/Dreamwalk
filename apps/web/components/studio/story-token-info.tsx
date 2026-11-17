'use client';
import { STORY_OPENING_AI_CHARS, STORY_WORLD_AI_CHARS } from '@dreamwalk/contracts';
import type { Npc } from '@dreamwalk/contracts';
import { useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import styles from './story-token-info.module.css';

/** Rough size of the model's fixed instructions for one narrator turn, measured on real requests. */
const NARRATOR_PROMPT_TOKENS = 6000;
const CHARS_PER_TOKEN = 3;
const messages = {
  ru: {
    title: 'Информация о токенах',
    story: 'Описание и первое сообщение',
    characters: 'Персонажи',
    prompt: 'Промпт ведущего',
    total: 'Примерный итог на ход',
    hint: 'Это грубая оценка: ИИ получает эти тексты в каждом ходу, поэтому чем они длиннее, тем дороже ход.',
    clipped:
      'ИИ читает первые {world} символов описания и {opening} символов первого сообщения. Остальное сохранится, но в ход не попадёт.',
  },
  uk: {
    title: 'Інформація про токени',
    story: 'Опис і перше повідомлення',
    characters: 'Персонажі',
    prompt: 'Промпт ведучого',
    total: 'Орієнтовний підсумок на хід',
    hint: 'Це груба оцінка: ШІ отримує ці тексти в кожному ході, тому чим вони довші, тим дорожчий хід.',
    clipped:
      'ШІ читає перші {world} символів опису та {opening} символів першого повідомлення. Решта збережеться, але в хід не потрапить.',
  },
  en: {
    title: 'Token information',
    story: 'Description and first message',
    characters: 'Characters',
    prompt: 'Narrator prompt',
    total: 'Approximate total per turn',
    hint: 'A rough estimate: the AI receives these texts on every turn, so the longer they are, the more each turn costs.',
    clipped:
      'The AI reads the first {world} characters of the description and {opening} of the first message. The rest is saved but never reaches a turn.',
  },
};
const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const compact = (value: number, locale: string) =>
  value >= 1000
    ? `${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`
    : String(value);
const npcChars = (npc: Partial<Npc>) =>
  [
    npc.name,
    npc.role,
    npc.description,
    npc.personality,
    npc.appearance,
    npc.biography,
    npc.greeting,
  ].reduce((sum, field) => sum + (typeof field === 'string' ? field.length : 0), 0);

export function StoryTokenInfo({
  adventureId,
  world,
  rules,
  firstMessage,
  npcIds,
}: {
  adventureId?: string;
  world: string;
  rules: string;
  firstMessage: string;
  npcIds: string[];
}) {
  const { locale } = useT();
  const text = messages[locale];
  const library = useResource<Npc[]>('/npcs');
  const locals = useResource<{ npcs: (Npc & { id: string })[] }>(
    adventureId ? `/studio/adventures/${adventureId}/npcs` : null,
  );
  const known = new Map<string, Partial<Npc>>();
  for (const npc of library.data ?? []) known.set(npc.id, npc);
  for (const npc of locals.data?.npcs ?? []) known.set(npc.id, npc);
  const storyChars =
    Math.min(world.length + rules.length, STORY_WORLD_AI_CHARS) +
    Math.min(firstMessage.length, STORY_OPENING_AI_CHARS);
  const characterChars = npcIds.reduce((sum, id) => sum + npcChars(known.get(id) ?? {}), 0);
  const story = tokens(storyChars),
    characters = tokens(characterChars),
    total = story + characters + NARRATOR_PROMPT_TOKENS;
  const clipped =
    world.length + rules.length > STORY_WORLD_AI_CHARS ||
    firstMessage.length > STORY_OPENING_AI_CHARS;
  return (
    <section className={styles.info} aria-label={text.title} data-testid="story-token-info">
      <h3>{text.title}</h3>
      <dl>
        <div>
          <dt>{text.story}</dt>
          <dd>{compact(story, locale)}</dd>
        </div>
        <div>
          <dt>{text.characters}</dt>
          <dd>{compact(characters, locale)}</dd>
        </div>
        <div>
          <dt>{text.prompt}</dt>
          <dd>{compact(NARRATOR_PROMPT_TOKENS, locale)}</dd>
        </div>
        <div className={styles.total}>
          <dt>{text.total}</dt>
          <dd>{compact(total, locale)}</dd>
        </div>
      </dl>
      <p className="muted">{text.hint}</p>
      {clipped && (
        <p className="notice">
          {text.clipped
            .replace('{world}', STORY_WORLD_AI_CHARS.toLocaleString(locale))
            .replace('{opening}', STORY_OPENING_AI_CHARS.toLocaleString(locale))}
        </p>
      )}
    </section>
  );
}
