'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from './ui';
import { ImageGeneration } from './assets/image-generation';
import type { ArtRevision } from './assets/types';
const copy = {
  title: ['Сгенерировать арт героя', 'Generate hero art', 'Згенерувати арт героя'],
  info: [
    'Опишите внешность в запросе ниже. Личные заметки не отправляются. Цена в Искрах и согласие — до запуска. Результат выбирается отдельно; прежний портрет не меняется до сохранения героя.',
    'Describe appearance in the prompt below. Private notes are not sent. Sparks price and consent come before generation. Select the result separately; the previous portrait stays until you save the hero.',
    'Опишіть зовнішність у запиті нижче. Особисті нотатки не надсилаються. Ціна в Іскрах і згода — до запуску. Результат обирається окремо; попередній портрет зберігається до збереження героя.',
  ],
  retained: [
    'Созданные изображения останутся в вашей приватной библиотеке, даже если закрыть окно без сохранения героя. Повторный выбор готового изображения бесплатный.',
    'Generated images remain in your private library even if you close without saving the hero. Selecting an existing result is free.',
    'Створені зображення залишаться у вашій приватній бібліотеці, навіть якщо закрити вікно без збереження героя. Повторний вибір готового зображення безкоштовний.',
  ],
  selected: [
    'Портрет выбран. Сохраните героя.',
    'Portrait selected. Save the hero.',
    'Портрет обрано. Збережіть героя.',
  ],
} as const;
export function HeroPortraitControl({
  name,
  backstory,
  traits,
  onSelected,
}: {
  name: string;
  backstory: string;
  traits: string[];
  onSelected: (assetId: string) => void;
}) {
  const { locale } = useT();
  const text = (key: keyof typeof copy) => copy[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
  const [draft, setDraft] = useState<{ draftId: string; prompt: string; title: string } | null>(
    null,
  );
  const [error, setError] = useState(''),
    [selected, setSelected] = useState(false);
  const active = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function select(revision: ArtRevision) {
    if (lock.current || !revision.owned) return;
    lock.current = true;
    setError('');
    try {
      const result = await api<{ assetId: string }>(
        `/image-generation/hero-portraits/${revision.id}/asset`,
      );
      if (active.current) {
        onSelected(result.assetId);
        setSelected(true);
      }
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
    }
  }
  return (
    <section>
      {!draft && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setDraft({
              draftId: crypto.randomUUID(),
              title: (name.trim() || 'Hero portrait').slice(0, 120),
              prompt:
                `Drawn 2D fantasy hero portrait. ${name.trim()}. ${backstory.trim()} ${traits.join(', ')}`.slice(
                  0,
                  2000,
                ),
            })
          }
        >
          {text('title')}
        </Button>
      )}
      {draft && (
        <>
          <h3>{text('title')}</h3>
          <p>{text('info')}</p>
          <p>{text('retained')}</p>
          <ImageGeneration
            heroPortrait={draft}
            externalOnly
            spec={{
              kind: 'portrait',
              camera: 'portrait',
              style: 'drawn2D',
              tags: ['hero-portrait'],
              minWidth: 1,
              minHeight: 1,
            }}
            onSelected={(revision) => void select(revision)}
            onAdmitted={() => {}}
          />
        </>
      )}
      <ErrorBox message={error} />
      {selected && <p role="status">{text('selected')}</p>}
    </section>
  );
}
