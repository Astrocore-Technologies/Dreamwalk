import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type Snapshot = {
  projection: { actorId: string; entities: { id: string; x: number; y: number }[] };
};
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
async function position(page: Page, campaignId: string) {
  const response = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(response.ok()).toBeTruthy();
  const snapshot = (await response.json()) as Snapshot;
  const actor = snapshot.projection.entities.find(
    (entity) => entity.id === snapshot.projection.actorId,
  )!;
  return [actor.x, actor.y];
}

test('two independent browser sessions share one key, preserve it on reload, and split maps', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const ownerContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const owner = await ownerContext.newPage(),
    guest = await guestContext.newPage();
  try {
    const ownerAccount = await register(owner),
      guestAccount = await register(guest);
    await owner.goto('/game');
    await owner.getByRole('button', { name: 'Новая кампания', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const campaignId = new URL(owner.url()).pathname.split('/').at(-1)!;
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
    const key = owner.locator('[data-entity-id="key"]');
    await key.getByRole('button', { name: 'Подойти', exact: true }).click();
    await expect.poll(() => position(owner, campaignId)).toEqual([4, 6]);
    await key.getByRole('button', { name: 'Подобрать', exact: true }).click();
    await expect(owner.locator('[data-inventory-id="key"]')).toHaveCount(1);
    await expect(guest.locator('[data-entity-id="key"]')).toHaveCount(0);
    await expect(guest.locator('[data-inventory-id="key"]')).toHaveCount(0);
    await Promise.all([owner.reload(), guest.reload()]);
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(owner.locator('[data-inventory-id="key"]')).toHaveCount(1);
    await expect(guest.locator('[data-inventory-id="key"]')).toHaveCount(0);
    const door = owner.locator('[data-entity-id="door"]');
    await door.getByRole('button', { name: 'Подойти', exact: true }).click();
    await expect.poll(() => position(owner, campaignId)).toEqual([9, 5]);
    await door.getByRole('button', { name: 'Отпереть', exact: true }).click();
    await door.getByRole('button', { name: 'Открыть дверь', exact: true }).click();
    await expect(door.getByRole('button', { name: 'Закрыть дверь', exact: true })).toBeVisible();
    const exit = owner
      .locator('article')
      .filter({ has: owner.getByRole('heading', { name: 'Крыша', exact: true }) });
    await exit.getByRole('button', { name: 'Подойти', exact: true }).click();
    await expect.poll(() => position(owner, campaignId)).toEqual([12, 5]);
    await exit.getByRole('button', { name: 'Перейти', exact: true }).click();
    await expect(
      owner.getByRole('heading', { name: 'Крыша', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      guest.getByRole('heading', { name: 'Обсерватория', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(guest.locator(`[data-entity-id="player-${ownerAccount.user.id}"]`)).toHaveCount(0);
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
    await expect(owner.locator('[data-inventory-id="key"]')).toHaveCount(1);
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
