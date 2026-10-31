'use client';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { safeStoryReturn } from './story-return';
export function StoryReturnLink({ intent }: { intent: string | null }) {
  const { t } = useT();
  const href = safeStoryReturn(intent);
  if (!href) return null;
  return (
    <Link className="auth-sub-link" href={href} data-testid="return-to-story">
      {t('Вернуться к выбранной истории')}
    </Link>
  );
}
