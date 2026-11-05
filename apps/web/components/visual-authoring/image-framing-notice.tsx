'use client';
import { imageFramingMatchesProfile, type ImageFraming } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
export function ImageFramingNotice({
  framingVersion,
  imageFraming,
  approvedSize,
  approvedPolicy,
}: {
  framingVersion?: 1;
  imageFraming?: ImageFraming | null;
  approvedSize?: string;
  approvedPolicy?: {
    mode: string;
    minPixels: number;
    maxPixels: number;
    maxEdge: number;
    maxAspectRatio: number;
  };
}) {
  const { locale } = useT();
  const index = locale === 'ru' ? 0 : locale === 'uk' ? 2 : 1;
  if (framingVersion !== 1) return null;
  const noMap = [
    'Размеры игрового размещения ещё не определены. Изображение остаётся картой локации.',
    'Playable layout dimensions are not established yet. The image remains the location map.',
    'Розміри ігрового розміщення ще не визначені. Зображення залишається картою локації.',
  ];
  if (!imageFraming) return <p data-image-framing="unavailable">{noMap[index]}</p>;
  const labels = ['Карта / изображение', 'Map / image', 'Карта / зображення'];
  const pixelUnit = ['пикс.', 'px', 'пікс.'][index];
  const contain = [
    'Изображение сохраняется целиком, без растяжения и обрезки; возможны поля.',
    'The whole image is preserved without stretching or cropping; margins may remain.',
    'Зображення зберігається повністю, без розтягування чи обрізання; можливі поля.',
  ];
  const review = [
    'Этот размер требует отдельного пересмотра утверждённого профиля стоимости. Генерация заблокирована.',
    'This size requires a separate review of the approved cost profile. Generation is blocked.',
    'Цей розмір потребує окремого перегляду затвердженого профілю вартості. Генерацію заблоковано.',
  ];
  return (
    <div data-image-framing="contain">
      <p>
        {labels[index]}: {imageFraming.mapWidth} × {imageFraming.mapHeight} / {imageFraming.width} ×{' '}
        {imageFraming.height} {pixelUnit}
      </p>
      {!imageFraming.exactAspect && (
        <p>
          {
            [
              'Точное соотношение карты недоступно у провайдера. Используется фон с полями, без обрезки.',
              'The exact map aspect is unavailable from the provider. A contained background with margins is used, without cropping.',
              'Точне співвідношення карти недоступне у провайдера. Використовується фон із полями, без обрізання.',
            ][index]
          }
        </p>
      )}
      <p>{contain[index]}</p>
      {approvedSize && !imageFramingMatchesProfile(imageFraming, approvedSize, approvedPolicy) && (
        <p role="status">{review[index]}</p>
      )}
    </div>
  );
}
