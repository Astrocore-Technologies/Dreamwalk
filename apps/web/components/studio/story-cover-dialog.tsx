'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { ErrorBox, Modal } from '../ui';
import { ImageGeneration } from '../assets/image-generation';
import type { ArtRevision } from '../assets/types';

const copy = {
  title: ['Создать обложку с ИИ', 'Generate AI cover', 'Створити обкладинку з ШІ'],
  info: [
    'Опишите обложку. Сначала покажем стоимость в Искрах, затем попросим подтвердить запуск. Закрытие окна не отменяет уже запущенную генерацию.',
    'Describe your cover. Review the Sparks price before confirming generation. Closing this window does not cancel generation already started.',
    'Опишіть обкладинку. Спочатку покажемо вартість в Іскрах, потім попросимо підтвердити запуск. Закриття вікна не скасовує вже розпочату генерацію.',
  ],
  retained: [
    'Готовые изображения сохраняются в вашей приватной медиатеке. Выберите результат отдельно, чтобы заменить обложку истории. Повторный выбор бесплатный.',
    'Finished images stay in your private media library. Select a result separately to replace the story cover. Selecting an existing result is free.',
    'Готові зображення зберігаються у вашій приватній медіатеці. Оберіть результат окремо, щоб замінити обкладинку історії. Повторний вибір безкоштовний.',
  ],
} as const;
export function useStoryCoverText() {
  const { locale } = useT();
  return (key: keyof typeof copy) => copy[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}

export function StoryCoverDialog({
  adventureId,
  title,
  synopsis,
  onSelected,
  onClose,
}: {
  adventureId?: string;
  title: string;
  synopsis: string;
  onSelected: (assetId: string) => void;
  onClose: () => void;
}) {
  const text = useStoryCoverText();
  // Only the public-facing description seeds the editable prompt, never world secrets/lore.
  const [draft] = useState(() => ({
    draftId: crypto.randomUUID(),
    title: (title.trim() || 'Story cover').slice(0, 120),
    prompt: `${title.trim()}. ${synopsis.trim()}`.slice(0, 2000),
  }));
  const [error, setError] = useState('');
  const active = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function close() {
    active.current = false;
    onClose();
  }
  async function select(revision: ArtRevision) {
    if (lock.current || !revision.owned) return;
    lock.current = true;
    setError('');
    try {
      const result = await api<{ assetId: string }>(
        `/image-generation/story-covers/${revision.id}/asset`,
      );
      if (active.current) {
        onSelected(result.assetId);
        close();
      }
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
    }
  }
  return (
    <Modal title={text('title')} onClose={close}>
      <p>{text('info')}</p>
      <p>{text('retained')}</p>
      <ErrorBox message={error} />
      <ImageGeneration
        adventureId={adventureId}
        storyCover={draft}
        externalOnly
        spec={{
          kind: 'background',
          camera: 'unrestricted',
          style: 'drawn2D',
          tags: ['story-cover'],
          minWidth: 1,
          minHeight: 1,
        }}
        onSelected={(revision) => void select(revision)}
        onAdmitted={() => {}}
      />
    </Modal>
  );
}
