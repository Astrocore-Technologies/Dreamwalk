import { campaignDetails } from './support/campaign-details';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mapMenu } from './support/map-actions';

test('map inventory/menu focus stays inside; external focus and explicit keyboard Stop retain safety', async ({
  page,
}) => {
  const handle = `focus_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const account = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      name: 'Synthetic focus QA',
      email: `${handle}@example.test`,
      password: `Focus-${randomUUID()}!`,
    },
  });
  expect(account.ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  const created = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1', turnBased: false },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).campaignId;
  await page.goto(`/game/${id}`);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  const stops: string[] = [];
  const isStop = (url: string) => new URL(url).pathname === `/api/v1/game/campaigns/${id}/stop`;
  page.on('request', (request) => {
    if (request.method() === 'POST' && isStop(request.url())) stops.push(request.url());
  });
  const map = page.getByRole('group', { name: 'Карта приключения', exact: true });
  await map.focus();
  const inventory = page.getByRole('button', { name: /^Инвентарь/ });
  await inventory.focus();
  await inventory.click();
  const panel = page.getByRole('dialog', { name: 'Инвентарь', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const target = await mapMenu(page, id, 'key');
  await target.getByRole('button', { name: 'Подойти', exact: true }).focus();
  await page
    .getByRole('dialog', { name: 'Действия', exact: true })
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Действия', exact: true })).toHaveCount(0);
  expect(stops).toHaveLength(0);
  await map.focus();
  const outsideStop = page.waitForResponse(
    (response) => response.request().method() === 'POST' && isStop(response.url()),
  );
  await campaignDetails(page);
  await page.getByLabel('Пригласить по имени пользователя').focus();
  expect((await outsideStop).ok()).toBeTruthy();
  expect(stops).toHaveLength(1);
  await campaignDetails(page, false);
  const explicit = page.getByRole('button', { name: 'Остановиться', exact: true });
  await explicit.focus();
  const keyboardStop = page.waitForResponse(
    (response) => response.request().method() === 'POST' && isStop(response.url()),
  );
  await explicit.press('Enter');
  expect((await keyboardStop).ok()).toBeTruthy();
  expect(stops).toHaveLength(2);
});
