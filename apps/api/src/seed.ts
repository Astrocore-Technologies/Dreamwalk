import { seedCompleteObservatory } from './game/seed-observatory';
import { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { settingsSchema, adventureSchema, npcSchema } from '@dreamwalk/contracts';
import { randomUUID } from 'node:crypto';
// Curated first-party demo text only; no automatic translation provider.
const npcCopy: Record<string, { ru: string[]; en: string[]; uk: string[] }> = {
  Элиас: {
    ru: ['Элиас', 'Смотритель', 'Сдержанный и наблюдательный', 'Вы всё-таки нашли дорогу.'],
    en: ['Elias', 'Caretaker', 'Reserved and observant', 'You found your way after all.'],
    uk: ['Еліас', 'Доглядач', 'Стриманий і спостережливий', 'Ви все-таки знайшли дорогу.'],
  },
  Мира: {
    ru: [
      'Мира',
      'Исследовательница',
      'Любопытная и решительная',
      'Посмотрите на эту карту. Видите расхождение?',
    ],
    en: [
      'Mira',
      'Researcher',
      'Curious and determined',
      'Look at this map. Do you see the discrepancy?',
    ],
    uk: ['Міра', 'Дослідниця', 'Допитлива й рішуча', 'Погляньте на цю карту. Бачите розбіжність?'],
  },
  Тик: {
    ru: [
      'Тик',
      'Механический помощник',
      'Педантичный и добродушный',
      'До рассвета осталось достаточно времени. Вероятно.',
    ],
    en: [
      'Tick',
      'Mechanical assistant',
      'Meticulous and good-natured',
      'There is enough time before dawn. Probably.',
    ],
    uk: [
      'Тік',
      'Механічний помічник',
      'Педантичний і добродушний',
      'До світанку залишилося достатньо часу. Мабуть.',
    ],
  },
};
function curatedNpc(data: Record<string, unknown>) {
  const copy = npcCopy[String(data.name)];
  if (
    !copy ||
    copy.ru.some((v, i) => v !== data[['name', 'role', 'personality', 'greeting'][i]]) ||
    data.appearance ||
    data.description ||
    (data.sourceLanguage && data.sourceLanguage !== 'ru') ||
    Number(data.sourceRevision ?? 1) !== 1
  )
    return data;
  const sourceRevision = data.sourceRevision ?? 1;
  const localized = {
    ...data,
    description: '',
    sourceLanguage: 'ru',
    sourceRevision,
    translations: Object.fromEntries(
      (['ru', 'en', 'uk'] as const).map((locale) => [
        locale,
        {
          name: copy[locale][0],
          role: copy[locale][1],
          personality: copy[locale][2],
          greeting: copy[locale][3],
          description: '',
          appearance: '',
          sourceRevision,
        },
      ]),
    ),
  };
  if (
    data.translations &&
    Object.keys(data.translations).length &&
    !isDeepStrictEqual(data.translations, localized.translations)
  )
    return data;
  return localized;
}
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed forbidden in production');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const existing = await db.query(
      "SELECT id FROM users WHERE handle='dreamwalk' OR handle='dreamwalk_editorial'",
    );
    let owner: string;
    if (existing.rows[0]) owner = existing.rows[0].id;
    else {
      owner = (
        await db.query(
          'INSERT INTO users(email,password_hash,name,handle,bio,onboarded,settings) VALUES($1,$2,$3,$4,$5,true,$6) RETURNING id',
          [
            'editorial@dreamwalk.invalid',
            'disabled',
            'Dreamwalk',
            'dreamwalk',
            'Истории для первого шага за границу привычного.',
            JSON.stringify(settingsSchema.parse({})),
          ],
        )
      ).rows[0].id;
      await db.query('INSERT INTO wallets(user_id) VALUES($1)', [owner]);
    }
    for (const b of [
      {
        key: 'green_apple',
        name: 'Green Apple',
        description: 'Быстрый темп и яркие приключения.',
        instructions:
          'Короткие насыщенные сцены, инициативные NPC и драматическое напряжение. Уважай выбор игрока и индивидуальность персонажей.',
      },
      {
        key: 'cookie',
        name: 'Cookie',
        description: 'Спокойный диалог, внимание к деталям и отношениям.',
        instructions:
          'Эмоциональная последовательность, бережный темп и память. Не выступай терапевтом, не провоцируй зависимость, никогда не связывай оплату с любовью NPC.',
      },
    ]) {
      const r = await db.query(
        'INSERT INTO model_profiles(key,name,description,instructions) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING RETURNING id',
        [b.key, b.name, b.description, b.instructions],
      );
      if (r.rows[0])
        await db.query(
          'INSERT INTO model_profile_versions(model_id,version,snapshot) VALUES($1,1,$2)',
          [r.rows[0].id, JSON.stringify({ ...b, enabled: true })],
        );
    }
    if (!(await db.query('SELECT id FROM runtime_profiles LIMIT 1')).rows.length)
      for (const r of [
        {
          name: 'Демонстрационный runtime',
          provider: 'mock',
          model: 'deterministic-preview',
          enabled: true,
        },
        {
          name: 'OpenAI — подготовка',
          provider: 'openai',
          model: 'configure-after-verification',
          enabled: false,
        },
        {
          name: 'Локальный — подготовка',
          provider: 'local',
          model: 'not-configured',
          enabled: false,
        },
      ])
        await db.query(
          'INSERT INTO runtime_profiles(name,provider,model,enabled,endpoint_id,max_input_tokens,max_output_tokens,timeout_ms,concurrency) VALUES($1,$2,$3,$4,$2,16000,2000,30000,1)',
          [r.name, r.provider, r.model, r.enabled],
        );
    const stories = [
      {
        slug: 'old-observatory',
        title: 'Тайна старой обсерватории',
        synopsis:
          'Каждую ночь над заброшенной обсерваторией загорается звезда, которой нет ни на одной карте. Смотритель оставил вам ключ. И предупреждение: не доверяйте времени.',
        genre: 'Тайна',
        cover: 'observatory',
        tags: ['Загадки', 'Тайны', 'Атмосфера'],
        world:
          'Высоко над городом стоит старая обсерватория. Её механизм хранит карту ещё не наступившего рассвета.',
        locations: [
          {
            id: 'courtyard',
            name: 'Двор',
            description: 'Мокрая брусчатка и заросший плющом купол.',
          },
          {
            id: 'hall',
            name: 'Зал наблюдений',
            description: 'Телескоп повёрнут к незнакомому созвездию.',
          },
          { id: 'archive', name: 'Архив', description: 'Карты, письма и забытый ответ.' },
        ],
      },
      {
        slug: 'whispering-forest',
        title: 'Там, где лес помнит',
        synopsis:
          'В деревне на краю древнего леса исчезли все имена. Найдите тропу, которую не видно днём, и узнайте, о чём молчат деревья.',
        genre: 'Фэнтези',
        cover: 'forest',
        tags: ['Исследование', 'Магия'],
        world: 'Лес хранит имена и истории своих гостей.',
        locations: [
          { id: 'path', name: 'Тропа шёпота', description: 'Листья повторяют знакомый голос.' },
        ],
      },
      {
        slug: 'tidekeepers',
        title: 'Маяк на краю прилива',
        synopsis:
          'Последний маяк архипелага погас. Вместе с письмом без адреса вы получаете шанс вернуть свет — или открыть то, что он скрывал.',
        genre: 'Приключение',
        cover: 'sea',
        tags: ['Море', 'Выбор'],
        world: 'Острова медленно уходят под воду, и только маяки удерживают прилив.',
        locations: [
          { id: 'shore', name: 'Тихая гавань', description: 'На берегу лежит лодка без вёсел.' },
        ],
      },
      {
        slug: 'city-of-lanterns',
        title: 'Город потерянных фонарей',
        synopsis:
          'Маленькая мастерская, необычные посетители и свет, который умеет исполнять обещания. Тёплая история о том, что делает место домом.',
        genre: 'Уютное фэнтези',
        cover: 'city',
        tags: ['Отношения', 'Уют'],
        world: 'В городе каждый фонарь зажигается от доброго воспоминания.',
        locations: [
          { id: 'workshop', name: 'Мастерская', description: 'Здесь пахнет чаем и тёплой медью.' },
        ],
      },
    ];
    const curated: Record<
      string,
      { en: { title: string; synopsis: string }; uk: { title: string; synopsis: string } }
    > = {
      'old-observatory': {
        en: {
          title: 'Mystery of the Old Observatory',
          synopsis:
            'Every night, an uncharted star rises above the abandoned observatory. Its keeper has left you a key — and a warning not to trust time.',
        },
        uk: {
          title: 'Таємниця старої обсерваторії',
          synopsis:
            'Щоночі над покинутою обсерваторією спалахує зірка, якої немає на жодній мапі. Наглядач залишив вам ключ і попередження: не довіряйте часу.',
        },
      },
      'whispering-forest': {
        en: {
          title: 'Where the Forest Remembers',
          synopsis:
            'Every name has vanished from a village beside an ancient forest. Find a path invisible by daylight and discover what the trees refuse to tell.',
        },
        uk: {
          title: 'Там, де ліс пам’ятає',
          synopsis:
            'У селі на краю прадавнього лісу зникли всі імена. Знайдіть стежку, якої не видно вдень, і дізнайтеся, про що мовчать дерева.',
        },
      },
      tidekeepers: {
        en: {
          title: 'The Lighthouse at the Edge of the Tide',
          synopsis:
            'The archipelago’s last lighthouse has gone dark. A letter without an address offers a chance to restore its light — or uncover what it concealed.',
        },
        uk: {
          title: 'Маяк на краю припливу',
          synopsis:
            'Останній маяк архіпелагу згас. Разом із листом без адреси ви отримуєте шанс повернути світло — або відкрити те, що воно приховувало.',
        },
      },
      'city-of-lanterns': {
        en: {
          title: 'City of Lost Lanterns',
          synopsis:
            'A little workshop, unusual visitors and a light that can keep promises. A warm story about what makes a place a home.',
        },
        uk: {
          title: 'Місто загублених ліхтарів',
          synopsis:
            'Маленька майстерня, незвичайні відвідувачі та світло, що вміє виконувати обіцянки. Тепла історія про те, що робить місце домом.',
        },
      },
    };
    for (const npc of (await db.query('SELECT id,data FROM npcs WHERE owner_id=$1', [owner]))
      .rows) {
      const localized = curatedNpc(npc.data);
      if (!isDeepStrictEqual(localized, npc.data))
        await db.query('UPDATE npcs SET data=$2 WHERE id=$1', [npc.id, JSON.stringify(localized)]);
    }
    for (const s of stories) {
      const existingStory = (await db.query('SELECT * FROM adventures WHERE slug=$1', [s.slug]))
        .rows[0];
      if (existingStory) {
        // Upgrade only unchanged bundled editorial fixtures; preserve all historical versions.
        if (
          existingStory.owner_id === owner &&
          existingStory.title === s.title &&
          existingStory.synopsis === s.synopsis &&
          existingStory.status === 'published' &&
          existingStory.visibility === 'public' &&
          existingStory.published_snapshot?.title === s.title
        ) {
          const client = await db.connect();
          try {
            await client.query('BEGIN');
            const row = (
              await client.query('SELECT * FROM adventures WHERE id=$1 FOR UPDATE', [
                existingStory.id,
              ])
            ).rows[0];
            const revision = Number(row.data.sourceRevision ?? 1);
            const translations = {
              ru: { title: s.title, synopsis: s.synopsis, sourceRevision: revision },
              en: { ...curated[s.slug].en, sourceRevision: revision },
              uk: { ...curated[s.slug].uk, sourceRevision: revision },
            };
            const publicNpcs = (row.published_snapshot.publicNpcs ?? []).map(curatedNpc);
            const unchanged =
              isDeepStrictEqual(publicNpcs, row.published_snapshot.publicNpcs ?? []) &&
              (['ru', 'en', 'uk'] as const).every(
                (locale) =>
                  row.published_snapshot?.translations?.[locale]?.title ===
                    translations[locale].title &&
                  row.published_snapshot?.translations?.[locale]?.synopsis ===
                    translations[locale].synopsis &&
                  row.published_snapshot?.translations?.[locale]?.sourceRevision === revision,
              );
            if (!unchanged) {
              const metadata = { sourceLanguage: 'ru', sourceRevision: revision, translations };
              const data = { ...row.data, ...metadata };
              const published = { ...row.published_snapshot, ...metadata, publicNpcs };
              const previous =
                (
                  await client.query(
                    'SELECT snapshot FROM adventure_versions WHERE adventure_id=$1 ORDER BY version DESC LIMIT 1',
                    [row.id],
                  )
                ).rows[0]?.snapshot ?? published;
              const version = Number(row.version) + 1;
              await client.query(
                'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,$2,$3)',
                [
                  row.id,
                  version,
                  JSON.stringify({
                    ...previous,
                    ...metadata,
                    publicNpcs,
                    npcDefinitions: (previous.npcDefinitions ?? []).map(curatedNpc),
                  }),
                ],
              );
              await client.query(
                'UPDATE adventures SET data=$2,published_snapshot=$3,version=$4,updated_at=now() WHERE id=$1',
                [row.id, JSON.stringify(data), JSON.stringify(published), version],
              );
              await client.query(
                'INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)',
                [owner, 'seed.metadata.upgrade', row.id, JSON.stringify({ version })],
              );
            }
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }
        continue;
      }
      const ids: string[] = [];
      if (s.slug === 'old-observatory')
        for (const n of [
          {
            name: 'Элиас',
            role: 'Смотритель',
            personality: 'Сдержанный и наблюдательный',
            greeting: 'Вы всё-таки нашли дорогу.',
          },
          {
            name: 'Мира',
            role: 'Исследовательница',
            personality: 'Любопытная и решительная',
            greeting: 'Посмотрите на эту карту. Видите расхождение?',
          },
          {
            name: 'Тик',
            role: 'Механический помощник',
            personality: 'Педантичный и добродушный',
            greeting: 'До рассвета осталось достаточно времени. Вероятно.',
          },
        ]) {
          const id = randomUUID();
          await db.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3)', [
            id,
            owner,
            JSON.stringify(
              npcSchema.parse({
                ...curatedNpc(n),
                age: 30,
                secrets: 'Авторская заметка: ключ спрятан в старых часах.',
              }),
            ),
          ]);
          ids.push(id);
        }
      const data = adventureSchema.parse({
        title: s.title,
        synopsis: s.synopsis,
        sourceLanguage: 'ru',
        sourceRevision: 1,
        translations: {
          ru: { title: s.title, synopsis: s.synopsis, sourceRevision: 1 },
          en: { ...curated[s.slug].en, sourceRevision: 1 },
          uk: { ...curated[s.slug].uk, sourceRevision: 1 },
        },
        genre: s.genre,
        cover: s.cover,
        tags: s.tags,
        status: 'published',
        visibility: 'public',
        content: {
          world: s.world,
          rules:
            'Исследуйте, задавайте вопросы и уважайте решения других. Игровой режим появится позже.',
          locations: s.locations,
          npcIds: ids,
          scenes: s.locations.map((l) => ({
            id: `scene-${l.id}`,
            locationId: l.id,
            name: l.name,
            description: l.description,
          })),
          startSceneId: `scene-${s.locations[0].id}`,
          boundaries: ['Без откровенного контента', 'Без графического насилия'],
        },
      });
      const npcRows = ids.length
        ? (await db.query('SELECT id,data FROM npcs WHERE id=ANY($1::uuid[])', [ids])).rows
        : [];
      const publicNpcs = npcRows.map((n) => {
        const { secrets: _secrets, biography: _biography, ...safe } = n.data;
        return { ...safe, id: n.id };
      });
      const snapshot = { ...data, publicNpcs };
      const id = randomUUID();
      await db.query(
        "INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,version,data,published_snapshot,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'public')",
        [
          id,
          owner,
          s.slug,
          s.title,
          s.synopsis,
          s.genre,
          'published',
          JSON.stringify(data),
          JSON.stringify(snapshot),
        ],
      );
      await db.query(
        'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,1,$2)',
        [
          id,
          JSON.stringify({
            ...snapshot,
            npcDefinitions: npcRows.map((n) => ({ ...n.data, id: n.id })),
          }),
        ],
      );
    }
    await seedCompleteObservatory(db, owner, stories[0]);
    console.log(
      'Seed ready: original stories, model profiles and disabled external runtimes. No login passwords created.',
    );
  } finally {
    await db.end();
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
