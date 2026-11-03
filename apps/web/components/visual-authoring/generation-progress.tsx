'use client';
import { useT } from '@/lib/i18n';
import styles from './generation-progress.module.css';
const messages = {
  queued: ['Изображение в очереди…', 'Image generation queued…', 'Зображення в черзі…'],
  dispatched: ['Создаём изображение…', 'Generating image…', 'Створюємо зображення…'],
  generated: [
    'Сохраняем и проверяем изображение…',
    'Saving and checking image…',
    'Зберігаємо й перевіряємо зображення…',
  ],
} as const;
/** Only known pending work animates. Unknown billing is not progress or a retry. */
export function GenerationProgress({ status, label }: { status: string; label?: string }) {
  const { locale } = useT();
  if (!(status in messages)) return null;
  const text =
    messages[status as keyof typeof messages][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
  return (
    <div
      className={styles.progress}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-generation-progress={status}
    >
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label || text}</span>
    </div>
  );
}
