'use client';
import { Heart, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Adventure } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from './ui';

const copy = {
  rounds: ['Раунды', 'Rounds', 'Раунди'],
  likes: ['Нравится', 'Likes', 'Вподобання'],
  like: ['Мне нравится', 'Like this story', 'Мені подобається'],
  unlike: ['Убрать отметку «Нравится»', 'Unlike this story', 'Прибрати вподобання'],
} as const;
function useMetricsText() {
  const { locale } = useT();
  return {
    locale,
    text: (key: keyof typeof copy) => copy[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2],
  };
}
export function StoryMetrics({ adventure }: { adventure: Adventure }) {
  const { locale, text } = useMetricsText();
  const count = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return (
    <div className="story-metrics">
      {Number.isFinite(adventure.totalRounds) && adventure.totalRounds >= 0 && (
        <span
          title={`${text('rounds')}: ${new Intl.NumberFormat(locale).format(adventure.totalRounds)}`}
        >
          <RotateCcw size={14} aria-hidden="true" />
          <span>
            {count(adventure.totalRounds)} {text('rounds')}
          </span>
        </span>
      )}
      {Number.isFinite(adventure.likeCount) && adventure.likeCount >= 0 && (
        <span
          title={`${text('likes')}: ${new Intl.NumberFormat(locale).format(adventure.likeCount)}`}
        >
          <Heart size={14} aria-hidden="true" />
          <span>
            {count(adventure.likeCount)} {text('likes')}
          </span>
        </span>
      )}
    </div>
  );
}
export function StoryLikeButton({
  adventure,
  onChanged,
}: {
  adventure: Adventure;
  onChanged: () => void;
}) {
  const { text } = useMetricsText();
  const [liked, setLiked] = useState(adventure.likedByMe);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setLiked(adventure.likedByMe);
  }, [adventure.likedByMe]);
  useEffect(() => () => request.current?.abort(), []);
  async function toggle() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ likeCount: number; likedByMe: boolean }>(
        `/likes/${adventure.id}`,
        { method: liked ? 'DELETE' : 'PUT', body: '{}', signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setLiked(result.likedByMe);
        onChanged();
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  return (
    <div className="story-like-action">
      <Button
        type="button"
        variant="secondary"
        busy={busy}
        aria-pressed={liked}
        aria-label={text(liked ? 'unlike' : 'like')}
        onClick={() => void toggle()}
      >
        <Heart size={17} fill={liked ? 'currentColor' : 'none'} />
        {text('like')}
      </Button>
      <ErrorBox message={error} />
    </div>
  );
}
