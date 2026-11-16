/** First-party editorial fixtures only. Never upgrades an edited story, draft or existing save. */
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import {
  compilePlayableDraft,
  createForestStoryDraft,
  createLighthouseStoryDraft,
  type AuthoredGameDraft,
} from '@dreamwalk/game-core';
import { npcSchema, readerStoryContent } from '@dreamwalk/contracts';

type Locale = 'ru' | 'uk' | 'en';
interface NpcCopy {
  draftId: string;
  name: Record<Locale, string>;
  role: Record<Locale, string>;
  personality: Record<Locale, string>;
  greeting: Record<Locale, string>;
}
interface FirstPartyStory {
  slug: string;
  fixture: string;
  draft: () => AuthoredGameDraft;
  rules: string;
  npcs: NpcCopy[];
}
const copy = (ru: string, uk: string, en: string): Record<Locale, string> => ({ ru, uk, en });
export const firstPartyStories: FirstPartyStory[] = [
  {
    slug: 'whispering-forest',
    fixture: 'forest-story-v1',
    draft: createForestStoryDraft,
    rules:
      'Найдите ключ у колодца или попросите пропуск у старосты, пройдите лесной тропой и отыщите книгу имён. После развязки можно продолжить исследование.',
    npcs: [
      {
        draftId: 'elder',
        name: copy('Нара', 'Нара', 'Nara'),
        role: copy('Староста', 'Староста', 'Village elder'),
        personality: copy('Спокойная и прямая', 'Спокійна й пряма', 'Calm and plain-spoken'),
        greeting: copy(
          'Имена уходят. Ты пришёл спросить, куда?',
          'Імена йдуть. Ти прийшов спитати, куди?',
          'The names are leaving. Have you come to ask where?',
        ),
      },
      {
        draftId: 'wanderer',
        name: copy('Ивар', 'Івар', 'Ivar'),
        role: copy('Путник', 'Мандрівник', 'Wanderer'),
        personality: copy('Живой и любопытный', 'Жвавий і допитливий', 'Lively and curious'),
        greeting: copy(
          'Как тебя зовут? Меня звали… нет, не вспомню.',
          'Як тебе звати? Мене звали… ні, не згадаю.',
          'What is your name? Mine was… no, I cannot recall.',
        ),
      },
    ],
  },
  {
    slug: 'tidekeepers',
    fixture: 'lighthouse-story-v1',
    draft: createLighthouseStoryDraft,
    rules:
      'Найдите ключ на причале или попросите жетон у смотрительницы, поднимитесь на маяк и найдите письмо без адреса. После развязки можно продолжить исследование.',
    npcs: [
      {
        draftId: 'keeper',
        name: copy('Брина', 'Бріна', 'Brina'),
        role: copy('Смотрительница', 'Доглядачка', 'Lighthouse keeper'),
        personality: copy('Суровая, но справедливая', 'Сувора, але справедлива', 'Stern but fair'),
        greeting: copy(
          'Прилив не ждёт. Ты за светом?',
          'Приплив не чекає. Ти за світлом?',
          'The tide does not wait. Are you here for the light?',
        ),
      },
      {
        draftId: 'courier',
        name: copy('Сайл', 'Сайл', 'Syl'),
        role: copy('Курьер', 'Кур’єр', 'Courier'),
        personality: copy('Быстрый и болтливый', 'Швидкий і балакучий', 'Quick and talkative'),
        greeting: copy(
          'Ты не знаешь, кому это письмо?',
          'Ти не знаєш, кому цей лист?',
          'Do you happen to know who this letter is for?',
        ),
      },
    ],
  },
];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const npcData = (n: NpcCopy) =>
  npcSchema.parse({
    name: n.name.ru,
    role: n.role.ru,
    personality: n.personality.ru,
    greeting: n.greeting.ru,
    age: 30,
    description: '',
    sourceLanguage: 'ru',
    sourceRevision: 1,
    translations: Object.fromEntries(
      (['ru', 'en', 'uk'] as const).map((l) => [
        l,
        {
          name: n.name[l],
          role: n.role[l],
          personality: n.personality[l],
          greeting: n.greeting[l],
          description: '',
          sourceRevision: 1,
        },
      ]),
    ),
  });

