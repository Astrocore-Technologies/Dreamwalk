'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import {
  LocationImageAction,
  LocationImageDialog,
  useLocationImageConfiguration,
} from '../visual-authoring/location-image';
import styles from './opening-art.module.css';

/** The picture of a story's opening place. The AI writes the picture brief from the author's text. */
export const OPENING_LOCATION_ID = 'opening';
const messages = {
  ru: {
    title: 'Картинка стартовой локации',
    hint: 'ИИ сам составит описание по вашему тексту и первому сообщению. Цену и согласие вы подтверждаете один раз.',
    required:
      'Пока картинки нет, игроки не смогут начать эту историю: подготовьте её до публикации.',
    needsText: 'Сначала опишите мир или напишите первое сообщение и сохраните историю.',
  },
  uk: {
    title: 'Картинка стартової локації',
    hint: 'ШІ сам складе опис за вашим текстом і першим повідомленням. Ціну та згоду ви підтверджуєте один раз.',
    required:
      'Поки картинки немає, гравці не зможуть почати цю історію: підготуйте її до публікації.',
    needsText: 'Спершу опишіть світ або напишіть перше повідомлення та збережіть історію.',
  },
  en: {
    title: 'Opening location picture',
    hint: 'The AI writes the picture brief from your text and first message. You confirm the price and consent once.',
    required:
      'Until a picture exists, players cannot start this story: prepare it before publishing.',
    needsText: 'First describe the world or write the first message, then save the story.',
  },
};

export function OpeningArt({
  adventureId,
  world,
  firstMessage,
  saved,
  disabled,
  beforePrepare,
  onSaved,
}: {
  adventureId: string;
  world: string;
  firstMessage: string;
  saved: boolean;
  disabled: boolean;
  beforePrepare: () => Promise<unknown>;
  onSaved: () => void;
}) {
  const { locale } = useT();
  const text = messages[locale];
  const settings = useLocationImageConfiguration();
  const [open, setOpen] = useState(false);
  const hasText = !!(world.trim() || firstMessage.trim());
  return (
    <section className={styles.card} aria-label={text.title} data-testid="opening-art">
      <h3>{text.title}</h3>
      <p className="muted">{text.hint}</p>
      {settings.config?.openingArt === 'required' && (
        <p className="notice" data-testid="opening-art-required">
          {text.required}
        </p>
      )}
      {!hasText || !saved ? (
        <p className="muted">{text.needsText}</p>
      ) : (
        <LocationImageAction
          settings={settings}
          adventureId={adventureId}
          locationId={OPENING_LOCATION_ID}
          sourceKey={JSON.stringify([world, firstMessage])}
          beforePrepare={beforePrepare}
          playableDirty={false}
          onSaved={onSaved}
          saved={saved}
          disabled={disabled}
          onOpen={() => setOpen(true)}
        />
      )}
      {open && (
        <LocationImageDialog
          adventureId={adventureId}
          locationId={OPENING_LOCATION_ID}
          settings={settings}
          beforePrepare={beforePrepare}
          playableDirty={false}
          onSaved={onSaved}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
