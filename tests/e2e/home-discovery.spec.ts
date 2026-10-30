import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function appearance(page: Page, language: 'en' | 'uk' | 'ru', theme: 'dark' | 'light') {
  await page.addInitScript(
    ({ language, theme }) => {
      if (!localStorage.getItem('dreamwalk-language'))
        localStorage.setItem('dreamwalk-language', language);
      if (!localStorage.getItem('dreamwalk-theme')) localStorage.setItem('dreamwalk-theme', theme);
    },
    { language, theme },
  );
}
async function publicHome(page: Page, preferredSlug?: string) {
  const catalog = await page.request.get('/api/v1/adventures?sort=popular');
  expect(catalog.ok()).toBeTruthy();
  const stories = (await catalog.json()) as { id: string; slug: string }[];
  expect(stories.length).toBeGreaterThan(1);
  await page.goto('/home');
  const featured = page.getByTestId('home-featured');
  await expect(featured).toBeVisible();
  await expect(featured).toHaveAttribute('data-featured-slug', /.+/);
  if (preferredSlug) {
    expect(stories.some((story) => story.slug === preferredSlug)).toBe(true);
    for (
      let step = 0;
      step < stories.length &&
      (await featured.getAttribute('data-featured-slug')) !== preferredSlug;
      step++
    ) {
      await page.getByTestId('home-next').click();
    }
    await expect(featured).toHaveAttribute('data-featured-slug', preferredSlug);
  }
  const slug = await featured.getAttribute('data-featured-slug');
  expect(stories.map((story) => story.slug)).toContain(slug);
  const detail = await page.request.get(`/api/v1/adventures/${slug}?view=published`);
  expect(detail.ok()).toBeTruthy();
  const published = (await detail.json()) as { npcs: { id: string }[] };
  await expect(featured.locator('[data-home-npc]')).toHaveCount(Math.min(3, published.npcs.length));
  return { featured, stories };
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const urls = new Set<string>();
    for (const element of document.querySelectorAll('*')) {
      const background = getComputedStyle(element).backgroundImage;
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) urls.add(match[1]);
    }
    await Promise.all(
      [...urls].map(
        (url) =>
          new Promise<void>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('Homepage artwork failed to load'));
            image.src = url;
          }),
      ),
    );
    await Promise.all(
      [...document.images].map((image) => {
        image.loading = 'eager';
        return image.decode();
      }),
    );
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

// Successful-render artifacts are intentionally anonymous. Never screenshot account/settings data.
test('public homepage is art-led, manually navigable, localized and captures actual desktop renders', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await appearance(page, 'en', 'dark');
  const { featured, stories } = await publicHome(page, 'old-observatory');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('home-continue').locator('a[href="/auth/sign-in"]')).toBeVisible();
  await expect(page.getByTestId('home-continue').locator('a[href^="/game/"]')).toHaveCount(0);
  const first = await featured.getAttribute('data-featured-slug');
  await screenshot(page, info, 'home-desktop-dark.png');
  await page.getByTestId('home-next').click();
  await expect(featured).not.toHaveAttribute('data-featured-slug', first!);
  expect(stories.map((story) => story.slug)).toContain(
    await featured.getAttribute('data-featured-slug'),
  );
  await page.getByTestId('home-previous').click();
  await expect(featured).toHaveAttribute('data-featured-slug', first!);
  // A bounded observation of the explicit no-autoplay requirement, not a network readiness sleep.
  await page.waitForTimeout(6500);
  await expect(featured).toHaveAttribute('data-featured-slug', first!);
  await featured.focus();
  await page.keyboard.press('ArrowRight');
  await expect(featured).not.toHaveAttribute('data-featured-slug', first!);
  await page.keyboard.press('ArrowLeft');
  await expect(featured).toHaveAttribute('data-featured-slug', first!);
  await page.getByTestId('home-next').focus();
  await page.keyboard.press('Enter');
  await expect(featured).not.toHaveAttribute('data-featured-slug', first!);
  await page.evaluate(() => {
    localStorage.setItem('dreamwalk-language', 'uk');
    localStorage.setItem('dreamwalk-theme', 'light');
  });
  await publicHome(page, 'old-observatory');
  await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(featured).toBeVisible();
  await screenshot(page, info, 'home-desktop-light.png');
});

