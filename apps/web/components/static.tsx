'use client';
import { ArrowRight, BookOpen, Feather, Moon, ShieldCheck, Sparkles, Star } from 'lucide-react';
import { ButtonLink, Empty, PageHeading, Panel } from './ui';
import { MissingPage } from './missing-page';
import { useT } from '@/lib/i18n';
import './help-about.css';
import { LegalPage } from './legal-page';
import { legalCopy, legalEditionLabel } from './legal-copy';
export function StaticPage({ path }: { path: string }) {
  const { t, locale } = useT();
  const legalPath = path === '/content-policy' ? '/terms' : path;
  if (legalPath === '/terms' || legalPath === '/privacy') return <LegalPage path={legalPath} />;
  const renderParagraph = (paragraph: string) =>
    paragraph
      .split(/(\*\*.*?\*\*)/g)
      .map((part, segment) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={segment}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );
  if (legalPath === '/about') {
    const page = legalCopy[locale][legalPath];
    const headings = {
      ru: ['Истории и развитие проекта', 'Пространство для авторов'],
      uk: ['Історії та розвиток проєкту', 'Простір для авторів'],
      en: ['Stories and a growing project', 'A space for authors'],
    }[locale];
    return (
      <div className="about-page editorial-about">
        <img className="about-banner" src="/images/about-observatory.webp" alt="" />
        <Panel className="about-body">
          <PageHeading eyebrow={legalEditionLabel[locale]} title={page.title} />
          <p className="about-intro">{renderParagraph(page.paragraphs[1])}</p>
          <p className="about-draft-note">{renderParagraph(page.paragraphs[0])}</p>
          <div className="about-divider" aria-hidden="true">
            <Star />
            <Moon />
            <Star />
          </div>
          <div className="about-features">
            {[2, 3].map((index) => (
              <section className="about-feature" key={index}>
                <img
                  src={index === 2 ? '/images/about-stories.webp' : '/images/about-authors.webp'}
                  alt=""
                  loading="lazy"
                />
                <div>
                  <h2>{headings[index - 2]}</h2>
                  <p>{renderParagraph(page.paragraphs[index])}</p>
                </div>
              </section>
            ))}
          </div>
          <p className="about-operator">{renderParagraph(page.paragraphs[4])}</p>
        </Panel>
      </div>
    );
  }
  if (legalPath === '/terms' || legalPath === '/privacy') {
    const page = legalCopy[locale][legalPath];
    return (
      <div>
        <PageHeading eyebrow={legalEditionLabel[locale]} title={page.title} />
        <Panel className="static-prose">
          {page.paragraphs.map((paragraph, index) => (
            <p key={index}>{renderParagraph(paragraph)}</p>
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
      <div className="help-page editorial-help">
        <div className="help-banner">
          <img className="help-hero-art" src="/images/help-library.webp" alt="" />
          <PageHeading
            eyebrow={t('НЕ ОБЯЗАТЕЛЬНО РАЗБИРАТЬСЯ В ОДИНОЧКУ')}
            title={t('Немного ориентиров')}
            description={t('Всё, что нужно для первых шагов по Dreamwalk.')}
          />
        </div>
        <div className="help-grid">
          <Panel>
            <div className="help-emblem" aria-hidden="true">
              <BookOpen />
              <Star className="emblem-star" />
            </div>
            <h2>{t('Как найти историю?')}</h2>
            <p>
              {t(
                'Открой каталог, выбери жанр и загляни в мир. Сохрани интересное приключение в библиотеку, чтобы не потерять.',
              )}
            </p>
            <ButtonLink href="/explore">
              {t('Открыть каталог')}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </Panel>
          <Panel>
            <div className="help-emblem" aria-hidden="true">
              <Feather />
              <Star className="emblem-star" />
            </div>
            <h2>{t('Как создать свой мир?')}</h2>
            <p>
              {t(
                'В студии собери описание, локации, NPC и стартовую сцену. Частный мир доступен только тебе и приглашённым людям. Для публичного каталога отправь историю на модерацию.',
              )}
            </p>
            <ButtonLink href="/studio">
              {t('В студию автора')}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </Panel>
          <Panel>
            <div className="help-emblem" aria-hidden="true">
              <Sparkles />
              <Star className="emblem-star" />
            </div>
            <h2>{t('Что такое искры?')}</h2>
            <p>
              {locale === 'ru'
                ? 'Генерация расходует Искры. Перед подтверждением ты увидишь примерную стоимость и резерв; после выполнения — фактический расход. Неиспользованный резерв освобождается, а неизвестный расход остаётся на сверке.'
                : locale === 'uk'
                  ? 'Генерація витрачає Іскри. Перед підтвердженням ти побачиш приблизну вартість і резерв; після виконання — фактичну витрату. Невикористаний резерв звільняється, а невідома витрата залишається на звірці.'
                  : 'Generation uses Sparks. Before confirming, you see the estimated cost and planned hold; afterward, the actual usage. Unused holds are released, while unknown costs remain pending reconciliation.'}
            </p>
            <ButtonLink href="/wallet">
              {t('Посмотреть кошелёк')}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </Panel>
          <Panel>
            <div className="help-emblem" aria-hidden="true">
              <ShieldCheck />
              <Star className="emblem-star" />
            </div>
            <h2>{t('Как сообщить о проблеме?')}</h2>
            <p>
              {t(
                'На странице приключения есть действие «Сообщить о нарушении». Жалоба попадёт в очередь модерации. Внешняя служба поддержки пока не подключена.',
              )}
            </p>
            <ButtonLink href="/content-policy">
              {t('Правила сообщества')}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </Panel>
        </div>
      </div>
    );
  return <MissingPage />;
}
