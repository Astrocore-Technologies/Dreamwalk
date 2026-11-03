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
          ? 'Игра начнётся на схематичной карте по описанию истории. Сохранённая иллюстрация не анализируется и не будет фоном этой карты: расположение объектов с ней не сопоставлено. Изображение останется в материалах истории; его анализ не входит в стоимость.'
          : locale === 'uk'
            ? 'Гра почнеться на схематичній мапі за описом історії. Збережена ілюстрація не аналізується й не буде тлом цієї мапи: розташування об’єктів із нею не зіставлено. Зображення залишиться в матеріалах історії; його аналіз не входить у вартість.'
            : 'Play starts on a schematic map based on the story description. The saved illustration is not analyzed or used as this map’s background: object positions have not been matched to it. The image stays in the story assets; image analysis is not included in the price.'}
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
