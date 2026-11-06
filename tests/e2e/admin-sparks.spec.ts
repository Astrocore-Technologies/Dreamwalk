import { test, expect } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';

test('admin retry adjusts actual Sparks once and wallet/header show the same balance', async ({
  page,
}) => {
  const user = {
    id: 'qa-admin',
    handle: 'qa_admin',
    name: 'QA admin',
    role: 'admin',
    settings: settingsSchema.parse({ language: 'ru' }),
    onboarded: true,
  };
  let amount = 500000;
  let first = true;
  const seen = new Set<string>();
  const keys: string[] = [];
  const wallet = () => ({
    ownerId: user.id,
    enabled: true,
    balanceSubunits: String(amount),
    heldSubunits: '0',
    availableSubunits: String(amount),
    subunitsPerSpark: '10000',
    ledger: [
      {
        id: '1',
        kind: 'admin_credit',
        amountSubunits: '1000000',
        createdAt: '2026-11-02T12:00:00Z',
        reason: 'Reward',
      },
    ],
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user } }));
  await page.route('**/api/v1/admin/users', (route) => route.fulfill({ json: [user] }));
  await page.route('**/api/v1/sparks/wallet', (route) => route.fulfill({ json: wallet() }));
  await page.route('**/api/v1/wallet', () => {
    throw new Error('UI must not request legacy demo wallet');
  });
  await page.route('**/api/v1/admin/credits', async (route) => {
    const body = route.request().postDataJSON();
    keys.push(body.idempotencyKey);
    if (!seen.has(body.idempotencyKey)) {
      seen.add(body.idempotencyKey);
      amount += body.amount * 10000;
    }
    if (first) {
      first = false;
      return route.abort('connectionclosed');
    }
    return route.fulfill({ status: 201, json: wallet() });
  });
  await page.goto('/admin/credits');
  await expect(page.getByTestId('sparks-balance')).toHaveText('50,00');
  const sparks = page.locator('[data-admin-currency="sparks"]');
  await sparks.getByLabel('Пользователь', { exact: true }).selectOption(user.id);
  await sparks.getByLabel('Причина операции', { exact: true }).fill('Reward');
  await sparks.getByRole('button', { name: 'Проверить операцию', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Подтвердить операцию с искрами?' });
  await dialog.getByRole('button', { name: 'Подтвердить операцию', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Подтвердить операцию', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(seen.size).toBe(1);
  await expect(page.getByTestId('sparks-balance')).toHaveText('150,00');
  await page.goto('/wallet');
  await expect(page.getByTestId('wallet-sparks-balance')).toHaveText('150,00✦');
  await expect(page.getByTestId('sparks-balance')).toHaveText('150,00');
  await expect(page.getByText('Reward', { exact: true })).toBeVisible();
  await expect(page.getByText('Магия без сюрпризов', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Искры за использование AI', { exact: true })).toHaveCount(0);
  await expect(page.getByText('DEMO · НЕ ДЕНЬГИ', { exact: true })).toHaveCount(0);
});
