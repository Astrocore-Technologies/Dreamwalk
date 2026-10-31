'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Hero, CampaignHeroResponse } from '@dreamwalk/contracts';
import { useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { ErrorBox, Field, Select } from '@/components/ui';
const rows = {
  choose: ['Герой для этого прохождения', 'Hero for this campaign', 'Герой для цього проходження'],
  traveler: [
    'Путешественник без сохранённого героя',
    'Traveler without a saved hero',
    'Мандрівник без збереженого героя',
  ],
  pinned: [
    'Образ героя закрепится при входе: последующие правки не изменят это прохождение. Имя и портрет видны участникам с доступом, когда герой находится в их поле зрения. Предыстория, черты и заметки видны только тебе.',
    'Your hero is pinned when you join; later edits do not change this campaign. Name and portrait are shared with authorized participants who can see the hero. Backstory, traits and notes are visible only to you.',
    'Образ героя закріпиться при вході: подальші правки не змінять це проходження. Ім’я та портрет видимі учасникам із доступом, коли герой у їхньому полі зору. Передісторія, риси та нотатки видимі лише тобі.',
  ],
  missing: [
    'Выбранный герой недоступен. Выбери другого героя или путешественника.',
    'The selected hero is unavailable. Choose another hero or the traveler.',
    'Вибраний герой недоступний. Обери іншого героя або мандрівника.',
  ],
  adventures: ['Выбрать приключение', 'Choose an adventure', 'Обрати пригоду'],
  manage: ['Мои герои', 'My heroes', 'Мої герої'],
  play: ['Играть этим героем', 'Play as this hero', 'Грати цим героєм'],
  saved: [
    'Твой герой в этом сохранении',
    'Your hero in this save',
    'Твій герой в цьому збереженні',
  ],
  private: [
    'Личная история и заметки — только тебе',
    'Personal story and notes — only you',
    'Особиста історія та нотатки — лише тобі',
  ],
} as const;
export function useHeroText() {
  const { locale } = useT();
  return (key: keyof typeof rows) => rows[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
export function useHeroSelection() {
  const { user } = useClient();
  const params = useSearchParams();
  const requested = params.get('heroId') || '';
  const [choice, setChoice] = useState<{ requested: string; id: string } | null>(null);
  const heroId = choice?.requested === requested ? choice.id : requested;
  const resource = useResource<Hero[]>(user ? '/heroes' : null);
  const valid = !heroId || !!resource.data?.some((hero) => hero.id === heroId);
  return {
    heroId,
    setHeroId: (id: string) => setChoice({ requested, id }),
    resource,
    ready: !user || !heroId || (!resource.loading && !resource.error && valid),
    valid,
    body: heroId ? { heroId } : {},
    enabled: !!user,
  };
}
export function HeroSelection({
  selection,
  disabled = false,
}: {
  selection: ReturnType<typeof useHeroSelection>;
  disabled?: boolean;
}) {
  const h = useHeroText();
  if (!selection.enabled) return null;
  return (
    <div className="stack" data-testid="hero-selection" style={{ minWidth: 0, maxWidth: '100%' }}>
      <Field label={h('choose')} hint={h('pinned')}>
        <Select
          value={selection.heroId}
          disabled={disabled || selection.resource.loading}
          onChange={(event) => selection.setHeroId(event.target.value)}
        >
          <option value="">{h('traveler')}</option>
          {selection.heroId && !selection.valid && (
            <option value={selection.heroId}>{h('missing')}</option>
          )}
          {selection.resource.data?.map((hero) => (
            <option key={hero.id} value={hero.id}>
              {hero.name}
            </option>
          ))}
        </Select>
      </Field>
      <ErrorBox
        message={
          selection.resource.error ||
          (!selection.resource.loading && !selection.valid ? h('missing') : '')
        }
        retry={selection.resource.reload}
      />
      <Link href="/my-characters">{h('manage')}</Link>
    </div>
  );
}
export function CampaignHero({ campaignId }: { campaignId: string }) {
  const h = useHeroText();
  const snapshot = useResource<CampaignHeroResponse>(`/game/campaigns/${campaignId}/hero`);
  const hero = snapshot.data?.hero;
  return (
    <section data-testid="campaign-hero" className="stack" style={{ overflowWrap: 'anywhere' }}>
      <strong>{h('saved')}</strong>
      <ErrorBox message={snapshot.error} retry={snapshot.reload} />
      {hero ? (
        <>
          <h2>{hero.name}</h2>
          {hero.portraitUrl && (
            <img
              src={hero.portraitUrl}
              alt={hero.name}
              width={64}
              height={80}
              loading="lazy"
              decoding="async"
              style={{ objectFit: 'cover' }}
            />
          )}
          <details>
            <summary>{h('private')}</summary>
            <p>{hero.backstory}</p>
            <p>{hero.traits.join(', ')}</p>
            <p>{hero.notes}</p>
          </details>
          <small>{h('pinned')}</small>
        </>
      ) : !snapshot.loading && !snapshot.error ? (
        <p>{h('traveler')}</p>
      ) : null}
    </section>
  );
}
