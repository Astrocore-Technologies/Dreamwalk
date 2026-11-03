'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

type ReadingPosition = {
  following: boolean;
  top: number;
  anchor?: { id: string; offset: number };
};

/** Follow the conversation only while the reader is at its end. Never scroll the page. */
export function useStoryScroll(lastEntry: string | undefined) {
  const feedElement = useRef<HTMLDivElement>(null);
  const feedContent = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition>({ following: true, top: 0 });
  const previousEntry = useRef(lastEntry);
  const [newEvents, setNewEvents] = useState(false);

  const remember = useCallback(() => {
    const element = feedElement.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-story-entry]')).find(
      (entry) => entry.getBoundingClientRect().bottom > top,
    );
    position.current = {
      following: element.scrollHeight - element.scrollTop - element.clientHeight < 80,
      top: element.scrollTop,
      anchor: anchor
        ? { id: anchor.dataset.storyEntry!, offset: anchor.getBoundingClientRect().top - top }
        : undefined,
    };
    if (position.current.following) setNewEvents(false);
  }, []);

  const restore = useCallback(() => {
    const element = feedElement.current;
    if (!element) return;
    const saved = position.current;
    if (saved.following) element.scrollTop = element.scrollHeight;
    else {
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-story-entry]')).find(
        (entry) => entry.dataset.storyEntry === saved.anchor?.id,
      );
      element.scrollTop =
        anchor && saved.anchor
          ? element.scrollTop +
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            saved.anchor.offset
          : saved.top;
    }
  }, []);

  useLayoutEffect(() => {
    if (lastEntry !== previousEntry.current && lastEntry && !position.current.following)
      setNewEvents(true);
    previousEntry.current = lastEntry;
    restore();
  }, [lastEntry, restore]);

  useLayoutEffect(() => {
    // Quotes, font loading and viewport changes can resize the history without a new entry.
    const observer = new ResizeObserver(restore);
    if (feedElement.current) observer.observe(feedElement.current);
    if (feedContent.current) observer.observe(feedContent.current);
    return () => observer.disconnect();
  }, [restore]);

  const scrollToLatest = useCallback(() => {
    position.current = { following: true, top: 0 };
    restore();
    setNewEvents(false);
  }, [restore]);

  return { feedElement, feedContent, newEvents, onFeedScroll: remember, scrollToLatest };
}
