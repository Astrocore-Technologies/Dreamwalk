import { test, expect } from '@playwright/test';

for (const locale of ['ru', 'uk', 'en'] as const) {
  test(`portal authentication layout and field controls (${locale})`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.addInitScript((language) => {
      localStorage.setItem('dreamwalk-language', language);
      localStorage.setItem('dreamwalk-theme', 'dark');
    }, locale);
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
    );
    await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user: null } }));
    await page.route('**/api/v1/auth/providers', (route) =>
      route.fulfill({ json: { google: false } }),
    );
    await page.route('**/api/v1/auth/local-preview', (route) =>
      route.fulfill({ json: { localAdminAlias: false } }),
    );
    let submissions = 0;
    await page.route('**/api/v1/auth/login', (route) => {
      submissions++;
      return route.fulfill({ status: 401, json: { code: 'INVALID_CREDENTIALS' } });
    });
    const variants =
      locale === 'ru'
        ? [
            { width: 1536, theme: 'dark' },
            { width: 1536, theme: 'light' },
            { width: 390, theme: 'dark' },
            { width: 390, theme: 'light' },
          ]
        : [
            { width: 1536, theme: 'dark' },
            { width: 390, theme: 'light' },
          ];
    for (const { width, theme } of variants) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.goto('/auth/sign-in');
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.locator('.theme-button').click();
      for (const mode of ['sign-in', 'sign-up', 'reset-password']) {
        await page.goto(`/auth/${mode}`);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('.auth-form')).toBeVisible();
        await expect(page.locator('#main-sidebar')).toHaveCount(0);
        await expect(page.locator('#auth-email')).toBeVisible();
        await expect(page.locator('#auth-email')).toHaveAccessibleName('Email');
        await expect(page.locator('.locale-select')).toBeVisible();
        await expect(page.locator('.theme-button')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
          const image = new Image();
          image.src = '/images/auth-portal.webp';
          await image.decode();
        });
        await page.screenshot({
          path: info.outputPath(`auth-${mode}-${locale}-${width}-${theme}.png`),
          fullPage: true,
        });
      }
    }
    await page.goto('/auth/sign-in');
    const password = page.locator('#auth-password');
    const toggle = page.locator('.auth-password-toggle');
    await password.fill('synthetic-visual-password');
    await expect(password).toHaveAttribute('type', 'password');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(password).toHaveAttribute('type', 'text');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(password).toHaveAttribute('type', 'password');
    expect(submissions).toBe(0);
    await page.locator('.auth-switch a').click();
    await expect(page).toHaveURL(/\/auth\/sign-up$/);
    await expect(page.locator('#auth-password')).toHaveValue('');
    await page.goBack();
    await expect(page.locator('#auth-password')).toHaveAttribute('type', 'password');
    await page.locator('.auth-sub-link').click();
    await expect(page).toHaveURL(/\/auth\/reset-password$/);
    await expect(page.locator('#auth-password')).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('#auth-password')).toHaveAttribute('type', 'password');
    expect(submissions).toBe(0);
  });
}
