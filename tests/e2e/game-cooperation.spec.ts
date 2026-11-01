import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { GameProjection } from '@dreamwalk/contracts';

async function register(page: Page) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const handle = `coop_${suffix}`;
  const response = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `coop-${suffix}@example.test`,
      handle,
      name: 'Co-op QA',
      password: `Coop-${randomUUID()}!`,
    },
  });
  expect(response.status()).toBe(201);
  return { handle, user: (await response.json()).user as { id: string } };
}
async function readProjection(page: Page, campaignId: string): Promise<GameProjection> {
  const response = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).projection;
}
async function position(page: Page, campaignId: string) {
  const projection = await readProjection(page, campaignId);
  const actor = projection.entities.find((entity) => entity.id === projection.actorId)!;
  return [actor.x, actor.y];
}
async function mapMenu(page: Page, campaignId: string, id: string, exit = false) {
  const projection = await readProjection(page, campaignId);
  const target = exit
    ? projection.map.exits.find((e) => e.id === id)
    : projection.entities.find((e) => e.id === id);
  expect(target, `Visible map target ${id} must exist`).toBeTruthy();
  const canvas = page.locator('[data-camera-scale]');
  await expect(canvas).toHaveAttribute('data-camera-scale', /[0-9]/);
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const camera = await canvas.evaluate((element) => ({
    x: Number((element as HTMLElement).dataset.cameraX),
    y: Number((element as HTMLElement).dataset.cameraY),
    scale: Number((element as HTMLElement).dataset.cameraScale),
  }));
  await page.mouse.click(
    box.x + camera.x + (target!.x + 0.5) * 48 * camera.scale,
    box.y + camera.y + (target!.y + 0.5) * 48 * camera.scale,
    { button: 'right' },
  );
  const menu = page.getByRole('dialog', { name: 'Действия', exact: true });
  await expect(menu).toBeVisible();
  if (!exit) await expect(menu.locator(`[data-map-target="${id}"]`)).toBeVisible();
  return exit ? menu : menu.locator(`[data-map-target="${id}"]`);
}
async function inventory(page: Page, english = false) {
  const name = english ? 'Inventory' : 'Инвентарь';
  const panel = page.getByRole('dialog', { name, exact: true });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(panel).toBeVisible();
  return panel;
}
async function closeInventory(page: Page) {
  await page
    .getByRole('dialog', { name: 'Инвентарь', exact: true })
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
}

test('two independent browser sessions share one key, preserve it on reload, and split maps', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const ownerContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const guestContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const owner = await ownerContext.newPage(),
    guest = await guestContext.newPage();
  try {
    await register(owner);
    const guestAccount = await register(guest);
    // This existing key/door scenario verifies the retained realtime compatibility save format.
    const created = await owner.request.post('/api/v1/game/campaigns', {
      data: { template: 'observatory-v1', turnBased: false },
    });
    expect(created.ok()).toBeTruthy();
    const campaignId = (await created.json()).campaignId as string;
    await owner.goto(`/game/${campaignId}`);
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(owner.locator('canvas')).toBeVisible();
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestAccount.handle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(owner.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/game');
    await guest.getByRole('button', { name: 'Принять приглашение в кампанию' }).click();
    await expect(guest).toHaveURL(new RegExp(`/game/${campaignId}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(guest.locator('canvas')).toBeVisible();
    const ownerActorId = (await readProjection(owner, campaignId)).actorId;
    expect(
      (await readProjection(guest, campaignId)).entities.some((e) => e.id === ownerActorId),
    ).toBe(true);
    expect((await readProjection(guest, campaignId)).entities.some((e) => e.id === 'key')).toBe(
      true,
    );
    await (
      await mapMenu(owner, campaignId, 'key')
    )
      .getByRole('button', { name: 'Подойти', exact: true })
      .click();
    await expect.poll(() => position(owner, campaignId)).toEqual([4, 6]);
    await (
      await mapMenu(owner, campaignId, 'key')
    )
      .getByRole('button', { name: 'Взять', exact: true })
      .click();
    await expect
      .poll(async () => (await readProjection(owner, campaignId)).inventory.map((e) => e.id))
      .toEqual(['key']);
    await expect
      .poll(async () =>
        (await readProjection(guest, campaignId)).entities.some((e) => e.id === 'key'),
      )
      .toBe(false);
    expect((await readProjection(guest, campaignId)).inventory).toHaveLength(0);
    await expect((await inventory(owner)).locator('[data-inventory-id="key"]')).toHaveCount(1);
    await expect((await inventory(guest)).locator('[data-inventory-id="key"]')).toHaveCount(0);
    await Promise.all([owner.reload(), guest.reload()]);
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect((await inventory(owner)).locator('[data-inventory-id="key"]')).toHaveCount(1);
    await expect((await inventory(guest)).locator('[data-inventory-id="key"]')).toHaveCount(0);
    expect((await readProjection(owner, campaignId)).inventory.map((e) => e.id)).toEqual(['key']);
    expect((await readProjection(guest, campaignId)).inventory).toHaveLength(0);
    await closeInventory(owner);
    await closeInventory(guest);
    await (
      await mapMenu(owner, campaignId, 'door')
    )
      .getByRole('button', { name: 'Подойти', exact: true })
      .click();
    await expect.poll(() => position(owner, campaignId)).toEqual([9, 5]);
    await (
      await mapMenu(owner, campaignId, 'door')
    )
      .getByRole('button', { name: 'Отпереть', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readProjection(owner, campaignId)).entities.find((e) => e.id === 'door')?.locked,
      )
      .toBe(false);
    await (
      await mapMenu(owner, campaignId, 'door')
    )
      .getByRole('button', { name: 'Открыть', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readProjection(owner, campaignId)).entities.find((e) => e.id === 'door')?.open,
      )
      .toBe(true);
    await expect(
      (await mapMenu(owner, campaignId, 'door')).getByRole('button', {
        name: 'Закрыть дверь',
        exact: true,
      }),
    ).toBeVisible();
    await owner
      .getByRole('dialog', { name: 'Действия', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();
    await (
      await mapMenu(owner, campaignId, 'roof-exit', true)
    )
      .getByRole('button', { name: 'Подойти', exact: true })
      .click();
    await expect.poll(() => position(owner, campaignId)).toEqual([12, 5]);
    await (
      await mapMenu(owner, campaignId, 'roof-exit', true)
    )
      .getByRole('button', { name: 'Перейти', exact: true })
      .click();
    await expect(
      owner.getByRole('heading', { name: 'Крыша', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      guest.getByRole('heading', { name: 'Обсерватория', exact: true, level: 1 }),
    ).toBeVisible();
    await expect.poll(async () => (await readProjection(owner, campaignId)).map.id).toBe('roof');
    await expect
      .poll(async () => (await readProjection(guest, campaignId)).map.id)
      .toBe('observatory');
    expect(
      (await readProjection(guest, campaignId)).entities.some((e) => e.id === ownerActorId),
    ).toBe(false);
    await owner.locator('header').getByRole('combobox').selectOption('en');
    await expect(
      owner.getByRole('heading', { name: 'Rooftop', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      guest.getByRole('heading', { name: 'Обсерватория', exact: true, level: 1 }),
    ).toBeVisible();
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect((await inventory(owner, true)).locator('[data-inventory-id="key"]')).toHaveCount(
      1,
    );
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
