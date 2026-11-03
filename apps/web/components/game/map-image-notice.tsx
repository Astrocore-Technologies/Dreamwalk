'use client';
import { useT } from '@/lib/i18n';
export function MapImageNotice({ count }: { count?: number }) {
  const { locale } = useT();
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
