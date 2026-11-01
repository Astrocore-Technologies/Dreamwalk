import type { Adventure } from '@dreamwalk/contracts';

const editorialHandles = new Set(['dreamwalk', 'dreamwalk_editorial']);
const bundledStorySlugs = new Set([
  'old-observatory',
  'whispering-forest',
  'tidekeepers',
  'city-of-lanterns',
]);

/** Presentation only: keep acceptance fixtures and their direct URLs/data intact. */
export function isDiscoveryStory(
  story: Pick<Adventure, 'slug' | 'author' | 'visibility' | 'status'>,
) {
  return (
    story.visibility === 'public' &&
    story.status === 'published' &&
    !(editorialHandles.has(story.author.handle) && bundledStorySlugs.has(story.slug))
  );
}
