import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Studio authored layout persists and launches its own pinned campaign', async ({ page }) => {
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

  await page.getByRole('button', { name: /Локации$/ }).click();
  const editor = page.getByRole('region', { name: 'Игровая карта', exact: true });
  await editor.getByRole('button', { name: 'Шаблон: внутренний двор', exact: true }).click();
  await editor.getByLabel('Название карты', { exact: true }).fill(mapName);
  await editor.getByLabel('Инструмент карты', { exact: true }).selectOption('spawn');
  await editor.getByRole('button', { name: /^Клетка 4, 2:/ }).click();
  await editor.getByLabel('Инструмент карты', { exact: true }).selectOption('wall');
  await editor.getByRole('button', { name: /^Клетка 1, 1:/ }).click();
  await editor.getByLabel('Объект на карте', { exact: true }).selectOption('object:key');
  await editor.getByLabel('Название', { exact: true }).fill('Browser copper key');
  await editor.getByLabel('Объект на карте', { exact: true }).selectOption('npc:keeper');
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/playable-draft') &&
      r.request().method() === 'PUT' &&
      r
        .request()
        .postDataJSON()
        ?.draft?.npcs?.some((entry: { sourceNpcId?: string }) => entry.sourceNpcId === npcId),
  );
  await editor.getByLabel('Персонаж из библиотеки', { exact: true }).selectOption(npcId);
  expect((await saved).ok()).toBeTruthy();
  await expect(
    editor.locator('[data-autosave-scope="map"][data-autosave-status="saved"]'),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Локации$/ }).click();
  await expect(editor.getByLabel('Название карты', { exact: true })).toHaveValue(mapName);
  await editor.getByLabel('Объект на карте', { exact: true }).selectOption('object:key');
  await expect(editor.getByLabel('Название', { exact: true })).toHaveValue('Browser copper key');
  await editor.getByRole('button', { name: 'Сохранить и проверить в игре', exact: true }).click();
  await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
  const campaignId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
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
  await page.getByRole('button', { name: 'Начать координацию', exact: true }).click();
  const planning = page.getByRole('region', { name: 'Планирование раунда', exact: true });
  await expect(planning.getByRole('heading', { name: 'Раунд 1', exact: true })).toBeVisible();
  await planning.getByRole('button', { name: 'Ждать', exact: true }).click();
  await planning.getByRole('button', { name: 'Подтвердить намерение', exact: true }).click();
  await expect(planning.getByRole('heading', { name: 'Раунд 2', exact: true })).toBeVisible();
  await page.reload();
  await expect(planning.getByRole('heading', { name: 'Раунд 2', exact: true })).toBeVisible();
  await planning.getByRole('button', { name: 'Предложить завершить', exact: true }).click();
  await expect(planning).toHaveCount(0);
  const campaignUrl = page.url();
  await page.goto(adventureUrl);
  await page.getByRole('button', { name: /Локации$/ }).click();
  const edited = page.waitForResponse(
    (r) =>
      r.url().endsWith('/playable-draft') &&
      r.request().method() === 'PUT' &&
      r
        .request()
        .postDataJSON()
        ?.draft?.maps?.some(
          (entry: { label: string }) => entry.label === 'Unpublished changed map',
        ),
  );
  await editor.getByLabel('Название карты', { exact: true }).fill('Unpublished changed map');
  expect((await edited).ok()).toBeTruthy();
  await expect(
    editor.locator('[data-autosave-scope="map"][data-autosave-status="saved"]'),
  ).toBeVisible();
  await page.goto(campaignUrl);
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: mapName, exact: true, level: 1 })).toBeVisible();
});
