/** Editable generation defaults only. Never rewrites saved art or paid/quoted requests. */
export type ImageStyleSubject = 'character' | 'location' | 'cover' | 'battlemap' | 'asset';

export function defaultImageStylePrompt(subject: ImageStyleSubject): string {
  const treatment =
    subject === 'character'
      ? 'clean line art, soft cel shading, expressive faces, painterly lighting'
      : subject === 'cover'
        ? 'cinematic key art, detailed characters, painterly scenery and lighting; no lettering'
        : subject === 'battlemap' || subject === 'location'
          ? 'painterly scenery, clean shapes, soft lighting'
          : 'clean line art, cel shading';
  return `Default art: detailed drawn 2D anime, ${treatment}. Explicit author art style takes precedence; preserve required camera and gameplay geometry.`;
}
