'use client';

import Link from 'next/link';
import { BookOpen, FileText, Info, LockKeyhole, Settings, ShieldCheck, Users } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { closedTestDraftLabel, closedTestLegalCopy } from './closed-test-legal-copy';
import styles from './legal-page.module.css';

// Presentation only. The reviewed draft is the sole source of document text.
function InlineCopy({ text }: { text: string }) {
  return text
    .split(/(\*\*.*?\*\*)/g)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

function sectionParts(paragraph: string) {
  const heading = paragraph.match(/^\*\*(.*?)\*\*/);
  return {
    title: heading?.[1] ?? '',
    body: heading ? paragraph.slice(heading[0].length) : paragraph,
  };
}

const illustrations = ['/images/observatory.webp', '/images/city.webp', '/images/forest.webp'];
const icons = [FileText, Users, LockKeyhole, Settings, BookOpen, ShieldCheck];
const navigation = {
  ru: { contents: 'На этой странице', top: 'К началу страницы' },
  uk: { contents: 'На цій сторінці', top: 'На початок сторінки' },
  en: { contents: 'On this page', top: 'Back to top' },
};

export function LegalPage({ path }: { path: '/terms' | '/privacy' }) {
  const { locale } = useT();
  const page = closedTestLegalCopy[locale][path];
  const labels = navigation[locale];
  const terms = path === '/terms';
  const relatedPath = terms ? '/privacy' : '/terms';
  return (
    <article
      className={`${styles.page} ${terms ? styles.terms : styles.privacy}`}
      data-legal-page={path}
    >
      <header className={styles.heading}>
        <p>{closedTestDraftLabel[locale]}</p>
        <h1 id="legal-top" tabIndex={-1}>
          {page.title}
        </h1>
      </header>
      <div className={styles.document}>
        <div className={styles.intro} data-legal-paragraph="0">
          {terms && (
            <img className={styles.heroArt} src="/images/city.webp" alt="" fetchPriority="high" />
          )}
          <Info size={32} aria-hidden="true" />
          <p>
            <InlineCopy text={page.paragraphs[0]} />
          </p>
        </div>
        <nav className={styles.contents} aria-label={labels.contents}>
          <details>
            <summary>{labels.contents}</summary>
            <ol>
              {page.paragraphs.slice(1).map((paragraph, index) => (
                <li key={index}>
                  <a href={`#legal-section-${index + 1}`}>{sectionParts(paragraph).title}</a>
                </li>
              ))}
            </ol>
          </details>
        </nav>
        <div className={styles.sections}>
          {page.paragraphs.slice(1).map((paragraph, index) => {
            const { title, body } = sectionParts(paragraph);
            const Icon = icons[index % icons.length];
            return (
              <section
                className={styles.section}
                key={index}
                data-legal-paragraph={index + 1}
                aria-labelledby={`legal-section-${index + 1}`}
              >
                {terms ? (
                  <img src={illustrations[index % illustrations.length]} alt="" loading="lazy" />
                ) : (
                  <Icon className={styles.icon} size={32} aria-hidden="true" />
                )}
                <div>
                  <h2 id={`legal-section-${index + 1}`} tabIndex={-1}>
                    {title}
                  </h2>
                  <p>
                    <InlineCopy text={body} />
                  </p>
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <footer className={styles.footer}>
        <a href="#legal-top">{labels.top}</a>
        <Link href={relatedPath}>{closedTestLegalCopy[locale][relatedPath].title}</Link>
      </footer>
    </article>
  );
}
