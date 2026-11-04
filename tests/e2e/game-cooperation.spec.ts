import { campaignDetails } from './support/campaign-details';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  readProjection,
  approachTarget,
  mapAction,
  mapMenu,
  inventory,
  closeInventory,
} from './support/map-actions';

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
test('two independent browser sessions share one key, preserve it on reload, and split maps', async ({
  browser,
}) => {
  test.setTimeout(process.env.CI ? 160000 : 90000);
  if (process.env.CI) {
    // CI runs one worker against one shared API/IP. Earlier scenarios can exhaust
    // its real 600/minute window; begin this scenario after a quiet full window,
    // before any mutation. Keep runtime limits and unknown-outcome rules intact.
    await new Promise((resolve) => setTimeout(resolve, 61000));
  }
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
    await campaignDetails(owner);
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestAccount.handle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(owner.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/game');
    await guest.getByRole('button', { name: 'Принять приглашение в кампанию' }).click();
    await expect(guest).toHaveURL(new RegExp(`/game/${campaignId}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await campaignDetails(owner, false);
    await expect(guest.locator('canvas')).toBeVisible();
    const ownerActorId = (await readProjection(owner, campaignId)).actorId;
    expect(
      (await readProjection(guest, campaignId)).entities.some((e) => e.id === ownerActorId),
    ).toBe(true);
    expect((await readProjection(guest, campaignId)).entities.some((e) => e.id === 'key')).toBe(
      true,
    );
    await approachTarget(owner, campaignId, 'key');
    await mapAction(owner, campaignId, 'key', 'Взять');
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
    await campaignDetails(owner, false);
    await expect((await inventory(owner)).locator('[data-inventory-id="key"]')).toHaveCount(1);
    await expect((await inventory(guest)).locator('[data-inventory-id="key"]')).toHaveCount(0);
    expect((await readProjection(owner, campaignId)).inventory.map((e) => e.id)).toEqual(['key']);
    expect((await readProjection(guest, campaignId)).inventory).toHaveLength(0);
    await closeInventory(owner);
    await closeInventory(guest);
    await approachTarget(owner, campaignId, 'door');
    await mapAction(owner, campaignId, 'door', 'Отпереть');
    await expect
      .poll(
        async () =>
          (await readProjection(owner, campaignId)).entities.find((e) => e.id === 'door')?.locked,
      )
      .toBe(false);
    await mapAction(owner, campaignId, 'door', 'Открыть');
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
    await approachTarget(owner, campaignId, 'roof-exit', true);
    await mapAction(owner, campaignId, 'roof-exit', 'Перейти', true);
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
