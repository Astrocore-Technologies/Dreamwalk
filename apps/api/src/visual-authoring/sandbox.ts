import { createStateFromPlayable } from '@dreamwalk/game-core';
import type { PlayablePackage } from '@dreamwalk/contracts';
/** Private author sandbox: geometry uses the real engine, while tactical turn budgets belong to saved campaigns. */
export function createAuthorSandbox(playable: PlayablePackage) {
  const preview = structuredClone(playable);
  delete preview.turnRules;
  return createStateFromPlayable(preview, ['visual-preview-player'], 1);
}
