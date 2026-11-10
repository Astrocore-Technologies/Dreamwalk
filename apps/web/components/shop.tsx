'use client';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { centsPerSpark, packSavingPercent, SPARK_PACKS } from '@/lib/spark-packs';
import { PageHeading } from './ui';
import styles from './shop.module.css';

const messages = {
  ru: {
    title: 'Магазин Искр',
    description: 'Искры оплачивают ИИ-генерацию: текст, миры и иллюстрации. Выбери пакет.',
    notice:
      'Оплата пока не подключена: пакеты и цены показаны заранее, купить их ещё нельзя. Ничего не спишется.',
    perSpark: 'за искру',
    saving: 'выгода',
    soon: 'Скоро',
    note: 'Искры тратятся только на генерацию, а перед подтверждением ты видишь стоимость. Демо-баланс не является деньгами.',
    back: 'Назад в кошелёк',
  },
  uk: {
    title: 'Крамниця Іскор',
    description: 'Іскри оплачують ШІ-генерацію: текст, світи та ілюстрації. Обери пакет.',
    notice:
      'Оплату поки не підключено: пакети й ціни показано заздалегідь, придбати їх ще не можна. Нічого не спишеться.',
    perSpark: 'за іскру',
    saving: 'вигода',
    soon: 'Скоро',
    note: 'Іскри витрачаються лише на генерацію, а перед підтвердженням ти бачиш вартість. Демо-баланс не є грошима.',
    back: 'Назад до гаманця',
  },
  en: {
    title: 'Sparks shop',
    description: 'Sparks pay for AI generation: text, worlds and illustrations. Pick a pack.',
    notice:
      'Payments are not connected yet: packs and prices are shown in advance and cannot be bought. Nothing will be charged.',
    perSpark: 'per Spark',
    saving: 'save',
    soon: 'Coming soon',
    note: 'Sparks are spent only on generation, and you see the cost before confirming. The demo balance is not money.',
    back: 'Back to wallet',
  },
};

/** Label of the wallet button that opens the shop. */
export const shopButtonLabel = {
  ru: messages.ru.title,
  uk: messages.uk.title,
  en: messages.en.title,
};

export function SparkShopPage() {
  const { locale } = useT();
  const text = messages[locale];
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  const number = new Intl.NumberFormat(locale);
  const cents = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  return (
    <div className={styles.shop} data-testid="spark-shop">
      <PageHeading title={text.title} description={text.description} />
      <p className={styles.notice} role="note">
        {text.notice}
      </p>
      <div className={styles.grid}>
        {SPARK_PACKS.map((pack) => {
          const saving = packSavingPercent(pack);
          return (
            <article
              key={pack.sparks}
              className={styles.pack}
              data-featured={pack.sparks === 1000}
              data-testid={`spark-pack-${pack.sparks}`}
            >
              {saving > 0 && (
                <span className={styles.badge}>
                  {text.saving} {saving}%
                </span>
              )}
              <p className={styles.amount}>
                {number.format(pack.sparks)}
                <span aria-hidden="true">✦</span>
              </p>
              <p className={styles.price}>{money.format(pack.priceCents / 100)}</p>
              <p className={styles.rate}>
                {cents.format(centsPerSpark(pack))} ¢ {text.perSpark}
              </p>
              <button type="button" className="button primary" disabled>
                <Sparkles size={16} aria-hidden="true" /> {text.soon}
              </button>
            </article>
          );
        })}
      </div>
      <div className={styles.footer}>
        <span>{text.note}</span>
        <Link className="button secondary" href="/wallet">
          {text.back}
        </Link>
      </div>
    </div>
  );
}
