import type { AuthoredGameDraft } from '@dreamwalk/contracts';
import { createAuthoredDraft } from './authored';

type Tr = { en: string; ru: string; uk: string };
const tr = (ru: string, uk: string, en: string): Tr => ({ ru, uk, en });
const rect = (x: number, y: number, width: number, height: number) =>
  Array.from({ length: width * height }, (_, i) => ({
    x: x + (i % width),
    y: y + Math.floor(i / width),
  }));

interface StorySpec {
  title: string;
  maps: {
    id: string;
    label: Tr;
    spawns: { x: number; y: number }[];
    blocked: { x: number; y: number }[];
  }[];
  /** Two ways across the threshold, like the Observatory: a found key or an NPC's accepted token. */
  threshold: {
    from: string;
    to: string;
    exitAt: { x: number; y: number };
    arrive: { x: number; y: number };
    doorAt: { x: number; y: number };
    keyAt: { x: number; y: number };
    keyLabel: Tr;
    doorLabel: Tr;
    tokenLabel: Tr;
    side: {
      exitAt: { x: number; y: number };
      arrive: { x: number; y: number };
      doorAt: { x: number; y: number };
      label: Tr;
    };
    back: { at: { x: number; y: number }; arrive: { x: number; y: number } };
  };
  giver: { id: string; label: Tr; at: { x: number; y: number }; fact: Tr; role: Tr };
  wanderer: { id: string; label: Tr; at: { x: number; y: number }; fact: Tr };
  goal: {
    id: string;
    label: Tr;
    at: { x: number; y: number };
    title: Tr;
    description: Tr;
    epilogue: Tr;
  };
}

