'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, errorMessage, type useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ButtonLink, Empty, ErrorBox, Loading } from '@/components/ui';
import { HeroSelection, useHeroSelection } from './hero-selection';
import { useLaunchGate } from './use-launch-gate';
import type { CampaignSummary } from './use-game';
import styles from './game.module.css';

/** All existing saves and explicit campaign invitations, without a test-world launcher. */
export function CampaignHistory({
  resource,
}: {
  resource: ReturnType<typeof useResource<{ campaigns: CampaignSummary[] }>>;
}) {
  const { t } = useT();
  const router = useRouter();
  const heroSelection = useHeroSelection();
  const launchGate = useLaunchGate(heroSelection.heroId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept(id: string) {
    if (!heroSelection.ready) return;
    const lease = launchGate.begin();
    if (!lease) return;
    let navigating = false;
    setBusy(true);
    setError('');
    try {
      await api(`/game/campaigns/${id}/accept`, {
        method: 'POST',
        body: JSON.stringify(heroSelection.body),
      });
      if (launchGate.accepts(lease)) {
        router.push(`/game/${id}`);
        navigating = true;
      }
    } catch (err) {
      if (launchGate.accepts(lease)) setError(errorMessage(err));
    } finally {
      if (!navigating && launchGate.finish(lease)) setBusy(false);
    }
  }
  return (
    <section className={styles.root} data-testid="campaign-history">
      <h2>{t('Прохождения')}</h2>
      <ErrorBox message={resource.error} retry={resource.reload} />
      <ErrorBox message={error} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.campaigns.length ? (
        <>
          {resource.data.campaigns.some((campaign) => campaign.membership === 'pending') && (
            <HeroSelection selection={heroSelection} disabled={busy} />
          )}
          <div className={styles.campaignList}>
            {resource.data.campaigns.map((campaign) => (
              <article
                key={campaign.id}
                className={styles.campaignCard}
                data-campaign-id={campaign.id}
              >
                <div>
                  <span className={styles.kicker}>{t('Сохранённое прохождение')}</span>
                  <h3>{campaign.title || t('Сохранённое прохождение')}</h3>
                  <code>{campaign.id.slice(0, 8)}</code>
                </div>
                {campaign.membership === 'pending' ? (
                  <Button
                    busy={busy}
                    disabled={!heroSelection.ready}
                    onClick={() => void accept(campaign.id)}
                  >
                    {t('Принять приглашение в кампанию')}
                  </Button>
                ) : (
                  <Link className="button secondary" href={`/game/${campaign.id}`}>
                    {t('Продолжить приключение')}
                  </Link>
                )}
              </article>
            ))}
          </div>
        </>
      ) : !resource.error ? (
        <Empty
          title={t('Пока нет сохранений')}
          description={t(
            'Открой каталог, выбери жанр и загляни в мир. Сохрани интересное приключение в библиотеку, чтобы не потерять.',
          )}
          action={<ButtonLink href="/explore">{t('Найти новый мир')}</ButtonLink>}
        />
      ) : null}
    </section>
  );
}
