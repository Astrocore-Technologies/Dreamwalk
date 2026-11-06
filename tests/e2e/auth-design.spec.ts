import { test, expect } from '@playwright/test';

for (const locale of ['ru', 'uk', 'en'] as const) {
  test(`portal authentication layout and field controls (${locale})`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.addInitScript((language) => {
      localStorage.setItem('dreamwalk-language', language);
      if (!localStorage.getItem('dreamwalk-theme')) localStorage.setItem('dreamwalk-theme', 'dark');
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
        const emailLabel = { ru: 'Электронная почта', uk: 'Електронна пошта', en: 'Email' }[locale];
        await expect(page.locator('#auth-email')).toHaveAccessibleName(emailLabel);
        await expect(page.locator('#auth-email')).toHaveAttribute('placeholder', emailLabel);
        await expect(page.locator('.locale-select')).toBeVisible();
        await expect(page.locator('.theme-button')).toBeVisible();
        await expect(page.locator('.legal-note')).toHaveCSS(
          'font-size',
          width === 390 ? '13px' : '16px',
        );
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
    // The native form must allow uppercase, while the API owns canonical uniqueness.
    await page.goto('/auth/sign-up');
    const registrations: Record<string, unknown>[] = [];
    await page.route('**/api/v1/auth/register', (route) => {
      registrations.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { code: 'STATE_CONFLICT' } });
    });
    await page.locator('input[name="handle"]').fill('Uppercase_QA');
    await page.locator('#auth-email').fill('case@example.test');
    await page.locator('#auth-password').fill('synthetic-visual-password');
    await page.locator('.auth-form form button:not([type="button"])').click();
    await expect.poll(() => registrations.length).toBe(1);
    expect(registrations[0]).toMatchObject({ handle: 'Uppercase_QA', name: 'Uppercase_QA' });
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
    await page.route('**/api/v1/auth/reset-password', (route) =>
      route.fulfill({ json: { code: 'EMAIL_DELIVERY_UNAVAILABLE' } }),
    );
    await page.goto('/auth/reset-password');
    await page.locator('#auth-email').fill('synthetic-reset@example.test');
    await page.locator('form .button').last().click();
    const notice = page.locator('.auth-form [role=status]');
    const notices = {
      ru: 'Почтовая доставка не подключена. Восстановление доступа пока недоступно.',
      uk: 'Доставку пошти не підключено. Відновлення доступу поки недоступне.',
      en: 'Email delivery is not connected. Account recovery is not available yet.',
    };
    await expect(notice).toHaveText(notices[locale]);
    const nextLocale = locale === 'en' ? 'uk' : 'en';
    await page.locator('.locale-select').selectOption(nextLocale);
    await expect(notice).toHaveText(notices[nextLocale]);
    await expect(page.locator('#auth-email')).toHaveValue('synthetic-reset@example.test');
  });
}