function build(spec: StorySpec): AuthoredGameDraft {
  const draft = createAuthoredDraft('courtyard');
  const [startMap, farMap] = spec.maps;
  draft.title = spec.title;
  draft.npcBehavior = 'reactive-v1';
  draft.startMapId = startMap.id;
  const t = spec.threshold;
  draft.maps = spec.maps.map((m) => ({
    id: m.id,
    label: m.label.en,
    labelTranslations: { ...m.label },
    width: 24,
    height: 24,
    blocked: m.blocked,
    spawns: m.spawns,
    exits: [],
  }));
  draft.maps[0].exits = [
    {
      id: 'main-exit',
      x: t.exitAt.x,
      y: t.exitAt.y,
      destinationMapId: farMap.id,
      destination: t.arrive,
      doorId: 'door',
    },
    {
      id: 'side-exit',
      x: t.side.exitAt.x,
      y: t.side.exitAt.y,
      destinationMapId: farMap.id,
      destination: t.side.arrive,
      doorId: 'side-door',
    },
  ];
  draft.maps[1].exits = [
    {
      id: 'back-exit',
      x: t.back.at.x,
      y: t.back.at.y,
      destinationMapId: startMap.id,
      destination: t.back.arrive,
    },
  ];
  const labels: Record<string, Tr> = {
    key: t.keyLabel,
    door: t.doorLabel,
    token: t.tokenLabel,
    'side-door': t.side.label,
    [spec.goal.id]: spec.goal.label,
    [spec.giver.id]: spec.giver.label,
    [spec.wanderer.id]: spec.wanderer.label,
  };
  draft.objects = [
    {
      id: 'key',
      kind: 'item',
      label: t.keyLabel.en,
      mapId: startMap.id,
      x: t.keyAt.x,
      y: t.keyAt.y,
      visual: 'key',
    },
    {
      id: 'door',
      kind: 'door',
      label: t.doorLabel.en,
      mapId: startMap.id,
      x: t.doorAt.x,
      y: t.doorAt.y,
      visual: 'door',
      locked: true,
      open: false,
      keyId: 'key',
    },
    {
      id: 'side-door',
      kind: 'door',
      label: t.side.label.en,
      mapId: startMap.id,
      x: t.side.doorAt.x,
      y: t.side.doorAt.y,
      visual: 'door',
      locked: true,
      open: false,
      keyId: 'token',
    },
    {
      id: 'token',
      kind: 'item',
      label: t.tokenLabel.en,
      mapId: startMap.id,
      x: spec.giver.at.x,
      y: spec.giver.at.y,
      visual: 'token',
      ownerNpcId: spec.giver.id,
    },
    {
      id: spec.goal.id,
      kind: 'item',
      label: spec.goal.label.en,
      mapId: farMap.id,
      x: spec.goal.at.x,
      y: spec.goal.at.y,
      visual: 'journal',
    },
  ];
  const personality = (style: string) => ({
    role: 'helper' as const,
    values: ['kindness' as const],
    taboos: ['steal' as const],
    habits: ['keep_promises' as const],
    publicSpeechStyle: 'warm' as const,
    speechStyle: style,
    behaviorProfile: 'cookie' as const,
  });
  draft.npcs = [
    {
      id: spec.giver.id,
      label: spec.giver.label.en,
      mapId: startMap.id,
      x: spec.giver.at.x,
      y: spec.giver.at.y,
      visual: 'keeper',
      goal: 'help',
      patrolTarget: { ...spec.giver.at },
      personality: personality('patient and plain-spoken'),
      promiseTemplates: [
        {
          id: 'token-offer',
          itemId: 'token',
          offerOn: 'addressed',
          conditions: [{ kind: 'elapsed', ticks: 0 }],
          dueTicks: 1200,
          requiresAcceptance: true,
        },
      ],
      initialFacts: [
        {
          id: 'ways-across',
          title: spec.giver.role.en,
          text: spec.giver.fact.en,
          disclosure: 'public',
        },
      ],
    },
    {
      id: spec.wanderer.id,
      label: spec.wanderer.label.en,
      mapId: startMap.id,
      x: spec.wanderer.at.x,
      y: spec.wanderer.at.y,
      visual: 'traveler',
      goal: 'patrol',
      patrolTarget: { ...spec.wanderer.at },
      personality: { ...personality('quick and curious'), publicSpeechStyle: 'wry' as const },
      initialFacts: [
        {
          id: 'what-i-saw',
          title: spec.wanderer.label.en,
          text: spec.wanderer.fact.en,
          disclosure: 'public',
        },
      ],
    },
  ];
  for (const entity of [...draft.objects, ...draft.npcs])
    entity.labelTranslations = labels[entity.id];
  draft.objectives = [
    {
      id: 'story-goal',
      title: spec.goal.title.en,
      description: spec.goal.description.en,
      epilogue: spec.goal.epilogue.en,
      translations: {
        ru: {
          title: spec.goal.title.ru,
          description: spec.goal.description.ru,
          epilogue: spec.goal.epilogue.ru,
        },
        uk: {
          title: spec.goal.title.uk,
          description: spec.goal.description.uk,
          epilogue: spec.goal.epilogue.uk,
        },
        en: {
          title: spec.goal.title.en,
          description: spec.goal.description.en,
          epilogue: spec.goal.epilogue.en,
        },
      },
      completion: { mode: 'all', conditions: [{ kind: 'party_owns_item', itemId: spec.goal.id }] },
    },
  ];
  return draft;
}

