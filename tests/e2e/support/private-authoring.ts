import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authoredGameDraftSchema } from '@dreamwalk/contracts';
import { compilePlayableDraft } from '@dreamwalk/game-core';

export async function authoringRequest(page: Page, path: string, data?: unknown, method = 'POST') {
  const response =
    data === undefined
      ? await page.request.get(`/api/v1${path}`)
      : await page.request.fetch(`/api/v1${path}`, { method, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}
/** Synthetic API fixture coverage, not the removed manual-map editor UI.
 * Bind every map/NPC to author-owned source IDs before private playable publication.
 */
export async function savePrivateFixture(page: Page, storyId: string, input: unknown) {
  const draft = authoredGameDraftSchema.parse(structuredClone(input));
  for (const npc of draft.npcs) {
    if (!npc.sourceNpcId)
      npc.sourceNpcId = (
        await authoringRequest(page, '/npcs', {
          name: npc.label,
          description: 'Synthetic authored gameplay fixture',
        })
      ).id;
  }
  for (const map of draft.maps) map.sourceLocationId ||= `fixture-${map.id}`;
  expect(compilePlayableDraft(draft).errors, 'Synthetic playable fixture must validate').toEqual(
    [],
  );
  const story = await authoringRequest(page, `/studio/adventures/${storyId}`);
  await authoringRequest(
    page,
    `/studio/adventures/${storyId}`,
    {
      expectedEditRevision: story.editRevision,
      visibility: 'private',
      content: {
        ...story.content,
        locations: draft.maps.map((map) => ({
          id: map.sourceLocationId,
          name: map.label,
          description: 'Synthetic authored gameplay fixture',
        })),
        npcIds: [...new Set(draft.npcs.map((npc) => npc.sourceNpcId))],
      },
    },
    'PATCH',
  );
  const prior = await authoringRequest(page, `/studio/adventures/${storyId}/playable-draft`);
  const saved = await authoringRequest(
    page,
    `/studio/adventures/${storyId}/playable-draft`,
    { expectedRevision: prior.revision, draft },
    'PUT',
  );
  const persisted = await authoringRequest(page, `/studio/adventures/${storyId}/playable-draft`);
  expect(persisted.draft).toEqual(draft);
  return { draft, revision: saved.revision };
}
export async function publishPrivateFixture(page: Page, storyId: string) {
  const story = await authoringRequest(page, `/studio/adventures/${storyId}`);
  const game = await authoringRequest(page, `/studio/adventures/${storyId}/playable-draft`);
  const art = await authoringRequest(page, `/asset-library/stories/${storyId}/draft`);
  return authoringRequest(page, `/studio/adventures/${storyId}/private-release`, {
    operationId: randomUUID(),
    expectedEditRevision: story.editRevision,
    expectedGameRevision: game.revision,
    expectedArtRevision: art.revision,
  });
}
export async function launchPrivateFixture(page: Page, storyId: string, turnBased: boolean) {
  const release = await publishPrivateFixture(page, storyId);
  const campaign = await authoringRequest(page, '/game/campaigns', {
    playableVersionId: release.playableVersionId,
    turnBased,
  });
  await page.goto(`/game/${campaign.campaignId}`);
  return campaign.campaignId as string;
}
