'use client';
import { ArrowRight, Sparkle } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { ButtonLink } from './ui';
import './notification-pages.css';

export function MissingPage() {
  const { t } = useT();
  return (
    <section className="missing-page" aria-labelledby="missing-page-heading">
      <img className="missing-page-art" src="/images/missing-path.webp" alt="" aria-hidden="true" />
      <div className="missing-page-content">
        <p className="missing-page-code" aria-hidden="true">
          404
        </p>
        <div className="missing-page-divider" aria-hidden="true">
          <Sparkle size={24} />
        </div>
        <h1 id="missing-page-heading">{t('Кажется, мы свернули не туда')}</h1>
        <p>{t('Такой страницы нет. Вернёмся к знакомой тропе?')}</p>
        <ButtonLink href="/home">
          {t('На главную')}
          <ArrowRight size={22} />
        </ButtonLink>
      </div>
    </section>
  );
}
