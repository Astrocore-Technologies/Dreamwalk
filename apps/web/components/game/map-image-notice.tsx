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
          ? 'В игре будет показана сохранённая иллюстрация локации. Позиции персонажей с ней пока не сопоставлены, поэтому они не будут наложены на изображение. Историю можно продолжать через действия и общение; анализ изображения не входит в стоимость.'
          : locale === 'uk'
            ? 'У грі буде показано збережену ілюстрацію локації. Позиції персонажів із нею поки не зіставлено, тому їх не буде накладено на зображення. Історію можна продовжувати через дії та спілкування; аналіз зображення не входить у вартість.'
            : 'Play displays the saved location illustration. Character positions have not been matched to it, so characters will not be overlaid on the image. Continue the story through actions and conversation; image analysis is not included in the price.'}
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
