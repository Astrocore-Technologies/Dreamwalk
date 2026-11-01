'use client';
import { ArrowUpRight, BookOpen, Feather, ShieldCheck, Sparkles } from 'lucide-react';
import { ButtonLink, Empty, MoreLink, PageHeading, Panel } from './ui';
import { useT } from '@/lib/i18n';
import { closedTestLegalCopy, closedTestDraftLabel } from './closed-test-legal-copy';
export function StaticPage({ path }: { path: string }) {
  const { t, locale } = useT();
  const legalPath = path === '/content-policy' ? '/terms' : path;
  if (legalPath === '/about' || legalPath === '/terms' || legalPath === '/privacy') {
    const page = closedTestLegalCopy[locale][legalPath];
    return (
      <>
        <PageHeading eyebrow={closedTestDraftLabel[locale]} title={page.title} />
        <Panel className="static-prose">
          {page.paragraphs.map((paragraph, index) => (
            <p key={index}>
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
      </>
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
      <>
        <PageHeading
          eyebrow={t('НЕ ОБЯЗАТЕЛЬНО РАЗБИРАТЬСЯ В ОДИНОЧКУ')}
          title={t('Немного ориентиров')}
          description={t('Всё, что нужно для первых шагов по Dreamwalk.')}
        />
        <div className="help-grid">
          <Panel>
            <BookOpen size={25} />
            <h2>{t('Как найти историю?')}</h2>
            <p>
              {t(
                'Открой каталог, выбери жанр и загляни в мир. Сохрани интересное приключение в библиотеку, чтобы не потерять.',
              )}
            </p>
            <MoreLink href="/explore">{t('Открыть каталог')}</MoreLink>
          </Panel>
          <Panel>
            <Feather size={25} />
            <h2>{t('Как создать свой мир?')}</h2>
            <p>
              {t(
                'В студии собери описание, локации, NPC и стартовую сцену. Частный мир доступен только тебе и приглашённым людям. Для публичного каталога отправь историю на модерацию.',
              )}
            </p>
            <MoreLink href="/studio">{t('В студию автора')}</MoreLink>
          </Panel>
          <Panel>
            <Sparkles size={25} />
            <h2>{t('Что такое искры?')}</h2>
            <p>
              {locale === 'ru' ? 'Искры показывают стоимость AI-действий. Покупки и платный кошелёк пока не активированы; демонстрационный баланс не является деньгами. Генерация доступна только с отдельным разрешением и защитными лимитами владельца.' : locale === 'uk' ? 'Іскри показують вартість AI-дій. Покупки та платний гаманець поки не активовано; демонстраційний баланс не є грошима. Генерація доступна лише з окремим дозволом і захисними лімітами власника.' : 'Sparks express AI action costs. Purchases and the paid wallet are not active; demo balances are not money. Generation requires separate authorization and owner safety limits.'}
            </p>
            <MoreLink href="/wallet">{t('Посмотреть кошелёк')}</MoreLink>
          </Panel>
          <Panel>
            <ShieldCheck size={25} />
            <h2>{t('Как сообщить о проблеме?')}</h2>
            <p>
              {t(
                'На странице приключения есть действие «Сообщить о нарушении». Жалоба попадёт в очередь модерации. Внешняя служба поддержки пока не подключена.',
              )}
            </p>
            <MoreLink href="/content-policy">{t('Правила сообщества')}</MoreLink>
          </Panel>
        </div>
      </>
    );
  return (
    <Empty
      title={t('Кажется, мы свернули не туда')}
      description={t('Такой страницы нет. Вернёмся к знакомой тропе?')}
      action={
        <ButtonLink href="/home">
          {t('На главную')}
          <ArrowUpRight size={16} />
        </ButtonLink>
      }
    />
  );
}
