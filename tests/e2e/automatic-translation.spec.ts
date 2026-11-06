import { test, expect } from '@playwright/test';

test('selected language refreshes saved story text and ignores a slower previous-language response', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('dreamwalk-language'))
      localStorage.setItem('dreamwalk-language', 'ru');
  });
  const story = {
    id: '4b47eba7-e071-497e-b382-d250ecb51a41',
    slug: 'translation-fixture',
    title: 'Тихий лес',
    synopsis: 'История о лесе',
    sourceLanguage: 'ru',
    sourceRevision: 1,
    genre: 'Фэнтези',
    tags: [],
    cover: 'forest',
    playersMin: 1,
    playersMax: 4,
    visibility: 'public',
    status: 'published',
    author: { name: 'Fixture author', handle: 'translation_fixture' },
    favoriteCount: 0,
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:00:00Z',
  };
  const requests: string[] = [];
  let slowEnglish = false;
  let releaseEnglish: (() => void) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: null } });
    if (path === '/api/v1/adventures') {
      const locale = req.headers()['accept-language'];
      requests.push(locale);
      if (locale === 'en' && slowEnglish)
        await new Promise<void>((resolve) => {
          releaseEnglish = resolve;
        });
      const text =
        locale === 'en'
          ? { title: 'Quiet forest', synopsis: 'A forest story' }
          : { title: 'Тихий ліс', synopsis: 'Історія про ліс' };
      return route.fulfill({
        json: [
          {
            ...story,
            translations: locale === 'ru' ? {} : { [locale]: { ...text, sourceRevision: 1 } },
          },
        ],
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/explore');
  const title = page.locator('.card-art-title');
  await expect(title).toHaveText('Тихий лес');
  await page.locator('.locale-select').selectOption('en');
  await expect(title).toHaveText('Quiet forest');
  await page.locator('.locale-select').selectOption('ru');
  await expect(title).toHaveText('Тихий лес');
  slowEnglish = true;
  await page.locator('.locale-select').selectOption('en');
  await expect.poll(() => Boolean(releaseEnglish)).toBe(true);
  await page.locator('.locale-select').selectOption('uk');
  await expect(title).toHaveText('Тихий ліс');
  const completedEnglish = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/adventures' &&
      response.request().headers()['accept-language'] === 'en',
  );
  releaseEnglish?.();
  await completedEnglish;
  await expect(title).toHaveText('Тихий ліс');
  expect(await page.evaluate(() => localStorage.getItem('dreamwalk-language'))).toBe('uk');
  await page.reload();
  await expect(page.locator('.locale-select')).toHaveValue('uk');
  await expect(title).toHaveText('Тихий ліс');
  expect(requests).toContain('ru');
  expect(requests).toContain('en');
  expect(requests).toContain('uk');
  await expect(page.getByRole('button', { name: /Translate|Перевести|Перекласти/i })).toHaveCount(
    0,
  );
});

