import { withShellPreferences } from './support/shell-preferences';
import { test, expect } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';

// Presentation fixtures only. Existing integration suites retain real account/RBAC checks.
for (const locale of ['ru', 'uk', 'en'] as const) {
  test(`account and admin illustrations remain readable and reachable (${locale})`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const user = {
      id: 'visual-account',
      handle: 'reader',
      name: 'Reader',
      role: 'admin',
      onboarded: true,
      emailVerified: false,
      emailVerificationRequired: false,
      settings: settingsSchema.parse({ language: locale, theme: 'dark' }),
    };
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
    );
    await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user } }));
    await page.route('**/api/v1/account/exports', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/account/sessions', (route) =>
      route.fulfill({
        json: [
          {
            id: 'session',
            current: true,
            createdAt: '2026-11-03T12:00:00Z',
            lastSeenAt: '2026-11-03T12:00:00Z',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0',
          },
        ],
      }),
    );
    await page.route('**/api/v1/admin/overview', (route) =>
      route.fulfill({ json: { users: 2, adventures: 3, pendingReview: 0, openReports: 0 } }),
    );
    await page.route('**/api/v1/account/settings', async (route) => {
      Object.assign(user.settings, route.request().postDataJSON());
      await route.fulfill({ json: user });
    });
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      for (const theme of ['dark', 'light']) {
        await page.goto('/account/profile');
        await expect(page.locator('.account-design')).toBeVisible();
        if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
          const saved = page.waitForResponse(
            (r) => r.url().endsWith('/account/settings') && r.request().method() === 'PATCH',
          );
          await withShellPreferences(page, () => page.locator('.theme-button').click());
          expect((await saved).ok()).toBeTruthy();
        }
        for (const route of [
          '/account/profile',
          '/account/settings',
          '/account/privacy',
          '/account/sessions',
          '/admin',
        ]) {
          await page.goto(route);
          await expect(page.locator('.account-design, .admin-design')).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await expect(page.locator('.tabs [aria-current="page"]')).toHaveCount(1);
          if (route === '/account/profile') {
            await expect(page.locator('.account-story-art')).toBeVisible();
            await expect(page.locator('.profile-upload .avatar img')).toHaveCount(0);
          }
          if (route === '/account/privacy') {
            const art = page.locator('.account-privacy-art');
            await expect(art).toBeVisible();
            const imageBox = await art.boundingBox();
            const panelBox = await page.locator('.account-privacy-panel').boundingBox();
            expect(
              Math.abs(imageBox!.x + imageBox!.width - panelBox!.x - panelBox!.width),
            ).toBeLessThan(2);
          }
          if (route === '/account/sessions') {
            await expect(page.locator('.session-row')).toContainText('Chrome · Linux');
            await expect(page.locator('.account-email-copy p').first()).toHaveCSS(
              'color',
              'rgb(255, 247, 237)',
            );
          }
          if (route === '/admin') {
            await expect(page.locator('.admin-overview-art img')).toHaveCount(2);
            await expect(page.locator('.admin-overview-art .button.primary')).toHaveCount(2);
          }
          for (const img of await page
            .locator('.account-story-art, .account-privacy-art, .admin-overview-art img')
            .all()) {
            await expect
              .poll(() =>
                img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
              )
              .toBe(true);
          }
          if (locale === 'ru')
            await info.attach(`${route.replaceAll('/', '-')}-${width}-${theme}`, {
              body: await page.screenshot({ fullPage: true }),
              contentType: 'image/png',
            });
        }
      }
    }
    user.emailVerificationRequired = true;
    await page.goto('/account/sessions');
    await expect(page.locator('.account-email-banner')).toBeVisible();
    await expect(page.locator('.account-email-copy')).toContainText(
      locale === 'ru' ? 'Подтверди почту' : locale === 'en' ? 'email' : 'пошту',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
