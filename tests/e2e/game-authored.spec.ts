import {
  savePrivateFixture,
  launchPrivateFixture,
  authoringRequest,
} from './support/private-authoring';
import { turnRulesSchema } from '@dreamwalk/contracts';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import type { GameProjection } from '@dreamwalk/contracts';
import { readProjection, reconfirmKnownStale } from './support/map-actions';

/** Split coverage: removed legacy start control uses explicit API reconfirmation;
 * current planning/reload/end controls are still exercised through the browser. */
async function beginLegacyCoordinationWithExplicitReconfirmation(page: Page, campaignId: string) {
  const send = async (expectedRevision: number) => {
    const response = await page.request.post(`/api/v1/game/campaigns/${campaignId}/commands`, {
      data: {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'encounter.begin',
        expectedRevision,
      },
    });
    expect(response.ok(), 'Unknown/HTTP outcomes must not be retried').toBeTruthy();
    return response.json();
  };
  const initial = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(initial.ok()).toBeTruthy();
  expect(
    (await initial.json()).projection.revision,
    'Revision zero must demonstrably be stale',
  ).toBeGreaterThan(0);
  const rejected = await send(0);
  expect(rejected.status).toBe('rejected');
  expect(rejected.code).toBe('STALE_STATE');
  expect(rejected.events).toEqual([]);
  expect(rejected.projection.encounter).toBeUndefined();
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
    expect(snapshot.ok()).toBeTruthy();
    const result = await send((await snapshot.json()).projection.revision);
    if (result.status === 'committed') return;
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('STALE_STATE');
    expect(attempt, 'Bounded explicit reconfirmations exhausted').toBeLessThan(2);
  }
}

