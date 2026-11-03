'use client';
import { BookOpen, Feather, ShieldCheck, Sparkles } from 'lucide-react';
import { ButtonLink, Empty, PageHeading, Panel } from './ui';
import { MissingPage } from './missing-page';
import { useT } from '@/lib/i18n';
import { closedTestLegalCopy, closedTestDraftLabel } from './closed-test-legal-copy';
export function StaticPage({ path }: { path: string }) {
  const { t, locale } = useT();
  const legalPath = path === '/content-policy' ? '/terms' : path;
  if (legalPath === '/about' || legalPath === '/terms' || legalPath === '/privacy') {
    const page = closedTestLegalCopy[locale][legalPath];
    return (
      <div className={legalPath === '/about' ? 'about-page' : undefined}>
        {legalPath === '/about' && <div className="about-banner" aria-hidden="true" />}
        <PageHeading eyebrow={closedTestDraftLabel[locale]} title={page.title} />
        <Panel className="static-prose">
          {page.paragraphs.map((paragraph, index) => (
            <p
              key={index}
              className={
                legalPath === '/about' && (index === 2 || index === 3) ? 'about-feature' : undefined
              }
            >
              {legalPath === '/about' && (index === 2 || index === 3) && (
                <img
                  src={index === 2 ? '/images/observatory.webp' : '/images/forest.webp'}
                  alt=""
                  loading="lazy"
                />
              )}
              {paragraph
                .split(/(\*\*.*?\*\*)/g)
                .map((part, segment) =>
                  part.startsWith('**') && part.endsWith('**') ? (
                    <strong key={segment}>{part.slice(2, -2)}</strong>
                  ) : (
                    part
                  ),
                )}
            </p>
          ))}
        </Panel>
      </div>
    );
  }
  if (path.startsWith('/play') || path.startsWith('/lobby'))
    return (
      <Empty
        title={t('История ещё готовится')}
        description={t(
          'Игровые сессии, AI-ведущий и совместные приключения появятся на следующем этапе. Сейчас можно исследовать каталог, создавать героев и публиковать миры.',
        )}
        action={<ButtonLink href="/explore">{t('Открыть миры')}</ButtonLink>}
      />
    );
  if (path === '/help' || path === '/support')
    return (
      <div className="help-page">
        <div className="help-banner">
          <PageHeading
            eyebrow={t('НЕ ОБЯЗАТЕЛЬНО РАЗБИРАТЬСЯ В ОДИНОЧКУ')}
            title={t('Немного ориентиров')}
            description={t('Всё, что нужно для первых шагов по Dreamwalk.')}
          />
        </div>
        <div className="help-grid">
          <Panel>
            <BookOpen size={25} />
            <h2>{t('Как найти историю?')}</h2>
            <p>
              {t(
                'Открой каталог, выбери жанр и загляни в мир. Сохрани интересное приключение в библиотеку, чтобы не потерять.',
              )}
            </p>
            <ButtonLink href="/explore">{t('Открыть каталог')}</ButtonLink>
          </Panel>
          <Panel>
            <Feather size={25} />
            <h2>{t('Как создать свой мир?')}</h2>
            <p>
              {t(
                'В студии собери описание, локации, NPC и стартовую сцену. Частный мир доступен только тебе и приглашённым людям. Для публичного каталога отправь историю на модерацию.',
              )}
            </p>
            <ButtonLink href="/studio">{t('В студию автора')}</ButtonLink>
          </Panel>
          <Panel>
            <Sparkles size={25} />
            <h2>{t('Что такое искры?')}</h2>
            <p>
              {locale === 'ru'
                ? 'Генерация расходует Искры. Перед подтверждением ты увидишь примерную стоимость и резерв; после выполнения — фактический расход. Неиспользованный резерв освобождается, а неизвестный расход остаётся на сверке.'
                : locale === 'uk'
                  ? 'Генерація витрачає Іскри. Перед підтвердженням ти побачиш приблизну вартість і резерв; після виконання — фактичну витрату. Невикористаний резерв звільняється, а невідома витрата залишається на звірці.'
                  : 'Generation uses Sparks. Before confirming, you see the estimated cost and planned hold; afterward, the actual usage. Unused holds are released, while unknown costs remain pending reconciliation.'}
            </p>
            <ButtonLink href="/wallet">{t('Посмотреть кошелёк')}</ButtonLink>
          </Panel>
          <Panel>
            <ShieldCheck size={25} />
            <h2>{t('Как сообщить о проблеме?')}</h2>
            <p>
              {t(
                'На странице приключения есть действие «Сообщить о нарушении». Жалоба попадёт в очередь модерации. Внешняя служба поддержки пока не подключена.',
              )}
            </p>
            <ButtonLink href="/content-policy">{t('Правила сообщества')}</ButtonLink>
          </Panel>
        </div>
      </div>
    );
  return <MissingPage />;
}