test('a delayed game denial cannot erase the newest snapshot after en to uk to en', async ({
  page,
}) => {
  test.setTimeout(180000);
  const { randomUUID } = await import('node:crypto');
  const { createUnpaidFixtureCampaign, setUnpaidFixtureLocale } =
    await import('./support/unpaid-fixture-campaign');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `trgame-${suffix}@example.test`,
      handle: `trgame_${suffix}`,
      name: 'Synthetic locale reader',
      password: `Test-${randomUUID()}!`,
    },
  });
  expect(registered.ok()).toBeTruthy();
  expect((await setUnpaidFixtureLocale(page.request, 'en')).ok()).toBeTruthy();
  const started = await createUnpaidFixtureCampaign(page.request);
  expect(started.ok()).toBeTruthy();
  const { campaignId } = await started.json();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  let releaseOld: (() => void) | undefined;
  let held = false;
  await page.route(`**/api/v1/game/campaigns/${campaignId}/snapshot`, async (route) => {
    if (!held && route.request().headers()['accept-language'] === 'en') {
      held = true;
      await new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      return route.fulfill({
        status: 403,
        json: { code: 'FORBIDDEN', message: 'Synthetic stale response' },
      });
    }
    return route.continue();
  });
  await page.goto(`/game/${campaignId}`);
  await expect.poll(() => Boolean(releaseOld)).toBe(true);
  await page.locator('.locale-select').selectOption('uk');
  await expect(page.getByTestId('game-room')).toBeVisible();
  await page.locator('.locale-select').selectOption('en');
  await expect(page.getByTestId('game-room')).toBeVisible();
  const oldResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/campaigns/${campaignId}/snapshot`) && response.status() === 403,
  );
  releaseOld?.();
  await oldResponse;
  await expect(page.getByTestId('game-room')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

for (const width of [390, 1536])
  test(`pending metadata refreshes automatically and stops after language/navigation changes (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await page.addInitScript(() => {
      if (!localStorage.getItem('dreamwalk-language'))
        localStorage.setItem('dreamwalk-language', 'ru');
    });
    async function selectLocale(locale: 'en' | 'uk') {
      const select = page.locator('.locale-select');
      const inDrawer = !(await select.isVisible());
      if (inDrawer) await page.locator('.mobile-menu').click();
      await expect(select).toBeVisible();
      await select.selectOption(locale);
      if (inDrawer) {
        await page.keyboard.press('Escape');
        await expect(page.locator('.mobile-menu')).toHaveAttribute('aria-expanded', 'false');
      }
    }
    const counts = { en: 0, uk: 0 };
    let englishReady = false;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/auth/me') return route.fulfill({ json: { user: null } });
      if (path !== '/api/v1/adventures') return route.fulfill({ json: [] });
      const requested = route.request().headers()['accept-language'];
      const locale = requested === 'en' || requested === 'uk' ? requested : 'ru';
      if (locale !== 'ru') counts[locale]++;
      // A response count is not job completion: hydration may issue two GETs.
      const pending = locale === 'uk' || (locale === 'en' && !englishReady);
      return route.fulfill({
        headers: pending ? { 'X-Dreamwalk-Translation-Pending': 'true' } : {},
        json: [
          {
            id: '4b47eba7-e071-497e-b382-d250ecb51a41',
            slug: 'pending-fixture',
            title: 'Тихий лес',
            synopsis: 'История о лесе',
            sourceLanguage: 'ru',
            sourceRevision: 1,
            genre: 'Фэнтези',
            tags: [],
            cover: 'forest',
            playersMin: 1,
            playersMax: 4,
            visibility: 'public',
            status: 'published',
            author: { name: 'Fixture', handle: 'fixture' },
            favoriteCount: 0,
            createdAt: '2026-11-03T00:00:00Z',
            updatedAt: '2026-11-03T00:00:00Z',
            translations:
              pending || locale === 'ru'
                ? {}
                : { en: { title: 'Quiet forest', synopsis: 'A forest story', sourceRevision: 1 } },
          },
        ],
      });
    });
    await page.goto('/explore');
    const title = page.locator('.card-art-title');
    await expect(page.locator('.locale-select')).toHaveValue('ru');
    await expect(title).toHaveText('Тихий лес');
    expect(counts.en).toBe(0);
    const pendingEnglish = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/adventures' &&
        response.request().headers()['accept-language'] === 'en' &&
        response.headers()['x-dreamwalk-translation-pending'] === 'true',
    );
    await selectLocale('en');
    await (await pendingEnglish).finished();
    await expect.poll(() => counts.en).toBeGreaterThan(0);
    await expect(title).toHaveText('Тихий лес');
    const beforeReady = counts.en;
    englishReady = true;
    await page.clock.fastForward(1600);
    await expect(title).toHaveText('Quiet forest');
    expect(counts.en).toBe(beforeReady + 1);
    await page.clock.fastForward(6000);
    expect(counts.en).toBe(beforeReady + 1);
    await selectLocale('uk');
    await expect(title).toHaveText('Тихий лес');
    expect(counts.uk).toBe(1);
    await selectLocale('en');
    await expect(title).toHaveText('Quiet forest');
    await page.clock.fastForward(2000);
    expect(counts.uk).toBe(1);
    expect(counts.en).toBe(beforeReady + 2);
    await selectLocale('uk');
    await expect(title).toHaveText('Тихий лес');
    expect(counts.uk).toBe(2);
    await page.locator('a[href="/about"]').first().click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator('.locale-select')).toHaveValue('uk');
    const atNavigation = counts.uk;
    await page.clock.fastForward(2000);
    expect(counts.uk).toBe(atNavigation);
    await expect(page.getByRole('button', { name: /Translate|Перевести|Перекласти/i })).toHaveCount(
      0,
    );
  });
