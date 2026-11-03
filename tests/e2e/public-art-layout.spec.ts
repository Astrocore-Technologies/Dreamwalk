import { test, expect } from '@playwright/test';

test('public art layouts preserve long titles, theme, locale and mobile reachability', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  // Synthetic local fixture only. Production author content is never rewritten.
  await page.route('**/api/v1/adventures?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: Array.isArray(data)
        ? data.map((story, index) => ({
            ...story,
            author: { ...story.author, handle: 'synthetic_discovery_author' },
            ...(index === 0
              ? {
                  title: 'Академия Семи Отзвуков: ночь без имени — длинное название',
                  translations: {},
                }
              : {}),
          }))
        : data,
    });
  });
  const catalog = await (await page.request.get('/api/v1/adventures?sort=popular')).json();
  expect(catalog.length).toBeGreaterThan(0);
  const routes = [
    '/explore',
    `/creators/${catalog[0].author.handle}`,
    '/auth/sign-in',
    '/help',
    '/about',
    '/home',
  ];
  for (const width of [1165, 390]) {
    await page.setViewportSize({ width, height: 973 });
    for (const theme of ['dark', 'light']) {
      await page.goto('/explore');
      await page.locator('.locale-select').selectOption('ru');
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.locator('.theme-button').click();
      for (const route of routes) {
        await page.goto(route);
        await expect(page.locator('#main-content')).toBeVisible();
        if (route === '/explore') {
          const card = page.locator('.illustrated-card').first();
          await expect(card).toBeVisible();
          const dimensions = await card.boundingBox();
          expect(dimensions!.width).toBeGreaterThan(269);
          const title = card.locator('.card-art-title');
          await expect(title).toContainText('Академия');
          expect((await title.boundingBox())!.height).toBeLessThan(110);
        }
        if (route === '/auth/sign-in') {
          await expect(page.locator('#main-sidebar')).toHaveCount(0);
          await expect(page.locator('.top-search')).toHaveCount(0);
          await expect(page.locator('.auth-form input[name="email"]')).toBeVisible();
          await expect(page.locator('.locale-select')).toBeVisible();
          await expect(page.locator('.theme-button')).toBeVisible();
        }
        if (route.startsWith('/creators/'))
          await expect(page.locator('.creator-banner')).toBeVisible();
        if (route === '/help') await expect(page.locator('.help-grid .button')).toHaveCount(4);
        if (route === '/about') await expect(page.locator('.about-feature')).toHaveCount(2);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.screenshot({
          path: info.outputPath(
            `public-art-${route.split('/').filter(Boolean).join('-')}-${width}-${theme}.png`,
          ),
          fullPage: true,
        });
      }
    }
  }
  for (const locale of ['en', 'uk']) {
    await page.goto('/auth/sign-in');
    await page.locator('.locale-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page
      .getByRole('link', {
        name: locale === 'en' ? 'Create account' : 'Створити обліковий запис',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/auth\/sign-up/);
    await page.goBack();
    await expect(page.locator('.auth-form input[name="email"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
});
