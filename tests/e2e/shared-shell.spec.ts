import { test, expect, type Page } from '@playwright/test';

// Isolated, synthetic UI journeys. No real accounts, wallets or server writes.
async function fixture(page: Page, signedIn = false, role = 'user', avatar = false) {
  let user: Record<string, unknown> | null = signedIn
    ? {
        id: 'shell-fixture',
        handle: 'synthetic_reader',
        role,
        avatarAssetId: avatar ? 'synthetic-avatar' : null,
        settings: { language: 'ru', theme: 'dark' },
      }
    : null;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/assets/synthetic-avatar/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/account/settings')) {
      user = {
        ...user,
        settings: { ...(user?.settings as object), ...route.request().postDataJSON() },
      };
      return route.fulfill({ json: user });
    }
    if (path.endsWith('/auth/logout')) {
      user = null;
      return route.fulfill({ json: {} });
    }
    const balance = {
      ownerId: 'shell-fixture',
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
    if (path.includes('/adventures')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
}
async function openRail(page: Page, width: number) {
  if (width <= 900 && !(await page.locator('#main-sidebar').isVisible()))
    await page.locator('.mobile-menu').click();
}
async function closeRail(page: Page, width: number) {
  if (width <= 900) await page.keyboard.press('Escape');
}

for (const signedIn of [false, true]) {
  test(`shared shell: ${signedIn ? 'account' : 'guest'} responsive preferences and navigation`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await fixture(page, signedIn);
    for (const width of [1536, 820, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      for (const locale of ['ru', 'uk', 'en']) {
        await page.goto('/explore');
        await openRail(page, width);
        await page.locator('.locale-select').selectOption(locale);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        for (const theme of ['dark', 'light']) {
          if ((await page.locator('html').getAttribute('data-theme')) !== theme)
            await page.locator('.theme-button').click();
          await closeRail(page, width);
          await page.reload();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('.topbar .top-search')).toHaveCount(0);
          await expect(page.locator('#main-sidebar a[href="/admin"]')).toHaveCount(0);
          if (signedIn) {
            await expect(page.getByTestId('sparks-balance')).toContainText('49');
            await expect(page.getByTestId('dreams-balance')).toContainText('49');
            await expect(page.locator('.profile-chip .avatar')).toHaveText('s');
            await expect(page.locator('.topbar a[href="/notifications"]')).toBeVisible();
          } else {
            await expect(page.locator('.wallet-chip')).toHaveCount(0);
            await expect(page.locator('.login-link')).toBeVisible();
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (width === 1536) {
            const title = await page.locator('.catalog-heading').boundingBox();
            const controls = await page.locator('.topbar').boundingBox();
            expect(title!.y).toBeLessThan(50);
            expect(controls!.y).toBeLessThan(50);
          }
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode()));
          });
          await page.screenshot({
            path: info.outputPath(
              `shell-${signedIn ? 'account' : 'guest'}-${width}-${locale}-${theme}.png`,
            ),
            fullPage: true,
          });
          await openRail(page, width);
        }
        const search = page.locator('.rail-search input');
        await search.fill('stars & moon');
        await search.press('Enter');
        await expect(page).toHaveURL(/\/explore\?q=stars%20%26%20moon/);
        if (width <= 900) await expect(page.locator('#main-sidebar')).not.toHaveClass(/open/);
        await openRail(page, width);
        await page.locator('#main-sidebar a[href="/help"]').click();
        await expect(page).toHaveURL(/\/help$/);
        await page.goBack();
        await expect(page).toHaveURL(/\/explore\?q=stars%20%26%20moon/);
        await page.goForward();
        await expect(page).toHaveURL(/\/help$/);
        if (width <= 900) {
          await expect(page.locator('#main-sidebar')).not.toHaveClass(/open/);
          await page.locator('.mobile-menu').click();
          await expect(page.locator('.mobile-close')).toBeFocused();
          await page.locator('.rail-preferences .theme-button').focus();
          await page.keyboard.press('Tab');
          await expect(page.locator('#main-sidebar .brand')).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          await expect(page.locator('.rail-preferences .theme-button')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(page.locator('#main-sidebar')).not.toBeVisible();
          await expect(page.locator('.mobile-menu')).toBeFocused();
          if (width === 390) await expect(page.locator('.bottom-nav')).toBeVisible();
          await page.locator('.mobile-menu').click();
          await page.locator('.menu-backdrop').click({ position: { x: width - 5, y: 200 } });
          await expect(page.locator('#main-sidebar')).not.toBeVisible();
        }
      }
    }
  });
}

test('admin navigation, actual avatar, logout and isolated auth/game shells', async ({ page }) => {
  await fixture(page, true, 'admin', true);
  await page.goto('/help');
  await expect(page.locator('#main-sidebar a[href="/admin"]')).toBeVisible();
  await expect(page.locator('.profile-chip')).toHaveAccessibleName('Профиль');
  await expect(page.locator('.profile-chip img')).toHaveAttribute('src', /synthetic-avatar/);
  await expect
    .poll(() =>
      page.locator('.profile-chip img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.goto('/game/synthetic-campaign');
  await expect(page.locator('#main-sidebar')).toHaveCount(0);
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await expect(page.locator('.locale-select')).toBeVisible();
  await expect(page.locator('.theme-button')).toBeVisible();
  await page.goto('/auth/sign-in');
  await expect(page.locator('#main-sidebar')).toHaveCount(0);
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await expect(page.locator('.locale-select')).toBeVisible();
  await page.goto('/help');
  await page.locator('.logout').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.wallet-chip')).toHaveCount(0);
  await expect(page.locator('#main-sidebar a[href="/admin"]')).toHaveCount(0);
});
