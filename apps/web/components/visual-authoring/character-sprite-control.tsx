'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Textarea } from '../ui';
import { ExternalGeneration } from './external-generation';
import { admittedConcept, type GenerationProject, type GenerationState } from './generation-types';
import type { LiveTestStatus } from '../live-test/types';
const messages = {
  title: ['Образ на карте', 'In-world appearance', 'Образ на мапі'],
  appearance: [
    'Описание внешности (для героя обязательно, если нет портрета)',
    'Appearance (required for a hero without a portrait)',
    'Опис зовнішності (для героя обов’язковий без портрета)',
  ],
  prepare: ['Подготовить спрайт', 'Prepare sprite', 'Підготувати спрайт'],
  photo: [
    'Разрешаю использовать мой загруженный портрет как приватный референс',
    'Allow my uploaded portrait as a private reference',
    'Дозволяю використати мій завантажений портрет як приватний референс',
  ],
  share: [
    'Разрешить отдельные разрешения на использование результата другими авторами',
    'Allow separate grants to reuse the result',
    'Дозволити окремі дозволи на використання результату іншими авторами',
  ],
  review: [
    'Я посмотрел изображение: внешность и полный рост подходят',
    'I reviewed the image: identity and full body are suitable',
    'Я переглянув зображення: зовнішність і повний зріст підходять',
  ],
  approve: ['Утвердить образ', 'Approve appearance', 'Затвердити образ'],
  equip: ['Сохранить и привязать спрайт', 'Save and bind sprite', 'Зберегти та прив’язати спрайт'],
  done: [
    'Образ сохранён. Новая игра использует этот спрайт; текущая игра сохраняет свой закреплённый образ.',
    'Appearance saved. New games use this sprite; existing games retain their pinned appearance.',
    'Образ збережено. Нова гра використовує цей спрайт; поточна зберігає свій закріплений образ.',
  ],
  info: [
    'Статичный рисованный 2D-спрайт. Генерация запускается только после отдельной цены и согласия. Прежний образ сохранится до успешной замены.',
    'A static drawn 2D sprite. Generation requires a quote and explicit consent. Previous appearance remains until successful replacement.',
    'Статичний мальований 2D-спрайт. Генерація потребує ціни й явної згоди. Попередній образ зберігається до успішної заміни.',
  ],
} as const;
/** Independent mount point for the story NPC form and hero library; never starts generation on mount. */
export function CharacterSpriteControl({
  target,
  onSaved,
}: {
  target: { kind: 'npc' | 'hero'; id: string };
  onSaved?: () => void;
}) {
  const { locale } = useT(),
    i = locale === 'ru' ? 0 : locale === 'en' ? 1 : 2,
    t = (k: keyof typeof messages) => messages[k][i];
  const [appearance, setAppearance] = useState(''),
    [photo, setPhoto] = useState(false),
    [share, setShare] = useState(false),
    [review, setReview] = useState(false);
  const [project, setProject] = useState<GenerationProject | null>(null),
    [generation, setGeneration] = useState<GenerationState | null>(null),
    [session, setSession] = useState<LiveTestStatus | null>(null),
    [busy, setBusy] = useState(false),
    [generating, setGenerating] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [packageId, setPackageId] = useState<string | null>(null);
  const lock = useRef(false),
    operations = useRef(new Map<string, string>()),
    stamp = useRef(0);
  const keepGeneration = useCallback((v: GenerationState | null) => setGeneration(v), []),
    keepBusy = useCallback((v: boolean) => setGenerating(v), []);
  useEffect(() => {
    stamp.current++;
    setProject(null);
    setGeneration(null);
    setSaved(false);
    setPackageId(null);
    operations.current.clear();
  }, [target.kind, target.id]);
  useEffect(() => {
    let active = true;
    void api<LiveTestStatus>('/generation/status')
      .then((v) => {
        if (active) setSession(v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [project?.id]);
  const mutate = async (path: string, body: object) => {
    const key = JSON.stringify({ path, body });
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    return api(path, {
      method: 'POST',
      body: JSON.stringify({ ...body, operationId: operations.current.get(key) }),
    });
  };
  async function act(kind: 'prepare' | 'approve' | 'equip') {
    if (lock.current || generating) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const epoch = stamp.current;
    try {
      if (kind === 'prepare') {
        const p = (await mutate('/visual-authoring/character-sprite/prepare', {
          target,
          ...(appearance.trim() ? { appearance: appearance.trim() } : {}),
          sourcePhotoPermission: photo,
          allowOutputReuse: share,
        })) as GenerationProject;
        if (epoch === stamp.current) {
          setProject(p);
          setReview(false);
          setSaved(false);
        }
      } else if (project && kind === 'approve') {
        const p = (await mutate('/visual-authoring/projects/' + project.id + '/approve', {
          expectedRevision: project.revision,
          consent: true,
        })) as GenerationProject;
        if (epoch === stamp.current) setProject(p);
      } else if (project) {
        let id = packageId;
        if (!id) {
          const pkg = (await mutate('/visual-authoring/projects/' + project.id + '/complete', {
            expectedRevision: project.revision,
            consent: true,
            visualReview: true,
          })) as { id: string };
          id = pkg.id;
          if (epoch === stamp.current) setPackageId(id);
        }
        await mutate('/visual-authoring/packages/' + id + '/equip', {
          heroId: target.id,
          targetType: target.kind,
          createTarget: false,
        });
        if (epoch === stamp.current) {
          setSaved(true);
          onSaved?.();
        }
      }
    } catch (e) {
      if (epoch === stamp.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{t('title')}</h3>
      <p>{t('info')}</p>
      {!project && (
        <>
          <Field label={t('appearance')}>
            <Textarea
              value={appearance}
              onChange={(e) => setAppearance(e.target.value)}
              maxLength={1500}
            />
          </Field>
          <label>
            <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />
            {t('photo')}
          </label>
          <br />
          <label>
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            {t('share')}
          </label>
          <br />
          <Button busy={busy} onClick={() => void act('prepare')}>
            {t('prepare')}
          </Button>
        </>
      )}
      {project && !saved && (
        <>
          <ExternalGeneration
            project={project}
            session={session}
            disabled={busy}
            onStateChange={keepGeneration}
            onBusyChange={keepBusy}
          />
          <label>
            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
            {t('review')}
          </label>
          {project.status === 'concept' ? (
            <Button
              busy={busy}
              disabled={!review || !admittedConcept(generation) || generating}
              onClick={() => void act('approve')}
            >
              {t('approve')}
            </Button>
          ) : (
            <Button busy={busy} disabled={!review || generating} onClick={() => void act('equip')}>
              {t('equip')}
            </Button>
          )}
        </>
      )}
      {saved && <p role="status">{t('done')}</p>}
      <ErrorBox message={error} />
    </section>
  );
}
