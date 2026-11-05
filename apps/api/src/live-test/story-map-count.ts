import { bodyHash } from '../ai/text-preflight';
import type { TextTokenCounter } from '../ai/text-context';
import type { TextReserveSnapshot } from '../generation/estimates';

export const STORY_MAP_COUNT_VERSION = 'story-map-exact-input-tokens-v1';
/** Internal control flow only: no prompt/image is stored on an enumerable error field. */
export class StoryMapCountRequired extends Error {
  readonly bodySha256: string;
  constructor(
    body: string,
    readonly model: string,
    readonly providerVersion: string,
    readonly count: (operationId: string) => Promise<number>,
    readonly accept: (tokens: number, expiresAt: number) => void,
  ) {
    super('STORY_MAP_EXACT_COUNT_REQUIRED');
    this.bodySha256 = bodyHash(body);
  }
}

/** Only server-owned accepted snapshots can restore an exact count after a worker restart. */
export function pinnedStoryMapCounter(
  body: string,
  model: string,
  version: string,
  pinned?: TextReserveSnapshot | null,
): TextTokenCounter | undefined {
  const hash = bodyHash(body);
  if (
    pinned?.contextWindow?.counterId !== STORY_MAP_COUNT_VERSION ||
    pinned.contextWindow.precision !== 'exact' ||
    pinned.bodySha256 !== hash ||
    pinned.providerFingerprint !== version ||
    pinned.model !== model ||
    !Number.isSafeInteger(pinned.estimatedInputTokens) ||
    pinned.estimatedInputTokens < 0
  )
    return;
  return storyMapExactCounter(body, model, pinned.estimatedInputTokens);
}

export function storyMapExactCounter(
  body: string,
  model: string,
  tokens: number,
): TextTokenCounter {
  const hash = bodyHash(body);
  return {
    id: STORY_MAP_COUNT_VERSION,
    precision: 'exact',
    supports: (candidate) => candidate === model,
    countInput: (candidate) => {
      if (bodyHash(candidate) !== hash) throw new Error('STORY_MAP_QUOTE_CHANGED');
      return tokens;
    },
  };
}