test('Studio narrative autosave plus API-authored fixture launches its pinned campaign', async ({
  page,
}) => {
  test.setTimeout(90000);
  const mapName = 'M'.repeat(120);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `map-${suffix}@example.test`,
      handle: `map_${suffix}`,
      name: 'Map QA',
      password: `Map-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  const npc = await page.request.post('/api/v1/npcs', {
    data: {
      name: `Gardener ${suffix}`,
      description: 'A patient gardener.',
      secrets: 'BROWSER_PRIVATE_NPC_SECRET',
    },
  });
  expect(npc.ok()).toBeTruthy();
  const npcId = (await npc.json()).id as string;
  await page.goto(`/studio/npcs/${npcId}`);
  const npcSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/npcs/${npcId}`) &&
      r.request().method() === 'PATCH' &&
      r.request().postDataJSON()?.name === `Autosaved gardener ${suffix}`,
  );
  await page.getByLabel('Имя NPC', { exact: true }).fill(`Autosaved gardener ${suffix}`);
  expect((await npcSaved).ok()).toBeTruthy();
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Имя NPC', { exact: true })).toHaveValue(
    `Autosaved gardener ${suffix}`,
  );

  await page.goto('/studio/adventures/new');
  await page.getByLabel('Название приключения').fill(`Custom courtyard ${suffix}`);
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/adventures\/[a-f0-9-]+$/);
  const adventureUrl = page.url();
  const adventureId = new URL(adventureUrl).pathname.split('/').at(-1)!;
  const narrativeSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/studio/adventures/${adventureId}`) &&
      r.request().method() === 'PATCH' &&
      r.request().postDataJSON()?.title === `Autosaved courtyard ${suffix}`,
  );
  await page.getByLabel('Название приключения').fill(`Autosaved courtyard ${suffix}`);
  expect((await narrativeSaved).ok()).toBeTruthy();
  await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Название приключения')).toHaveValue(
    `Autosaved courtyard ${suffix}`,
  );

  // Removed map-template controls are covered by a validated API fixture, not browser authoring.
  const draft = createAuthoredDraft('courtyard');
  draft.turnRules = turnRulesSchema.parse({});
  draft.maps[0].label = mapName;
  draft.maps[0].spawns[0] = { x: 4, y: 2 };
  draft.maps[0].blocked.push({ x: 1, y: 1 });
  draft.objects.find((entry) => entry.id === 'key')!.label = 'Browser copper key';
  draft.npcs[0].sourceNpcId = npcId;
  draft.npcs[0].npcPlaceholder = 'crowd';
  const fixture = await savePrivateFixture(page, adventureId, draft);
  await page.reload();
  const persisted = await authoringRequest(
    page,
    `/studio/adventures/${adventureId}/playable-draft`,
  );
  expect(persisted.draft.maps[0].label).toBe(mapName);
  expect(persisted.draft.npcs[0].npcPlaceholder).toBe('crowd');
  expect(persisted.draft.objects.find((entry: { id: string }) => entry.id === 'key').label).toBe(
    'Browser copper key',
  );
  const campaignId = await launchPrivateFixture(page, adventureId, true);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('[data-battlemap-grid]')).toHaveAttribute(
    'data-battlemap-grid',
    '24x24',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const snapshot = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(snapshot.ok()).toBeTruthy();
  const initial = await snapshot.json();
  const actor = initial.projection.entities.find(
    (entity: { id: string }) => entity.id === initial.projection.actorId,
  );
  expect([actor.x, actor.y]).toEqual([4, 2]);
  expect(initial.projection.map.blocked).toContainEqual({ x: 1, y: 1 });
  expect(JSON.stringify(initial)).not.toContain('BROWSER_PRIVATE_NPC_SECRET');
  expect(
    initial.projection.entities.find((entity: { id: string }) => entity.id === draft.npcs[0].id)
      ?.npcPlaceholder,
  ).toBe('crowd');
  await page.locator('canvas').screenshot({ path: test.info().outputPath('npc-silhouette.png') });
  expect(initial.projection.turn?.ownTurn).toBe(true);
  await expect(page.locator('[data-turn-phase="player"]')).toBeVisible();
  const roundNumber = initial.projection.turn.roundNumber;
  await page.getByRole('button', { name: 'Завершить ход', exact: true }).click();
  const readTurn = async () => {
    const response = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
    expect(response.ok()).toBeTruthy();
    return ((await response.json()).projection as GameProjection).turn;
  };
  await expect.poll(async () => (await readTurn())?.roundNumber).toBe(roundNumber + 1);
  await expect(page.locator('[data-turn-phase="player"]')).toBeVisible();
  expect((await readTurn())?.ownTurn).toBe(true);
  await page.reload();
  await expect(page.locator('[data-turn-phase="player"]')).toBeVisible();
  expect((await readTurn())?.roundNumber).toBe(roundNumber + 1);
  expect((await readTurn())?.ownTurn).toBe(true);
  const campaignUrl = page.url();
  await page.goto(adventureUrl);
  fixture.draft.maps[0].label = 'Unpublished changed map';
  await savePrivateFixture(page, adventureId, fixture.draft);
  await page.goto(campaignUrl);
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
});

// Realtime coordination remains supported, but is no longer the Studio launch default.
// Keep its bounded stale-state reconfirmation and persisted round coverage explicit.
test('explicit realtime authored campaign retains coordination recovery and persisted rounds', async ({
  page,
}) => {
  test.setTimeout(process.env.CI ? 160000 : 90000);
  if (process.env.CI) {
    // CI runs one worker against one shared API/IP. Earlier scenarios can exhaust
    // its real 600/minute window; begin this scenario after a quiet full window,
    // before any mutation. Keep runtime limits and unknown-outcome rules intact.
    await new Promise((resolve) => setTimeout(resolve, 61000));
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `realtime-${suffix}@example.test`,
      handle: `rt_${suffix}`,
      name: 'Realtime QA',
      password: `Realtime-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  const storyResponse = await page.request.post('/api/v1/studio/adventures', {
    data: { title: `Realtime courtyard ${suffix}` },
  });
  expect(storyResponse.ok()).toBeTruthy();
  const storyId = (await storyResponse.json()).id;
  const draft = createAuthoredDraft('courtyard');
  delete draft.turnRules;
  await savePrivateFixture(page, storyId, draft);
  const campaignId = await launchPrivateFixture(page, storyId, false);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  const snapshot = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(snapshot.ok()).toBeTruthy();
  expect((await snapshot.json()).projection.turn).toBeUndefined();
  await beginLegacyCoordinationWithExplicitReconfirmation(page, campaignId);
  const planning = page.getByRole('region', { name: 'Планирование раунда', exact: true });
  await expect(planning.getByRole('heading', { name: 'Раунд 1', exact: true })).toBeVisible();
  await planning.getByRole('button', { name: 'Ждать', exact: true }).click();
  const beforeIntent = await readProjection(page, campaignId);
  const encounter = beforeIntent.encounter!;
  expect(encounter.round).toBe(1);
  expect(encounter.intents[beforeIntent.actorId]).toBeUndefined();
  const confirm = planning.getByRole('button', { name: 'Подтвердить намерение', exact: true });
  // The keeper's normal tick-20 patrol can advance the world revision between
  // planning and confirmation. Only a proven no-effect stale receipt permits a
  // new visible decision; never retry an unknown outcome or a different round.
  await reconfirmKnownStale(
    page,
    campaignId,
    {
      type: 'encounter.intent',
      intent: {
        encounterId: encounter.id,
        generation: encounter.generation,
        round: encounter.round,
        intentRevision: 1,
        action: { kind: 'wait' },
        ready: true,
      },
    },
    () => confirm.click(),
    async () => {
      await expect(confirm).toBeEnabled();
    },
  );
  await expect(planning.getByRole('heading', { name: 'Раунд 2', exact: true })).toBeVisible();
  await page.reload();
  await expect(planning.getByRole('heading', { name: 'Раунд 2', exact: true })).toBeVisible();
  await planning.getByRole('button', { name: 'Предложить завершить', exact: true }).click();
  await expect(planning).toHaveCount(0);
});