/** First-party small adventure: a village whose names vanished and the path that remembers them. */
export function createForestStoryDraft(): AuthoredGameDraft {
  return build({
    title: 'Where the Forest Remembers',
    maps: [
      {
        id: 'village',
        label: tr('Деревня на краю леса', 'Село на краю лісу', 'Village at the forest edge'),
        spawns: [
          { x: 3, y: 3 },
          { x: 4, y: 3 },
          { x: 3, y: 4 },
          { x: 4, y: 4 },
        ],
        blocked: [...rect(9, 6, 3, 3), ...rect(14, 14, 3, 3)],
      },
      {
        id: 'forest',
        label: tr('Тропа шёпота', 'Стежка шепоту', 'Whispering path'),
        spawns: [{ x: 2, y: 12 }],
        blocked: [...rect(8, 5, 2, 3), ...rect(12, 15, 2, 3), ...rect(16, 8, 2, 2)],
      },
    ],
    threshold: {
      from: 'village',
      to: 'forest',
      exitAt: { x: 21, y: 12 },
      arrive: { x: 2, y: 12 },
      doorAt: { x: 20, y: 12 },
      keyAt: { x: 6, y: 10 },
      keyLabel: tr(
        'Ржавый ключ от лесной калитки',
        'Іржавий ключ від лісової хвіртки',
        'Rusty key to the forest gate',
      ),
      doorLabel: tr('Лесная калитка', 'Лісова хвіртка', 'Forest gate'),
      tokenLabel: tr('Памятный лист старосты', 'Пам’ятний лист старости', 'Elder’s memory leaf'),
      side: {
        exitAt: { x: 21, y: 17 },
        arrive: { x: 2, y: 13 },
        doorAt: { x: 20, y: 17 },
        label: tr('Заросшая лазейка', 'Заросла шпарина', 'Overgrown gap'),
      },
      back: { at: { x: 1, y: 12 }, arrive: { x: 19, y: 12 } },
    },
    giver: {
      id: 'elder',
      label: tr('Нара', 'Нара', 'Nara'),
      at: { x: 6, y: 5 },
      role: tr('Староста', 'Староста', 'Village elder'),
      fact: tr(
        'Ржавый ключ валяется на земле у колодца и открывает главную калитку. Или попроси мой памятный лист и прими его: он откроет заросшую лазейку. Книга имён лежит где-то на тропе.',
        'Іржавий ключ лежить на землі біля криниці й відчиняє головну хвіртку. Або попроси мій пам’ятний лист і прийми його: він відчинить заросле шпарину. Книга імен лежить десь на стежці.',
        'A rusty key lies on the ground by the well and opens the main gate. Or ask for my memory leaf and accept it: it opens the overgrown gap. The book of names lies somewhere on the path.',
      ),
    },
    wanderer: {
      id: 'wanderer',
      label: tr('Ивар', 'Івар', 'Ivar'),
      at: { x: 4, y: 8 },
      fact: tr(
        'Я забыл собственное имя в первую же ночь. Деревья повторяют голоса, но называют только тех, кого помнят.',
        'Я забув власне ім’я першої ж ночі. Дерева повторюють голоси, але називають лише тих, кого пам’ятають.',
        'I forgot my own name the very first night. The trees repeat voices but only name the ones they remember.',
      ),
    },
    goal: {
      id: 'names-book',
      label: tr('Книга имён', 'Книга імен', 'Book of names'),
      at: { x: 18, y: 12 },
      title: tr('Найдите книгу имён', 'Знайдіть книгу імен', 'Find the book of names'),
      description: tr(
        'Книга имён лежит на лесной тропе. Откройте калитку ключом или примите пропуск у старосты и найдите её.',
        'Книга імен лежить на лісовій стежці. Відчиніть хвіртку ключем або прийміть перепустку від старости та знайдіть її.',
        'The book of names lies on the forest path. Open the gate with the key, or accept the elder’s pass, and find it.',
      ),
      epilogue: tr(
        'Книга раскрывается сама: имена возвращаются на страницы, а следом и в деревню. Лес ничего не отнимал, он хранил их, пока кто-нибудь не придёт спросить. Приключение завершено, можно продолжить исследование.',
        'Книга розкривається сама: імена повертаються на сторінки, а за ними й у село. Ліс нічого не забирав, він зберігав їх, доки хтось не прийде спитати. Пригоду завершено, можна продовжити дослідження.',
        'The book opens by itself: the names return to its pages, and then to the village. The forest took nothing; it kept them until someone came to ask. The adventure is complete, you may keep exploring.',
      ),
    },
  });
}

