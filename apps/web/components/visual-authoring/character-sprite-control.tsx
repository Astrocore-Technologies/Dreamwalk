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
  fromProfile: [
    'Образ строится по полю «Внешность» этого персонажа. Заполните его и сохраните NPC.',
    'The sprite is built from this character’s Appearance field. Fill it in and save the NPC.',
    'Образ будується за полем «Зовнішність» цього персонажа. Заповніть його та збережіть NPC.',
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
    'Проверь внешность и полный рост перед утверждением образа',
    'Review identity and full body before approving this appearance',
    'Перевір зовнішність і повний зріст перед затвердженням образу',
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
    text = (k: keyof typeof messages) => messages[k][i];
  const [appearance, setAppearance] = useState(''),
    [photo, setPhoto] = useState(false),
    [share, setShare] = useState(false);
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
          ...(target.kind === 'hero' && appearance.trim() ? { appearance: appearance.trim() } : {}),
          sourcePhotoPermission: photo,
          allowOutputReuse: share,
        })) as GenerationProject;
        if (epoch === stamp.current) {
          setProject(p);
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
      <h3>{text('title')}</h3>
      <p>{text('info')}</p>
      {!project && (
        <>
          {target.kind === 'hero' ? (
            <Field label={text('appearance')}>
              <Textarea
                value={appearance}
                onChange={(e) => setAppearance(e.target.value)}
                maxLength={1500}
              />
            </Field>
          ) : (
            <p>{text('fromProfile')}</p>
          )}
          <label>
            <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />
            {text('photo')}
          </label>
          <br />
          <label>
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            {text('share')}
          </label>
          <br />
          <Button busy={busy} onClick={() => void act('prepare')}>
            {text('prepare')}
          </Button>
        </>
      )}
      {project && !saved && (
        <>
          <ExternalGeneration
            compactActions
            project={project}
            session={session}
            disabled={busy}
            onStateChange={keepGeneration}
            onBusyChange={keepBusy}
          />
          <p>{text('review')}</p>
          {project.status === 'concept' ? (
            <Button
              busy={busy}
              disabled={!admittedConcept(generation) || generating}
              onClick={() => void act('approve')}
            >
              {text('approve')}
            </Button>
          ) : (
            <Button busy={busy} disabled={generating} onClick={() => void act('equip')}>
              {text('equip')}
            </Button>
          )}
        </>
      )}
      {saved && <p role="status">{text('done')}</p>}
      <ErrorBox message={error} />
    </section>
  );
}
