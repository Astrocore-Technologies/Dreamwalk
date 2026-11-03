import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function syntheticAccount(page: Page) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const result = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `design-${suffix}@example.test`,
      handle: `design_${suffix}`,
      name: 'Synthetic design reader',
      password: `Design-${randomUUID()}!`,
    },
  });
  expect(result.status()).toBe(201);
}

test('shared public design keeps both themes and all languages through navigation and reload', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/home');
  for (const locale of ['ru', 'uk', 'en']) {
    await page.locator('.locale-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    for (const theme of ['light', 'dark']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.locator('.theme-button').click();
      await page.goto('/explore');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await noOverflow(page);
    }
  }
  for (const route of [
    '/auth/sign-in',
    '/auth/sign-up',
    '/auth/reset-password',
    '/help',
    '/about',
  ]) {
    await page.goto(route);
    await expect(page.locator('#main-content')).toBeVisible();
    await noOverflow(page);
  }
  await page.goto('/auth/sign-in');
  await info.attach('signin-desktop-dark', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.theme-button')).toBeVisible();
    await expect(page.locator('.locale-select')).toBeVisible();
    await noOverflow(page);
    await expect(page.locator('#main-sidebar')).not.toBeVisible();
    await page.locator('.mobile-menu').click();
    await expect(page.locator('#main-sidebar')).toBeInViewport();
    await page.locator('#main-sidebar a[href="/studio"]').click();
    await expect(page.locator('#main-sidebar')).not.toHaveClass(/open/);
  }
});

test('real likes are independent from saved stories and refresh public metrics', async ({
  page,
}) => {
  await syntheticAccount(page);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const catalog = await page.request.get('/api/v1/adventures?sort=popular');
  expect(catalog.ok()).toBeTruthy();
  const stories = await catalog.json();
  expect(stories.length).toBeGreaterThan(0);
  const story = stories[0];
  await page.goto(`/adventures/${story.slug}`);
  const like = page.getByRole('button', { name: 'Like this story', exact: true });
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await like.click();
  await expect(
    page.getByRole('button', { name: 'Unlike this story', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/adventures/${story.slug}?view=published`)).json())
          .likeCount,
    )
    .toBe(story.likeCount + 1);
  await page.reload();
  const unlike = page.getByRole('button', { name: 'Unlike this story', exact: true });
  await expect(unlike).toHaveAttribute('aria-pressed', 'true');
  await unlike.click();
  await expect(page.getByRole('button', { name: 'Like this story', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const after = await (
    await page.request.get(`/api/v1/adventures/${story.slug}?view=published`)
  ).json();
  expect(after.likeCount).toBe(story.likeCount);
  expect(after.totalRounds).toBe(story.totalRounds);
  await expect(page.locator('.story-metrics')).toContainText('Rounds');
  const draftResponse = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Synthetic private design draft',
      synopsis: 'Private authoring fixture',
      visibility: 'private',
    },
  });
  expect(draftResponse.ok()).toBeTruthy();
  const draft = await draftResponse.json();
  await page.goto(`/adventures/${draft.slug}`);
  await expect(page.locator('.discovery-detail')).toBeVisible();
  await expect(page.locator('.story-like-action')).toHaveCount(0);
});

test('author, player and account surfaces retain controls in both themes; gameplay is sidebar-free', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await syntheticAccount(page);
  await page.goto('/home');
  const routes = [
    '/library',
    '/my-characters',
    '/studio',
    '/studio/npcs/new',
    '/studio/adventures/new',
    '/studio/visuals',
    '/account/profile',
    '/account/settings',
    '/wallet',
    '/notifications',
    '/game',
  ];
  for (const theme of ['light', 'dark']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/account/settings') && response.request().method() === 'PATCH',
      );
      await page.locator('.theme-button').click();
      expect((await saved).ok()).toBeTruthy();
    }
    for (const route of routes) {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
      await expect(page.locator('#main-content h1').first()).toBeVisible();
      if (route === '/studio/npcs/new')
        await expect(page.getByLabel('Имя NPC', { exact: true })).toBeVisible();
      if (route === '/studio/adventures/new')
        await expect(page.getByLabel('Название приключения')).toBeVisible();
      if (route === '/account/profile') await expect(page.getByLabel('Логин')).toBeVisible();
      if (route === '/account/settings')
        await expect(page.getByLabel('Часовой пояс')).toBeVisible();
      if (route === '/wallet')
        await expect(page.getByTestId('wallet-sparks-balance')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('#main-sidebar')).toHaveCount(1);
      await noOverflow(page);
    }
  }
  const response = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1' },
  });
  expect(response.ok()).toBeTruthy();
  const { campaignId } = await response.json();
  await page.goto(`/game/${campaignId}`);
  await expect(page.locator('.game-shell')).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('game-position')).toBeVisible();
  await expect(page.locator('[data-turn-phase]')).toBeVisible();
  await expect(page.locator('#main-sidebar')).toHaveCount(0);
  await expect(page.locator('.bottom-nav')).toHaveCount(0);
  await expect(page.getByTestId('campaign-objectives')).toHaveCount(0);
  await expect(page.locator('.game-return')).toBeVisible();
  await noOverflow(page);
  await info.attach('game-desktop-synthetic', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await expect(page.locator('.theme-button')).toBeVisible();
});
