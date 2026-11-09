'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { selectAdventureText } from '@dreamwalk/contracts';
import { UsersRound } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { coverUrl, type Adventure } from '@/lib/client';
import { formatCount } from '@/lib/locales';
import { StoryMetrics } from './story-metrics';
import { stripMarkdown } from '@/lib/markdown';

/** Catalog/profile presentation only; shared library cards and launch paths stay unchanged. */
export function DiscoveryWorldCard({
  adventure,
  portrait = false,
}: {
  adventure: Adventure;
  portrait?: boolean;
}) {
  const { locale, taxonomy } = useT();
  const heroId = useSearchParams().get('heroId');
  const text = selectAdventureText(adventure, locale);
  return (
    <Link
      className={`adventure-card illustrated-card world-card${portrait ? ' world-card-portrait' : ''}`}
      href={`/adventures/${adventure.slug}${heroId ? `?heroId=${encodeURIComponent(heroId)}` : ''}`}
    >
      <img className="world-card-image" src={coverUrl(adventure)} alt="" loading="lazy" />
      <div className="world-card-content">
        <h3 className="card-art-title" title={text.title}>
          {text.title}
        </h3>
        <p className="world-card-synopsis">{stripMarkdown(text.synopsis)}</p>
        <div className="world-card-byline">
          <span className="card-author">
            <span className="world-author-initial" aria-hidden="true">
              {adventure.author.handle.slice(0, 1)}
            </span>
            <span>{adventure.author.handle}</span>
          </span>
          {adventure.genre && <span className="world-card-genre">{taxonomy(adventure.genre)}</span>}
        </div>
        <div className="world-card-facts">
          <StoryMetrics adventure={adventure} />
          <span className="world-card-players">
            <UsersRound size={14} aria-hidden="true" />
            {adventure.playersMin}–{formatCount(locale, adventure.playersMax, 'player')}
          </span>
        </div>
      </div>
    </Link>
  );
}
