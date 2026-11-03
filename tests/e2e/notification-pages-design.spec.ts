import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, locale = 'en') {
  let theme = 'dark';
  let failRead = false;
  let failList = false;
  let releaseRead: (() => void) | undefined;
  const writes: string[] = [];
  let notifications = [
    {
      id: 'invite',
      type: 'invitation',
      title: '',
      message: '',
      payload: { inviter: 'synthetic_author', adventureTitle: 'Synthetic private observatory' },
      read: false,
      createdAt: '2026-10-01T14:20:00Z',
    },
    {
      id: 'moderation',
      type: 'moderation',
      title: '',
      message: '',
      payload: { title: 'Synthetic manuscript', reason: 'Synthetic review completed.' },
      read: false,
      createdAt: '2026-10-01T13:20:00Z',
    },
    {
      id: 'welcome',
      type: 'welcome',
      title: '',
      message: '',
      payload: {},
      read: true,
      createdAt: '2026-10-01T12:20:00Z',
    },
    {
      id: 'generic',
      type: 'system',
      title: 'Synthetic update',
      message: 'Synthetic message with a long but readable line. '.repeat(3),
      payload: {},
      read: true,
      createdAt: '2026-10-01T11:20:00Z',
    },
  ];
  await page.addInitScript((locale) => localStorage.setItem('dreamwalk-language', locale), locale);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-reader',
            handle: 'synthetic_reader',
            role: 'user',
            settings: { language: locale, theme, timezone: 'UTC' },
          },
        },
      });
    if (path.endsWith('/account/settings'))
      return route.fulfill({ json: { language: locale, theme, timezone: 'UTC' } });
    if (path.endsWith('/notifications'))
      return failList
        ? route.fulfill({
            status: 503,
            json: { code: 'INTERNAL_ERROR', message: 'Private synthetic diagnostic' },
          })
        : route.fulfill({ json: notifications });
    if (path.includes('/notifications/') && route.request().method() === 'PATCH') {
      writes.push(path);
      expect(route.request().postDataJSON()).toEqual({ read: true });
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      if (failRead)
        return route.fulfill({
          status: 503,
          json: { code: 'INTERNAL_ERROR', message: 'Private synthetic diagnostic' },
        });
      const id = path.split('/').at(-1);
      notifications = notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
      return route.fulfill({ json: { ok: true } });
    }
    const balance = {
      ownerId: 'synthetic-reader',
      balanceSubunits: '500000',
      heldSubunits: '10000',
      availableSubunits: '490000',
      ledger: [],
    };
    if (path.endsWith('/sparks/wallet'))
      return route.fulfill({ json: { ...balance, enabled: true, subunitsPerSpark: '10000' } });
    if (path.endsWith('/currencies/wallet'))
      return route.fulfill({
        json: {
          dreams: {
            ...balance,
            currency: 'dreams',
            subunitsPerDream: '10000',
            spendingAvailable: true,
          },
        },
      });
    if (path.endsWith('/library'))
      return route.fulfill({
        json: { favorites: [], drafts: [], privatePublished: [], heroes: [], shared: [] },
      });
    if (path.endsWith('/invitations') || path.includes('/adventures') || path.endsWith('/genres'))
      return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return {
    writes,
    theme: (value: string) => {
      theme = value;
    },
    failRead: (value: boolean) => {
      failRead = value;
    },
    failList: (value: boolean) => {
      failList = value;
    },
    empty: () => {
      notifications = [];
    },
    release: () => releaseRead?.(),
  };
}
async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const locale of ['ru', 'uk', 'en']) {
  test(`notification and missing-page reference composition ${locale}`, async ({ page }, info) => {
    const data = await fixture(page, locale);
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      for (const theme of ['dark', 'light']) {
        data.theme(theme);
        await page.goto('/notifications');
        await expect(page.locator('.notification-card')).toHaveCount(4);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('.notification-card[data-read="false"]')).toHaveCount(2);
        await expect(page.locator('.notification-card img')).toHaveCount(0);
        await expect(page.locator('.notification-card time').first()).toHaveAttribute(
          'datetime',
          '2026-10-01T14:20:00Z',
        );
        await ready(page);
        await page.screenshot({
          path: info.outputPath(`notifications-${locale}-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.goto('/synthetic-missing-route');
        await expect(page.locator('.missing-page')).toBeVisible();
        await expect(page.locator('.missing-page h1')).not.toBeEmpty();
        await expect(page.locator('.missing-page a')).toHaveAttribute('href', '/home');
        await ready(page);
        await page.screenshot({
          path: info.outputPath(`missing-page-${locale}-${width}-${theme}.png`),
          fullPage: true,
        });
      }
    }
    expect(data.writes).toEqual([]);
  });
}

test('notifications retain individual read, duplicate protection, safe failure, retry and invitations', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto('/notifications');
  const first = page.locator('.notification-card').first();
  const read = first.getByRole('button', { name: 'Read', exact: true });
  await expect(read).toBeVisible();
  await read.focus();
  await page.keyboard.press('Enter');
  await expect(read).toBeDisabled();
  await read.dispatchEvent('click');
  await expect.poll(() => data.writes.length).toBe(1);
  data.failRead(true);
  data.release();
  await expect(read).toBeEnabled();
  await expect(first).toHaveAttribute('data-read', 'false');
  await expect(page.locator('body')).not.toContainText('Private synthetic diagnostic');
  data.failRead(false);
  await read.click();
  await expect(read).toBeDisabled();
  await expect.poll(() => data.writes.length).toBe(2);
  data.release();
  await expect(page.locator('.notification-card').first()).toHaveAttribute('data-read', 'true');
  await page.locator('.notification-card').first().getByRole('link').click();
  await expect(page).toHaveURL(/\/library\?tab=invitations$/);
  await page.goBack();
  await expect(page.locator('.notifications-page')).toBeVisible();
  await expect.poll(() => data.writes.length).toBe(2);
  data.empty();
  await page.reload();
  await expect(page.locator('.notifications-page .empty')).toBeVisible();
  data.failList(true);
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.notifications-page .empty')).toHaveCount(0);
  data.failList(false);
  await page.getByRole('alert').getByRole('button').click();
  await expect(page.locator('.notifications-page .empty')).toBeVisible();
});

test('missing page home recovery and browser history remain usable', async ({ page }) => {
  const data = await fixture(page);
  await page.goto('/synthetic-missing-route');
  await page.locator('.missing-page a').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/home$/);
  await page.goBack();
  await expect(page.locator('.missing-page')).toBeVisible();
  expect(data.writes).toEqual([]);
});
