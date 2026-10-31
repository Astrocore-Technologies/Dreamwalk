import type { AuthoredGameDraft } from '@dreamwalk/contracts';
import { createAuthoredDraft } from './authored';

/** Curated small adventure; never mutates legacy fixture definitions or existing saves. */
export function createCompleteObservatoryDraft(): AuthoredGameDraft {
  const draft = createAuthoredDraft('observatory');
  draft.title = 'The Observatory: Lost Observations';
  draft.npcBehavior = 'reactive-v1';
  const interior = draft.maps.find((map) => map.id === 'observatory')!;
  const roof = draft.maps.find((map) => map.id === 'roof')!;
  interior.labelTranslations = { en: 'Observatory', ru: 'Обсерватория', uk: 'Обсерваторія' };
  roof.labelTranslations = { en: 'Rooftop', ru: 'Крыша', uk: 'Дах' };
  interior.sceneProfile = 'observatory-interior-v1';
  roof.sceneProfile = 'observatory-roof-v1';
  interior.exits.find((exit) => exit.id === 'roof-exit')!.doorId = 'door';
  interior.exits.push({
    id: 'side-roof-exit',
    x: 8,
    y: 9,
    destinationMapId: 'roof',
    destination: { x: 2, y: 3 },
    doorId: 'side-door',
  });
  draft.objects.push(
    {
      id: 'side-door',
      kind: 'door',
      label: 'Service stair door',
      mapId: 'observatory',
      x: 8,
      y: 8,
      visual: 'door',
      locked: true,
      open: false,
      keyId: 'token',
    },
    {
      id: 'journal',
      kind: 'item',
      label: 'Observation journal',
      mapId: 'roof',
      x: 7,
      y: 4,
      visual: 'journal',
    },
  );
  const keeper = draft.npcs.find((npc) => npc.id === 'keeper')!;
  // This small scene has a staffed post: do not walk away while a player reads the offer.
  keeper.patrolTarget = { x: keeper.x, y: keeper.y };
  keeper.personality = {
    role: 'helper',
    values: ['kindness'],
    taboos: ['steal'],
    habits: ['keep_promises'],
    publicSpeechStyle: 'warm',
    speechStyle: 'patient and practical',
    behaviorProfile: 'cookie',
  };
  keeper.promiseTemplates = [
    {
      id: 'roof-pass',
      itemId: 'token',
      offerOn: 'addressed',
      conditions: [{ kind: 'elapsed', ticks: 0 }],
      dueTicks: 1200,
      requiresAcceptance: true,
    },
  ];
  keeper.initialFacts = [
    {
      id: 'two-stairways',
      title: 'How do we reach the roof?',
      text: 'The brass key on the floor opens the main stair door. Ask me for my service token and accept my offer to use the side stair door instead. The observation journal is on the roof.',
      disclosure: 'public',
    },
  ];
  draft.objectives = [
    {
      id: 'recover-journal',
      title: 'Recover the observation journal',
      description:
        'Find the journal on the roof. Use the brass key for the main stairs, or talk to the keeper and accept his service token for the side stairs.',
      epilogue:
        'The journal explains that the mechanism projects a map of the coming dawn. The ‘new star’ is its light marker, and the clock counts down to that dawn rather than showing the current hour. The keeper’s warning now makes sense. The journal is recovered and the mystery solved. Your expedition is complete; you may keep exploring.',
      translations: {
        ru: {
          title: 'Найдите журнал наблюдений',
          description:
            'Журнал остался на крыше. Найдите латунный ключ от главной лестницы или поговорите со смотрителем и примите его пропуск для боковой лестницы.',
          epilogue:
            'В журнале записано: механизм проецирует карту ещё не наступившего рассвета. «Новая звезда» — его световая отметка, а часы отсчитывают время до рассвета, не показывают нынешний час. Теперь предупреждение смотрителя понятно. Журнал найден, загадка разгадана. Экспедиция завершена — можно продолжить исследование.',
        },
        uk: {
          title: 'Знайдіть журнал спостережень',
          description:
            'Журнал залишився на даху. Знайдіть латунний ключ від головних сходів або поговоріть із доглядачем і прийміть його перепустку для бічних сходів.',
          epilogue:
            'У журналі записано: механізм проєктує карту майбутнього світанку. «Нова зоря» — його світлова позначка, а годинник відлічує час до світанку, а не показує поточну годину. Тепер попередження доглядача зрозуміле. Журнал знайдено, загадку розгадано. Експедицію завершено — можна продовжити дослідження.',
        },
        en: {
          title: 'Recover the observation journal',
          description:
            'Find the journal on the roof. Use the brass key for the main stairs, or talk to the keeper and accept his service token for the side stairs.',
          epilogue:
            'The journal explains that the mechanism projects a map of the coming dawn. The ‘new star’ is its light marker, and the clock counts down to that dawn rather than showing the current hour. The keeper’s warning now makes sense. The journal is recovered and the mystery solved. Your expedition is complete; you may keep exploring.',
        },
      },
      completion: { mode: 'all', conditions: [{ kind: 'party_owns_item', itemId: 'journal' }] },
    },
  ];
  const labels: Record<string, { en: string; ru: string; uk: string }> = {
    key: { en: 'Brass key', ru: 'Латунный ключ', uk: 'Латунний ключ' },
    door: { en: 'Main stair door', ru: 'Дверь главной лестницы', uk: 'Двері головних сходів' },
    token: { en: 'Service token', ru: 'Служебный пропуск', uk: 'Службова перепустка' },
    'side-door': {
      en: 'Service stair door',
      ru: 'Дверь боковой лестницы',
      uk: 'Двері бічних сходів',
    },
    journal: { en: 'Observation journal', ru: 'Журнал наблюдений', uk: 'Журнал спостережень' },
    keeper: { en: 'Keeper', ru: 'Смотритель', uk: 'Доглядач' },
  };
  for (const entity of [...draft.objects, ...draft.npcs])
    entity.labelTranslations = labels[entity.id];
  for (const map of draft.maps)
    for (const exit of map.exits)
      exit.labelTranslations =
        exit.destinationMapId === 'roof'
          ? { ...roof.labelTranslations }
          : { ...interior.labelTranslations };
  return draft;
}