/** First-party small adventure: the last lighthouse of the archipelago and a letter without an address. */
export function createLighthouseStoryDraft(): AuthoredGameDraft {
  return build({
    title: 'The Lighthouse at the Edge of the Tide',
    maps: [
      {
        id: 'harbor',
        label: tr('Тихая гавань', 'Тиха гавань', 'Quiet harbor'),
        spawns: [
          { x: 3, y: 3 },
          { x: 4, y: 3 },
          { x: 3, y: 4 },
          { x: 4, y: 4 },
        ],
        blocked: [...rect(7, 7, 3, 2), ...rect(15, 13, 2, 3)],
      },
      {
        id: 'lighthouse',
        label: tr('Маяк', 'Маяк', 'Lighthouse'),
        spawns: [{ x: 2, y: 12 }],
        blocked: [...rect(9, 4, 2, 3), ...rect(13, 14, 3, 2)],
      },
    ],
    threshold: {
      from: 'harbor',
      to: 'lighthouse',
      exitAt: { x: 21, y: 10 },
      arrive: { x: 2, y: 12 },
      doorAt: { x: 20, y: 10 },
      keyAt: { x: 5, y: 12 },
      keyLabel: tr(
        'Латунный ключ от маячной двери',
        'Латунний ключ від маячних дверей',
        'Brass key to the lighthouse door',
      ),
      doorLabel: tr('Дверь маяка', 'Двері маяка', 'Lighthouse door'),
      tokenLabel: tr('Жетон смотрительницы', 'Жетон доглядачки', 'Keeper’s tide token'),
      side: {
        exitAt: { x: 21, y: 15 },
        arrive: { x: 2, y: 13 },
        doorAt: { x: 20, y: 15 },
        label: tr(
          'Служебная дверь маяка',
          'Службові двері маяка',
          'Service door of the lighthouse',
        ),
      },
      back: { at: { x: 1, y: 12 }, arrive: { x: 19, y: 10 } },
    },
    giver: {
      id: 'keeper',
      label: tr('Брина', 'Бріна', 'Brina'),
      at: { x: 6, y: 5 },
      role: tr('Смотрительница', 'Доглядачка', 'Lighthouse keeper'),
      fact: tr(
        'Латунный ключ лежит на причале и открывает главную дверь маяка. Или попроси мой жетон и прими его: он откроет служебную дверь. Письмо без адреса оставлено наверху.',
        'Латунний ключ лежить на причалі й відчиняє головні двері маяка. Або попроси мій жетон і прийми його: він відчинить службові двері. Лист без адреси залишено нагорі.',
        'The brass key lies on the pier and opens the main lighthouse door. Or ask for my token and accept it: it opens the service door. The letter without an address was left upstairs.',
      ),
    },
    wanderer: {
      id: 'courier',
      label: tr('Сайл', 'Сайл', 'Syl'),
      at: { x: 4, y: 8 },
      fact: tr(
        'Я привёз письмо, но адреса на нём нет. Лодка без вёсел у берега — не моя, я приплыл на другой.',
        'Я привіз листа, але адреси на ньому немає. Човен без весел біля берега не мій, я припливив на іншому.',
        'I brought the letter, but it has no address. The boat without oars on the shore is not mine; I came on another.',
      ),
    },
    goal: {
      id: 'letter',
      label: tr('Письмо без адреса', 'Лист без адреси', 'Letter without an address'),
      at: { x: 18, y: 12 },
      title: tr(
        'Найдите письмо без адреса',
        'Знайдіть лист без адреси',
        'Find the letter without an address',
      ),
      description: tr(
        'Письмо оставлено на верхней площадке маяка. Откройте дверь ключом или примите жетон у смотрительницы.',
        'Лист залишено на верхньому майданчику маяка. Відчиніть двері ключем або прийміть жетон від доглядачки.',
        'The letter was left on the lighthouse’s upper landing. Open the door with the key, or accept the keeper’s token.',
      ),
      epilogue: tr(
        'В письме одна строка: «Свет вернётся к тому, кто его попросит». Теперь ясно, почему маяк погас: никто не просил. Приключение завершено, можно продолжить исследование.',
        'У листі один рядок: «Світло повернеться до того, хто його попросить». Тепер ясно, чому маяк погас: ніхто не просив. Пригоду завершено, можна продовжити дослідження.',
        'The letter holds one line: “The light will return to whoever asks for it.” Now it is clear why the lighthouse went dark: nobody asked. The adventure is complete, you may keep exploring.',
      ),
    },
  });
}
