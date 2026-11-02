'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
const messages = {
  title: ['Приватная игровая публикация', 'Private playable release', 'Приватна ігрова публікація'],
  info: [
    'Сохраняет неизменяемую игровую версию в вашей библиотеке: только для вас и принятых приглашений. Черновик и текущие игры не заменяются.',
    'Saves an immutable playable release in your library for you and accepted invitees only. Drafts and existing games are not replaced.',
    'Зберігає незмінну ігрову версію у вашій бібліотеці лише для вас і прийнятих запрошень. Чернетка й поточні ігри не замінюються.',
  ],
  consent: [
    'Опубликовать эту готовую версию приватно, без общего каталога',
    'Publish this ready version privately, not in the public catalog',
    'Опублікувати цю готову версію приватно, без загального каталогу',
  ],
  publish: [
    'Опубликовать в моей библиотеке',
    'Publish in my library',
    'Опублікувати в моїй бібліотеці',
  ],
  ready: [
    'Приватная игровая версия опубликована',
    'Private playable version published',
    'Приватну ігрову версію опубліковано',
  ],
  open: [
    'Открыть историю и выбрать героя',
    'Open story and choose a hero',
    'Відкрити історію й обрати героя',
  ],
  missing: [
    'Сначала подготовьте и примените игровой план из ваших локаций.',
    'First build and apply a playable plan from your locations.',
    'Спочатку підготуйте та застосуйте ігровий план із ваших локацій.',
  ],
} as const;
export function PrivateRelease({
  adventureId,
  beforePublish,
  onPublished,
}: {
  adventureId: string;
  beforePublish: () => Promise<unknown>;
  onPublished: () => void;
}) {
  const { locale } = useT(),
    index = locale === 'ru' ? 0 : locale === 'en' ? 1 : 2,
    text = (key: keyof typeof messages) => messages[key][index];
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [slug, setSlug] = useState<string | null>(null);
  const lock = useRef(false),
    epoch = useRef(0),
    operations = useRef(new Map<string, string>());
  useEffect(() => {
    epoch.current++;
    setConsent(false);
    setSlug(null);
    setError('');
    operations.current.clear();
    return () => {
      epoch.current++;
    };
  }, [adventureId]);
  async function publish() {
    if (lock.current || !consent) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const current = epoch.current;
    try {
      await beforePublish();
      const [story, game, art] = await Promise.all([
        api<{ editRevision: number; slug: string }>(`/studio/adventures/${adventureId}`),
        api<{ draft: unknown; revision: number }>(
          `/studio/adventures/${adventureId}/playable-draft`,
        ),
        api<{ revision: number }>(`/asset-library/stories/${adventureId}/draft`),
      ]);
      if (current !== epoch.current) return;
      if (!game.draft || !game.revision) throw new Error(text('missing'));
      const body = {
        expectedEditRevision: story.editRevision,
        expectedGameRevision: game.revision,
        expectedArtRevision: art.revision,
      };
      const key = JSON.stringify(body);
      if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
      await api(`/studio/adventures/${adventureId}/private-release`, {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: operations.current.get(key) }),
      });
      if (current === epoch.current) {
        operations.current.delete(key);
        setSlug(story.slug);
        setConsent(false);
        onPublished();
      }
    } catch (e) {
      if (current === epoch.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
      if (current === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="stack">
      <h2>{text('title')}</h2>
      <p>{text('info')}</p>
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {text('consent')}
      </label>
      <Button type="button" busy={busy} disabled={!consent} onClick={() => void publish()}>
        {text('publish')}
      </Button>
      <ErrorBox message={error} />
      {slug && (
        <p role="status">
          {text('ready')} · <Link href={`/adventures/${slug}`}>{text('open')}</Link>
        </p>
      )}
    </section>
  );
}
