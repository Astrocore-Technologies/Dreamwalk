'use client';
import { useT } from '@/lib/i18n';
export function MapImageNotice({
  count,
  schematicCount,
}: {
  count?: number;
  schematicCount?: number;
}) {
  const { locale } = useT();
  if (schematicCount)
    return (
      <p data-schematic-map-notice>
        {locale === 'ru'
          ? 'Сохранённая карта будет показана с сеткой и персонажами. Анализ изображения не входит в эту оценку.'
          : locale === 'uk'
            ? 'Збережену мапу буде показано із сіткою та персонажами. Аналіз зображення не входить до цієї оцінки.'
            : 'The saved map will be shown with its grid and characters. Image analysis is not included in this estimate.'}
      </p>
    );
  if (!count) return null;
  return (
    <p data-map-image-consent>
      {locale === 'ru'
        ? 'Сохранённые изображения карт будут отправлены ИИ для определения местности и безопасных стартовых позиций. Анализ включён в эту оценку.'
        : locale === 'uk'
          ? 'Збережені зображення мап будуть надіслані ШІ для визначення місцевості та безпечних стартових позицій. Аналіз включено в цю оцінку.'
          : 'Saved map images will be sent to the AI to identify terrain and safe starting positions. Analysis is included in this estimate.'}
    </p>
  );
}