test('390px homepage preserves readable art, manual touch navigation and public-only rails', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance(page, 'ru', 'dark');
  const { featured, stories } = await publicHome(page, 'old-observatory');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const first = await featured.getAttribute('data-featured-slug');
  await screenshot(page, info, 'home-mobile.png');
  await featured.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 330,
    clientY: 280,
    isPrimary: true,
  });
  await featured.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 75,
    clientY: 280,
    isPrimary: true,
  });
  await expect(featured).not.toHaveAttribute('data-featured-slug', first!);
  const allowed = new Set(stories.map((story) => `/adventures/${story.slug}`));
  const links = await page
    .locator('[data-home-rail] a[href^="/adventures/"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(allowed.has(link!)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('homepage excludes private and pending submissions and only resumes the current account campaign', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const response = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `home-${suffix}@example.test`,
      handle: `home_${suffix}`,
      name: 'Synthetic reader',
      password: `Home-${randomUUID()}!`,
    },
  });
  expect(response.status()).toBe(201);
  const hidden: { id: string; slug: string; title: string }[] = [];
  for (const visibility of ['private', 'public']) {
    const title = `HOME_NOT_APPROVED_${visibility}_${suffix}`;
    const created = await page.request.post('/api/v1/studio/adventures', {
      data: {
        title,
        synopsis: 'Synthetic unpublished adventure, never a public recommendation.',
        visibility,
        content: {
          world: 'A quiet courtyard.',
          locations: [{ id: 'courtyard', name: 'Courtyard' }],
          scenes: [{ id: 'arrival', name: 'Arrival', locationId: 'courtyard' }],
          startSceneId: 'arrival',
        },
      },
    });
    expect(created.ok()).toBeTruthy();
    const story = (await created.json()) as { id: string; slug: string; title: string };
    hidden.push(story);
    if (visibility === 'public')
      expect(
        (
          await page.request.post(`/api/v1/studio/adventures/${story.id}/submit`, { data: {} })
        ).ok(),
      ).toBeTruthy();
  }
  const campaignResponse = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1' },
  });
  expect(campaignResponse.ok()).toBeTruthy();
  const { campaignId } = (await campaignResponse.json()) as { campaignId: string };
  await publicHome(page);
  const resume = page.getByTestId('home-continue');
  await expect(resume).toBeVisible();
  await expect(resume.locator(`a[href="/game/${campaignId}"]`)).toBeVisible();
  for (const story of hidden)
    await expect(page.getByText(story.title, { exact: true })).toHaveCount(0);
  const guest = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const anonymous = await guest.newPage();
    const { stories } = await publicHome(anonymous);
    for (const story of hidden) {
      expect(stories.map((item) => item.id)).not.toContain(story.id);
      await expect(anonymous.getByText(story.title, { exact: true })).toHaveCount(0);
      expect((await anonymous.request.get(`/api/v1/adventures/${story.slug}`)).status()).toBe(404);
    }
    await expect(
      anonymous.getByTestId('home-continue').locator('a[href="/auth/sign-in"]'),
    ).toBeVisible();
    await expect(anonymous.getByTestId('home-continue').locator('a[href^="/game/"]')).toHaveCount(
      0,
    );
    expect(
      (await anonymous.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`)).status(),
    ).toBe(401);
  } finally {
    await guest.close();
  }
});

test('rapid featured navigation keeps the cast bound to the selected approved snapshot', async ({
  page,
}) => {
  await appearance(page, 'en', 'dark');
  const detailRequests: string[] = [];
  // Delay real public responses out of order; content is never mocked or substituted.
  await page.route('**/api/v1/adventures/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/v1/adventures/')) return route.continue();
    detailRequests.push(url.searchParams.get('view') || 'default');
    const response = await route.fetch();
    if (url.pathname.endsWith('/old-observatory'))
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });
  const { featured } = await publicHome(page);
  await page.getByTestId('home-next').click();
  await page.getByTestId('home-next').click();
  await page.getByTestId('home-previous').click();
  const slug = await featured.getAttribute('data-featured-slug');
  const published = await page.request.get(`/api/v1/adventures/${slug}?view=published`);
  expect(published.ok()).toBeTruthy();
  const detail = (await published.json()) as {
    npcs: { id: string }[];
    access: string;
    readOnly: boolean;
  };
  expect(detail.access).toBe('public');
  expect(detail.readOnly).toBe(true);
  expect(JSON.stringify(detail)).not.toContain('Авторская заметка: ключ спрятан в старых часах.');
  const allowed = new Set(detail.npcs.map((npc) => npc.id));
  await expect
    .poll(async () => {
      const ids = await featured
        .locator('[data-home-npc]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-home-npc')),
        );
      return ids.length === Math.min(detail.npcs.length, 3) && ids.every((id) => allowed.has(id!));
    })
    .toBe(true);
  expect(detailRequests.length).toBeGreaterThan(0);
  expect(detailRequests.every((view) => view === 'published')).toBe(true);
});

test('empty/error discovery states stay honest, retry works, and guest sign-in preserves Back navigation', async ({
  page,
}) => {
  await appearance(page, 'en', 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const catalog = '**/api/v1/adventures?sort=popular';
  await page.route(catalog, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.goto('/home');
  await expect(page.getByText('The first worlds are on their way', { exact: true })).toBeVisible();
  await expect(page.getByTestId('home-featured')).toHaveCount(0);
  await expect(page.locator('[data-home-rail]')).toHaveCount(0);
  await page.unroute(catalog);
  let failCatalog = true;
  await page.route(catalog, (route) => {
    if (failCatalog)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE' }),
      });
    return route.continue();
  });
  await page.reload();
  const error = page.getByTestId('home-catalog-error').getByRole('alert');
  await expect(error).toBeVisible();
  await expect(page.getByTestId('home-featured')).toHaveCount(0);
  failCatalog = false;
  await error.getByRole('button').click();
  await expect(page.getByTestId('home-featured')).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  await page.getByTestId('home-continue').locator('a[href="/auth/sign-in"]').click();
  await expect(page).toHaveURL(/\/auth\/sign-in$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId('home-featured')).toBeVisible();
});