export async function seedFirstPartyStory(db: Pool, ownerId: string, story: FirstPartyStory) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const owner = (
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND email='editorial@dreamwalk.invalid' AND password_hash='disabled' AND deleted_at IS NULL FOR SHARE",
        [ownerId],
      )
    ).rows[0];
    const row = owner
      ? (
          await c.query('SELECT * FROM adventures WHERE owner_id=$1 AND slug=$2 FOR UPDATE', [
            ownerId,
            story.slug,
          ])
        ).rows[0]
      : undefined;
    if (
      !row ||
      row.status !== 'published' ||
      row.visibility !== 'public' ||
      row.data.sourceRevision !== 1 ||
      (row.data.content?.npcIds ?? []).length ||
      row.published_snapshot?.playableVersionId ||
      (
        await c.query(
          'SELECT 1 FROM adventure_game_drafts WHERE adventure_id=$1 UNION ALL SELECT 1 FROM game_playable_versions WHERE adventure_id=$1',
          [row.id],
        )
      ).rowCount
    ) {
      await c.query('ROLLBACK');
      return false;
    }
    const draft = story.draft();
    draft.title = row.title;
    const definitions: { id: string; data: Record<string, unknown> }[] = [];
    for (const n of story.npcs) {
      const id = randomUUID(),
        data = npcData(n);
      await c.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3)', [
        id,
        ownerId,
        JSON.stringify(data),
      ]);
      definitions.push({ id, data });
      const placed = draft.npcs.find((d) => d.id === n.draftId)!;
      placed.sourceNpcId = id;
      placed.label = n.name.ru;
      placed.labelTranslations = { ...n.name };
    }
    const compiled = compilePlayableDraft(draft);
    if (!compiled.playable)
      throw new Error(`INVALID_BUNDLED_ADVENTURE:${compiled.errors.join(';')}`);
    const data = {
      ...row.data,
      content: {
        ...row.data.content,
        rules: story.rules,
        npcIds: definitions.map((d) => d.id),
      },
    };
    compiled.playable.narrativePremise = {
      title: row.title,
      summary: row.synopsis,
      world: String(row.data.content?.world ?? ''),
      genre: row.genre,
    };
    const payload = {
      schemaVersion: 1,
      compiled: compiled.playable,
      source: {
        title: row.title,
        sourceLanguage: data.sourceLanguage,
        sourceRevision: data.sourceRevision,
        content: data.content,
      },
      npcDefinitions: definitions,
      editorialFixture: story.fixture,
    };
    const versionId = randomUUID(),
      version = Number(row.version) + 1;
    const publicNpcs = definitions.map((d) => {
      const {
        secrets: _secrets,
        biography: _biography,
        characterProfile: _characterProfile,
        ...safe
      } = d.data as Record<string, unknown>;
      return { ...safe, id: d.id };
    });
    const published = {
      ...row.published_snapshot,
      ...data,
      content: readerStoryContent(data.content),
      publicNpcs,
      playableVersionId: versionId,
    };
    const checksum = createHash('sha256')
      .update(JSON.stringify(canonical(payload)))
      .digest('hex');
    await c.query(
      'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2)',
      [row.id, JSON.stringify(draft)],
    );
    await c.query(
      "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'review',$3,$4)",
      [versionId, row.id, JSON.stringify(payload), checksum],
    );
    const editorial = (
      await c.query(
        'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,$2,$3) RETURNING id',
        [
          row.id,
          version,
          JSON.stringify({
            ...published,
            npcDefinitions: definitions.map((d) => ({ ...d.data, id: d.id })),
          }),
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO game_playable_approvals(playable_version_id,adventure_version_id) VALUES($1,$2)',
      [versionId, editorial.id],
    );
    await c.query(
      'UPDATE adventures SET data=$2,published_snapshot=$3,version=$4,updated_at=now() WHERE id=$1',
      [row.id, JSON.stringify(data), JSON.stringify(published), version],
    );
    await c.query(
      "INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,'seed.playable.firstparty',$2,$3)",
      [
        ownerId,
        row.id,
        JSON.stringify({ version, playableVersionId: versionId, fixture: story.fixture }),
      ],
    );
    await c.query('COMMIT');
    return true;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
export async function seedFirstPartyStories(db: Pool, ownerId: string) {
  for (const story of firstPartyStories) await seedFirstPartyStory(db, ownerId, story);
}
