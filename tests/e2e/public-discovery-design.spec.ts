import { test, expect, type Page } from '@playwright/test';

async function fixtures(page: Page) {
  const response = await page.request.get('/api/v1/adventures?sort=popular');
  expect(response.ok()).toBeTruthy();
  const originals = await response.json();
  expect(originals.length).toBeGreaterThan(0);
  // Browser-only readable fixtures, not production content or new published stories.
  const stories = Array.from({ length: 6 }, (_, index) => ({
    ...originals[index % originals.length],
    id: `synthetic-discovery-${index}`,
    slug: `synthetic-discovery-${index}`,
    title: `Synthetic world ${index + 1}`,
    synopsis: 'A synthetic public story for layout verification.',
    translations: {},
    author: { name: 'Synthetic Author', handle: 'synthetic_author' },
    genre: index % 2 ? 'Мистика' : 'Фэнтези',
    totalRounds: index + 1,
    likeCount: index,
  }));
  await page.route('**/api/v1/genres', (route) => route.fulfill({ json: ['Фэнтези', 'Мистика'] }));
  await page.route('**/api/v1/adventures?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    let filtered = stories.filter((story) =>
      story.title.toLowerCase().includes((params.get('q') || '').toLowerCase()),
    );
    if (params.get('genre'))
      filtered = filtered.filter((story) => story.genre === params.get('genre'));
    if (params.get('sort') === 'new') filtered = [...filtered].reverse();
    return route.fulfill({ json: filtered });
  });
  await page.route('**/api/v1/creators/synthetic_author', (route) =>
    route.fulfill({
      json: {
        creator: {
          name: 'Synthetic Author',
          handle: 'synthetic_author',
          bio: 'Synthetic biography. Public worlds and shared adventures.',
        },
        adventures: stories.slice(0, 3),
      },
    }),
  );
  return stories;
}
async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map(async (image) => {
        image.loading = 'eager';
        await image.decode();
      }),
    );
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const locale of ['ru', 'uk', 'en']) {
  test(`catalog and creator reference composition in ${locale}`, async ({ page }, info) => {
    test.setTimeout(150_000);
    await fixtures(page);
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    await page.goto('/explore');
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => localStorage.setItem('dreamwalk-theme', value), theme);
        for (const [route, name] of [
          ['/explore', 'catalog'],
          ['/creators/synthetic_author', 'creator'],
        ]) {
          await page.goto(route);
          await expect(page.locator('.world-card').first()).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('.world-card')).toHaveCount(name === 'catalog' ? 6 : 3);
          await expect(page.locator('.world-card .world-card-image').first()).toHaveAttribute(
            'src',
            /\/images\//,
          );
          const grid = await page
            .locator('.discovery-grid')
            .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
          expect(grid).toBe(width === 1536 ? 3 : 1);
          const card = page.locator('.world-card').first();
          expect((await card.boundingBox())!.width).toBeGreaterThan(269);
          await expect(card.locator('.card-author')).toContainText('synthetic_author');
          await expect(card.locator('.story-metrics')).toContainText('1');
          await card.focus();
          await expect(card).toBeFocused();
          if (name === 'creator') {
            await expect(page.locator('.creator-banner h2')).toHaveText('@synthetic_author');
            await expect(page.locator('.creator-banner .avatar img')).toHaveCount(0);
            await expect(page.locator('.creator-bio')).toContainText('Synthetic biography.');
          }
          await ready(page);
          await page.screenshot({
            path: info.outputPath(`discovery-${name}-${locale}-${width}-${theme}.png`),
            fullPage: true,
          });
        }
      }
    }
  });
}

test('catalog filters, sorting, hero links, query navigation and empty/error recovery stay functional', async ({
  page,
}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  await page.goto('/explore?heroId=owned-hero');
  const cards = page.locator('.world-card');
  await expect(cards).toHaveCount(6);
  await expect(cards.first()).toHaveAttribute(
    'href',
    '/adventures/synthetic-discovery-0?heroId=owned-hero',
  );
  await page.locator('.sort-control select').selectOption('new');
  await expect(cards.first()).toHaveAttribute('href', /synthetic-discovery-5\?/);
  await page.locator('.filter-chips button').nth(1).click();
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.filter-chips button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.search-field input').fill('no such synthetic world');
  await expect(cards).toHaveCount(0);
  await page.locator('.empty button').click();
  await expect(cards).toHaveCount(6);
  await expect(page.locator('.search-field input')).toHaveValue('');
  await page.goto('/explore?q=Synthetic%20world%202');
  await expect(cards).toHaveCount(1);
  await page.goto('/creators/synthetic_author');
  await page.goBack();
  await expect(page.locator('.search-field input')).toHaveValue('Synthetic world 2');
  await expect(cards).toHaveCount(1);
  await page.route('**/api/v1/adventures?*', (route) =>
    route.fulfill({ status: 503, json: { message: 'Synthetic unavailable' } }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(
    'Не удалось выполнить запрос. Попробуйте ещё раз.',
  );
  await page.unroute('**/api/v1/adventures?*');
  await fixtures(page);
  await page.getByRole('alert').getByRole('button').click();
  await expect(cards).toHaveCount(1);
});

test('creator missing biography, long content and empty publication list remain honest', async ({
  page,
}) => {
  const stories = await fixtures(page);
  await page.route('**/api/v1/creators/synthetic_author', (route) =>
    route.fulfill({
      json: {
        creator: { name: '', handle: 'synthetic_author', bio: '' },
        adventures: [
          {
            ...stories[0],
            title:
              'A very long synthetic world title repeated to check wrapped text and accessible navigation',
            synopsis: 'A long synopsis '.repeat(30),
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/creators/synthetic_author');
  await expect(page.locator('.world-card')).toHaveCount(1);
  await expect(page.locator('.creator-bio')).not.toBeEmpty();
  await ready(page);
  await page.route('**/api/v1/creators/synthetic_author', (route) =>
    route.fulfill({
      json: {
        creator: { name: '', handle: 'synthetic_author', bio: '' },
        adventures: [],
      },
    }),
  );
  await page.reload();
  await expect(page.locator('.empty')).toBeVisible();
  await expect(page.locator('.world-card')).toHaveCount(0);
});

test('creator avatar and custom story cover keep their authorized asset URLs', async ({
  page,
}, info) => {
  const stories = await fixtures(page);
  // Tiny synthetic raster, never persisted or presented as a real account portrait.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
    'base64',
  );
  await page.route('**/api/v1/assets/synthetic-*/file', (route) =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/api/v1/creators/synthetic_author', (route) =>
    route.fulfill({
      json: {
        creator: {
          name: '',
          handle: 'synthetic_author',
          bio: 'Synthetic avatar coverage',
          avatarAssetId: 'synthetic-avatar',
        },
        adventures: [{ ...stories[0], coverAssetId: 'synthetic-cover' }],
      },
    }),
  );
  await page.goto('/creators/synthetic_author?heroId=owned-hero');
  await expect(page.locator('.creator-banner .avatar img')).toHaveAttribute(
    'src',
    '/api/v1/assets/synthetic-avatar/file',
  );
  await expect(page.locator('.world-card-image')).toHaveAttribute(
    'src',
    '/api/v1/assets/synthetic-cover/file',
  );
  await expect(page.locator('.world-card')).toHaveAttribute(
    'href',
    '/adventures/synthetic-discovery-0?heroId=owned-hero',
  );
  await ready(page);
  await page.screenshot({
    path: info.outputPath('discovery-creator-synthetic-assets.png'),
    fullPage: true,
  });
});
