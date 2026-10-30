'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { compilePlayableDraft, createAuthoredDraft } from '@dreamwalk/game-core';
import type { AuthoredGameDraft, Npc } from '@dreamwalk/contracts';
import { api, ApiError, errorMessage, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input, Loading, Select } from '@/components/ui';
import { useDraftAutosave } from '@/lib/use-draft-autosave';
import { AutosaveStatus } from './autosave-status';
import { LivingNpcProfile } from './living-npc-profile';
import { LivingNpcPreview } from './living-npc-preview';
import styles from './playable-map-editor.module.css';

type Tool = 'select' | 'wall' | 'spawn' | 'key' | 'token' | 'door' | 'npc' | 'exit';
type DraftResponse = { draft: AuthoredGameDraft | null; revision: number };
const toolLabels: Record<Tool, string> = {
  select: 'Выбрать объект',
  wall: 'Стена',
  spawn: 'Точка появления',
  key: 'Ключ',
  token: 'Жетон',
  door: 'Дверь',
  npc: 'NPC',
  exit: 'Переход',
};
const identifier = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
export function PlayableMapEditor({
  adventureId,
  title,
  npcs,
  locations,
  onDirty,
  preview = false,
  flushRef,
}: {
  adventureId: string;
  title: string;
  npcs: Npc[];
  locations: { id: string; name: string }[];
  onDirty: (dirty: boolean) => void;
  preview?: boolean;
  flushRef?: { current: (() => Promise<void>) | null };
}) {
  const { t } = useT();
  const router = useRouter();
  const resource = useResource<DraftResponse>(`/studio/adventures/${adventureId}/playable-draft`);
  const [draft, setDraft] = useState<AuthoredGameDraft | null>(null);
  const [mapId, setMapId] = useState('');
  const [hydration, setHydration] = useState(0);
  const baseline = useRef<AuthoredGameDraft | null>(null),
    acknowledged = useRef<DraftResponse | null>(null),
    reloadAllowed = useRef(false);
  const [tool, setTool] = useState<Tool>('select'),
    [selection, setSelection] = useState('');
  const [destination, setDestination] = useState('');
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (resource.data && resource.data !== acknowledged.current) {
      if (hydration > 0 && dirty && !reloadAllowed.current) return;
      reloadAllowed.current = false;
      baseline.current = resource.data.draft;
      setDraft(resource.data.draft);
      setMapId(resource.data.draft?.maps[0]?.id || '');
      setDirty(false);
      setHydration((value) => value + 1);
    }
  }, [resource.data]);
  const autosave = useDraftAutosave<AuthoredGameDraft | null, DraftResponse>({
    enabled: hydration > 0 && !!draft,
    identity: `${adventureId}:${hydration}`,
    draft,
    baseline: baseline.current,
    revision: resource.data?.revision || 0,
    initialResult: resource.data || { draft: null, revision: 0 },
    validate: (value) => !!value && compilePlayableDraft(value).errors.length === 0,
    persist: async (value, revision) => {
      const result = await api<DraftResponse>(`/studio/adventures/${adventureId}/playable-draft`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision: revision, draft: value }),
      });
      return { result, revision: result.revision };
    },
    onAcknowledged: (result, stillDirty) => {
      acknowledged.current = result;
      resource.setData(result);
      setDirty(stillDirty);
    },
  });
  useEffect(() => {
    if (hydration > 0 && draft) setDirty(autosave.dirty);
  }, [autosave.dirty, hydration, !!draft]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = draft
      ? async () => {
          await autosave.flush();
        }
      : null;
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, autosave.flush, !!draft]);
  function reloadDraft() {
    if (window.confirm(t('Заменить локальные изменения серверной версией?'))) {
      reloadAllowed.current = true;
      resource.reload();
    }
  }
  function change(next: AuthoredGameDraft) {
    setDraft(next);
    setDirty(true);
    setSaved(false);
  }
  function begin(template: 'observatory' | 'courtyard', reactive = false) {
    if (
      draft &&
      !window.confirm(t('Заменить карту шаблоном? Несохранённая игровая раскладка будет заменена.'))
    )
      return;
    const next = createAuthoredDraft(template);
    next.title = title || t('Новая история');
    if (reactive) {
      next.npcBehavior = 'reactive-v1';
      next.npcs[0] = {
        ...next.npcs[0],
        goal: 'patrol',
        patrolTarget: { x: 6, y: 4 },
        personality: {
          role: 'guard',
          values: ['duty', 'caution'],
          taboos: ['steal', 'disclose_private'],
          speechStyle: '',
        },
      };
      next.npcs.push({
        id: 'helper',
        label: t('Помощник'),
        mapId: next.startMapId,
        x: 7,
        y: 6,
        visual: 'traveler',
        goal: 'help',
        patrolTarget: { x: 7, y: 6 },
        personality: {
          role: 'helper',
          values: ['kindness', 'honesty'],
          taboos: ['steal', 'harm', 'disclose_private'],
          speechStyle: '',
        },
      });
      const token = next.objects.find((item) => item.id === 'token');
      if (token) Object.assign(token, { ownerNpcId: 'helper', x: 7, y: 6 });
    }
    const names: Record<string, string> = {
      Observatory: 'Обсерватория',
      Rooftop: 'Крыша',
      Courtyard: 'Внутренний двор',
      Garden: 'Сад',
      'Brass key': 'Латунный ключ',
      'Old door': 'Старая дверь',
      'Keeper token': 'Жетон смотрителя',
      Keeper: 'Смотритель',
    };
    for (const value of [...next.maps, ...next.objects, ...next.npcs])
      if (names[value.label]) value.label = t(names[value.label]);
    change(next);
    setMapId(next.maps[0].id);
    setSelection('');
  }
  async function save(launch = false) {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      // Flush the same serialized autosave writer, including any newer in-flight edits.
      const result = await autosave.flush();
      setDirty(false);
      onDirty(false);
      setSaved(true);
      if (launch) {
        const version = await api<{ versionId: string }>(
          `/studio/adventures/${adventureId}/playable-versions`,
          { method: 'POST', body: JSON.stringify({ expectedRevision: result.revision }) },
        );
        const campaign = await api<{ campaignId: string }>('/game/campaigns', {
          method: 'POST',
          body: JSON.stringify({ playableVersionId: version.versionId }),
        });
        router.push(`/game/${campaign.campaignId}`);
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INVALID_MAP'
          ? t(
              'Карта не прошла проверку. Проверь стены, точки появления, выходы и доступность ключей.',
            )
          : err instanceof ApiError && err.code === 'STALE_STATE'
            ? t('Черновик карты изменён в другой вкладке. Перезагрузи редактор перед сохранением.')
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  const map = draft?.maps.find((value) => value.id === mapId) || draft?.maps[0];
  const object = draft?.objects.find((value) => `object:${value.id}` === selection);
  const npc = draft?.npcs.find((value) => `npc:${value.id}` === selection);
  const exit = map?.exits.find((value) => `exit:${value.id}` === selection);
  const selected = object || npc || exit;
  function updateMap(patch: Partial<AuthoredGameDraft['maps'][number]>) {
    if (draft && map)
      change({
        ...draft,
        maps: draft.maps.map((value) => (value.id === map.id ? { ...value, ...patch } : value)),
      });
  }
  function place(x: number, y: number) {
    if (!draft || !map || preview) return;
    if (tool === 'select') {
      const item = draft.objects.find(
        (value) => value.mapId === map.id && value.x === x && value.y === y,
      );
      const actor = draft.npcs.find(
        (value) => value.mapId === map.id && value.x === x && value.y === y,
      );
      const transition = map.exits.find((value) => value.x === x && value.y === y);
      setSelection(
        item
          ? `object:${item.id}`
          : actor
            ? `npc:${actor.id}`
            : transition
              ? `exit:${transition.id}`
              : '',
      );
      return;
    }
    if (tool === 'wall') {
      const exists = map.blocked.some((point) => point.x === x && point.y === y);
      updateMap({
        blocked: exists
          ? map.blocked.filter((point) => point.x !== x || point.y !== y)
          : [...map.blocked, { x, y }],
      });
      return;
    }
    if (tool === 'spawn') {
      updateMap({ spawns: [{ x, y }] });
      return;
    }
    if (tool === 'exit') {
      const target = draft.maps.find((value) => value.id === destination);
      if (!target || target.id === map.id) {
        setError(t('Сначала выбери другую карту для перехода.'));
        return;
      }
      const id = identifier('exit');
      updateMap({
        exits: [
          ...map.exits,
          { id, x, y, destinationMapId: target.id, destination: target.spawns[0] },
        ],
      });
      setSelection(`exit:${id}`);
      return;
    }
    if (tool === 'npc') {
      if (draft.npcs.length >= 8) return;
      const id = identifier('npc');
      change({
        ...draft,
        npcs: [
          ...draft.npcs,
          {
            id,
            label: t('Смотритель'),
            mapId: map.id,
            x,
            y,
            visual: 'keeper',
            goal: 'patrol',
            patrolTarget: { x, y },
          },
        ],
      });
      setSelection(`npc:${id}`);
      return;
    }
    if (draft.objects.length >= 32) return;
    const id = identifier(tool);
    const value: AuthoredGameDraft['objects'][number] = {
      id,
      kind: tool === 'door' ? 'door' : 'item',
      label: t(toolLabels[tool]),
      mapId: map.id,
      x,
      y,
      visual: tool,
      ...(tool === 'door' ? { open: false, locked: false } : {}),
    };
    change({ ...draft, objects: [...draft.objects, value] });
    setSelection(`object:${id}`);
  }
  function patchSelected(patch: Record<string, unknown>) {
    if (!draft || !map) return;
    if (object)
      change({
        ...draft,
        objects: draft.objects.map((value) =>
          value.id === object.id ? { ...value, ...patch } : value,
        ),
      });
    else if (npc)
      change({
        ...draft,
        npcs: draft.npcs.map((value) => (value.id === npc.id ? { ...value, ...patch } : value)),
      });
    else if (exit)
      updateMap({
        exits: map.exits.map((value) => (value.id === exit.id ? { ...value, ...patch } : value)),
      });
  }
  function removeSelected() {
    if (!draft || !map || !selected || !window.confirm(t('Удалить выбранный игровой объект?')))
      return;
    if (object)
      change({ ...draft, objects: draft.objects.filter((value) => value.id !== object.id) });
    else if (npc) change({ ...draft, npcs: draft.npcs.filter((value) => value.id !== npc.id) });
    else if (exit) updateMap({ exits: map.exits.filter((value) => value.id !== exit.id) });
    setSelection('');
  }
  return (
    <section className={styles.editor} aria-label={t('Игровая карта')}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <header>
          <div>
            <h2>{t('Игровая карта')}</h2>
            <p>
              {t(
                'Шаблон превращается в настоящую карту. Текст истории сам по себе не создаёт игровую механику.',
              )}
            </p>
          </div>
          <span className={styles.status}>
            {t(dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены')}
          </span>
        </header>
        <AutosaveStatus
          status={autosave.status}
          enabled={hydration > 0 && !!draft}
          retry={() => {
            void autosave.flush().catch(() => {});
          }}
          reload={reloadDraft}
        />
        <ErrorBox message={error} />
        {!draft || !map ? (
          <div className={styles.templates}>
            <p>{t('Игровая карта ещё не добавлена. Выбери начальный шаблон.')}</p>
            <Button type="button" onClick={() => begin('observatory')}>
              {t('Шаблон: обсерватория')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => begin('courtyard')}>
              {t('Шаблон: внутренний двор')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => begin('courtyard', true)}>
              {t('Шаблон: смотритель и помощник')}
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.fields}>
              <Field label={t('Название прохождения')}>
                <Input
                  value={draft.title}
                  maxLength={120}
                  disabled={preview}
                  onChange={(event) => change({ ...draft, title: event.target.value })}
                />
              </Field>
              <Field label={t('Стартовая карта')}>
                <Select
                  aria-label={t('Стартовая карта')}
                  value={draft.startMapId}
                  disabled={preview}
                  onChange={(event) => change({ ...draft, startMapId: event.target.value })}
                >
                  {draft.maps.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset className={styles.livingPolicy} disabled={preview}>
              <legend>{t('Самостоятельные NPC')}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={draft.npcBehavior === 'reactive-v1'}
                  onChange={(event) =>
                    change({
                      ...draft,
                      npcBehavior: event.target.checked ? 'reactive-v1' : undefined,
                    })
                  }
                />
                {t('Включить личную память и самостоятельные реакции')}
              </label>
              <p>
                {t(
                  'Новая версия использует наблюдения, отношения и обещания. Уже запущенные кампании не меняются.',
                )}
              </p>
              <p>
                {t(
                  'Решения работают на бесплатных тестовых правилах. Платный AI не включается этим переключателем.',
                )}
              </p>
            </fieldset>
            <div className={styles.mapNav}>
              {draft.maps.map((value) => (
                <button
                  type="button"
                  key={value.id}
                  aria-pressed={map.id === value.id}
                  onClick={() => {
                    setMapId(value.id);
                    setSelection('');
                  }}
                >
                  {value.label}
                </button>
              ))}
              {!preview && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={draft.maps.length >= 3}
                  onClick={() => {
                    const base = createAuthoredDraft('courtyard').maps[0];
                    const id = identifier('map');
                    change({
                      ...draft,
                      maps: [...draft.maps, { ...base, id, label: t('Новая карта'), exits: [] }],
                    });
                    setMapId(id);
                  }}
                >
                  {t('Добавить карту')}
                </Button>
              )}
            </div>
            {!preview && (
              <div className={styles.fields}>
                <Field label={t('Название карты')}>
                  <Input
                    value={map.label}
                    maxLength={120}
                    onChange={(event) => updateMap({ label: event.target.value })}
                  />
                </Field>
                <Field label={t('Связь с локацией истории')}>
                  <Select
                    aria-label={t('Связь с локацией истории')}
                    value={map.sourceLocationId || ''}
                    onChange={(event) =>
                      updateMap({ sourceLocationId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t('Без связи с текстовой локацией')}</option>
                    {locations.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('Инструмент карты')}>
                  <Select
                    aria-label={t('Инструмент карты')}
                    value={tool}
                    onChange={(event) => setTool(event.target.value as Tool)}
                  >
                    {Object.entries(toolLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {t(label)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {tool === 'exit' && (
                  <Field label={t('Карта назначения')}>
                    <Select
                      aria-label={t('Карта назначения')}
                      value={destination}
                      onChange={(event) => setDestination(event.target.value)}
                    >
                      <option value="">{t('Выбрать')}</option>
                      {draft.maps
                        .filter((value) => value.id !== map.id)
                        .map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.label}
                          </option>
                        ))}
                    </Select>
                  </Field>
                )}
              </div>
            )}
            {!preview && (
              <Field label={t('Объект на карте')}>
                <Select
                  aria-label={t('Объект на карте')}
                  value={selection}
                  onChange={(event) => setSelection(event.target.value)}
                >
                  <option value="">{t('Выбрать объект')}</option>
                  {draft.objects
                    .filter((value) => value.mapId === map.id)
                    .map((value) => (
                      <option key={value.id} value={`object:${value.id}`}>
                        {value.label}
                      </option>
                    ))}
                  {draft.npcs
                    .filter((value) => value.mapId === map.id)
                    .map((value) => (
                      <option key={value.id} value={`npc:${value.id}`}>
                        {value.label}
                      </option>
                    ))}
                  {map.exits.map((value) => (
                    <option key={value.id} value={`exit:${value.id}`}>
                      {t('Переход')} ·{' '}
                      {draft.maps.find((candidate) => candidate.id === value.destinationMapId)
                        ?.label || value.id}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className={styles.layout}>
              <div className={styles.gridScroll}>
                <div
                  className={styles.grid}
                  style={{ gridTemplateColumns: `repeat(${map.width}, 30px)` }}
                  role="group"
                  aria-label={t('Раскладка карты')}
                >
                  {Array.from({ length: map.width * map.height }, (_, index) => {
                    const x = index % map.width,
                      y = Math.floor(index / map.width);
                    const blocked = map.blocked.some((point) => point.x === x && point.y === y);
                    const tileObject = draft.objects.find(
                      (value) => value.mapId === map.id && value.x === x && value.y === y,
                    );
                    const tileNpc = draft.npcs.find(
                      (value) => value.mapId === map.id && value.x === x && value.y === y,
                    );
                    const tileExit = map.exits.find((value) => value.x === x && value.y === y);
                    const spawn = map.spawns.some((point) => point.x === x && point.y === y);
                    const symbol = tileNpc
                      ? '♟'
                      : tileObject?.kind === 'door'
                        ? '▣'
                        : tileObject?.visual === 'key'
                          ? '⚿'
                          : tileObject
                            ? '◇'
                            : tileExit
                              ? '↗'
                              : spawn
                                ? '◎'
                                : blocked
                                  ? '■'
                                  : '·';
                    return (
                      <button
                        type="button"
                        key={index}
                        disabled={preview}
                        className={blocked ? styles.wall : styles.tile}
                        aria-label={t('Клетка {x}, {y}: {object}', {
                          x,
                          y,
                          object:
                            tileNpc?.label ||
                            tileObject?.label ||
                            t(
                              tileExit
                                ? 'Переход'
                                : spawn
                                  ? 'Точка появления'
                                  : blocked
                                    ? 'Стена'
                                    : 'Пол',
                            ),
                        })}
                        onClick={() => place(x, y)}
                      >
                        {symbol}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={styles.inspector}>
                {selected && !preview ? (
                  <>
                    <h3>{t('Выбранный объект')}</h3>
                    {(object || npc) && (
                      <Field label={t('Название')}>
                        <Input
                          value={(object || npc)!.label}
                          maxLength={120}
                          onChange={(event) => patchSelected({ label: event.target.value })}
                        />
                      </Field>
                    )}
                    <div className={styles.coordinates}>
                      <Field label={t('Координата X')}>
                        <Input
                          type="number"
                          min={0}
                          max={map.width - 1}
                          value={selected.x}
                          onChange={(event) => patchSelected({ x: Number(event.target.value) })}
                        />
                      </Field>
                      <Field label={t('Координата Y')}>
                        <Input
                          type="number"
                          min={0}
                          max={map.height - 1}
                          value={selected.y}
                          onChange={(event) => patchSelected({ y: Number(event.target.value) })}
                        />
                      </Field>
                    </div>
                    {object?.kind === 'item' && (
                      <Field label={t('Владелец предмета')}>
                        <Select
                          aria-label={t('Владелец предмета')}
                          value={object.ownerNpcId || ''}
                          onChange={(event) =>
                            patchSelected({ ownerNpcId: event.target.value || undefined })
                          }
                        >
                          <option value="">{t('Лежит на карте')}</option>
                          {draft.npcs.map((value) => (
                            <option key={value.id} value={value.id}>
                              {value.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {object?.kind === 'door' && (
                      <>
                        <label>
                          <input
                            type="checkbox"
                            checked={!!object.locked}
                            onChange={(event) =>
                              patchSelected({ locked: event.target.checked, open: false })
                            }
                          />
                          {t('Заперта в начале')}
                        </label>
                        <Field label={t('Ключ от двери')}>
                          <Select
                            aria-label={t('Ключ от двери')}
                            value={object.keyId || ''}
                            onChange={(event) =>
                              patchSelected({ keyId: event.target.value || undefined })
                            }
                          >
                            <option value="">{t('Без ключа')}</option>
                            {draft.objects
                              .filter((value) => value.kind === 'item')
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.label}
                                </option>
                              ))}
                          </Select>
                        </Field>
                      </>
                    )}
                    {npc && (
                      <>
                        <Field label={t('Персонаж из библиотеки')}>
                          <Select
                            aria-label={t('Персонаж из библиотеки')}
                            value={npc.sourceNpcId || ''}
                            onChange={(event) => {
                              const source = npcs.find((value) => value.id === event.target.value);
                              patchSelected({
                                sourceNpcId: source?.id,
                                ...(source ? { label: source.name } : {}),
                              });
                            }}
                          >
                            <option value="">{t('Тестовый NPC')}</option>
                            {npcs.map((value) => (
                              <option key={value.id} value={value.id}>
                                {value.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t('Поведение NPC')}>
                          <Select
                            aria-label={t('Поведение NPC')}
                            value={npc.goal}
                            onChange={(event) => patchSelected({ goal: event.target.value })}
                          >
                            <option value="patrol">{t('Патруль')}</option>
                            <option value="help">{t('Помощник')}</option>
                          </Select>
                        </Field>
                        {draft.npcBehavior === 'reactive-v1' && (
                          <LivingNpcProfile
                            npc={npc}
                            entities={[...draft.objects, ...draft.npcs]}
                            npcs={draft.npcs}
                            onKnowledge={(initialKnowledge) => patchSelected({ initialKnowledge })}
                            onChange={(personality) => patchSelected({ personality })}
                          />
                        )}
                        {draft.npcBehavior === 'reactive-v1' && (
                          <LivingNpcPreview
                            adventureId={adventureId}
                            npcId={npc.id}
                            flush={async () => (await autosave.flush()).revision}
                          />
                        )}
                        <div className={styles.coordinates}>
                          <Field label={t('Цель патруля X')}>
                            <Input
                              type="number"
                              min={0}
                              max={map.width - 1}
                              value={npc.patrolTarget?.x ?? npc.x}
                              onChange={(event) =>
                                patchSelected({
                                  patrolTarget: {
                                    x: Number(event.target.value),
                                    y: npc.patrolTarget?.y ?? npc.y,
                                  },
                                })
                              }
                            />
                          </Field>
                          <Field label={t('Цель патруля Y')}>
                            <Input
                              type="number"
                              min={0}
                              max={map.height - 1}
                              value={npc.patrolTarget?.y ?? npc.y}
                              onChange={(event) =>
                                patchSelected({
                                  patrolTarget: {
                                    x: npc.patrolTarget?.x ?? npc.x,
                                    y: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </Field>
                        </div>
                      </>
                    )}
                    {exit && (
                      <>
                        <Field label={t('Карта назначения')}>
                          <Select
                            aria-label={t('Карта назначения')}
                            value={exit.destinationMapId}
                            onChange={(event) => {
                              const target = draft.maps.find(
                                (value) => value.id === event.target.value,
                              );
                              if (target)
                                patchSelected({
                                  destinationMapId: target.id,
                                  destination: target.spawns[0],
                                });
                            }}
                          >
                            {draft.maps
                              .filter((value) => value.id !== map.id)
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.label}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label={t('Дверь перехода')}>
                          <Select
                            aria-label={t('Дверь перехода')}
                            value={exit.doorId || ''}
                            onChange={(event) =>
                              patchSelected({ doorId: event.target.value || undefined })
                            }
                          >
                            <option value="">{t('Без двери')}</option>
                            {draft.objects
                              .filter((value) => value.kind === 'door' && value.mapId === map.id)
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.label}
                                </option>
                              ))}
                          </Select>
                        </Field>
                      </>
                    )}
                    <Button type="button" variant="danger" onClick={removeSelected}>
                      {t('Удалить объект')}
                    </Button>
                  </>
                ) : (
                  <p>
                    {t(
                      preview
                        ? 'Это сохранённая игровая раскладка, а не иллюстрация.'
                        : 'Выбери инструмент и клетку. Для свойств выбери существующий объект.',
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className={styles.fields}>
              <Field label={t('Раундов в столкновении')}>
                <Input
                  disabled={preview}
                  type="number"
                  min={2}
                  max={10}
                  value={draft.roundPolicy.maxRounds}
                  onChange={(event) =>
                    change({
                      ...draft,
                      roundPolicy: { ...draft.roundPolicy, maxRounds: Number(event.target.value) },
                    })
                  }
                />
              </Field>
              <Field label={t('Секунд на планирование')}>
                <Input
                  disabled={preview}
                  type="number"
                  min={5}
                  max={120}
                  value={draft.roundPolicy.planningMs / 1000}
                  onChange={(event) =>
                    change({
                      ...draft,
                      roundPolicy: {
                        ...draft.roundPolicy,
                        planningMs: Number(event.target.value) * 1000,
                      },
                    })
                  }
                />
              </Field>
            </div>
            <p className={styles.note}>
              {t(
                'Проверка сервера обязательна: проходимость, ключи, выходы и точки появления. Ошибочная карта не запускается.',
              )}
            </p>
            <div className={styles.actions}>
              <Button type="button" busy={busy} onClick={() => void save(false)}>
                {t('Сохранить игровую карту')}
              </Button>
              <Button type="button" busy={busy} variant="secondary" onClick={() => void save(true)}>
                {t('Сохранить и проверить в игре')}
              </Button>
            </div>
            {saved && <p role="status">{t('Игровая карта сохранена')}</p>}
            <p className={styles.note}>
              {t(
                'Тест создаёт отдельную неизменяемую приватную версию. Публичный запуск появится только после модерации.',
              )}
            </p>
          </>
        )}
      </fieldset>
    </section>
  );
}
