import { test, expect } from '@playwright/test';
import { exposeDiscoveryFixtures } from './support/discovery-fixtures';

test('public story detail omits duration and story boundaries without changing stored metadata', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  await exposeDiscoveryFixtures(page);
  const catalog = await page.request.get('/api/v1/adventures?sort=popular');
  expect(catalog.ok()).toBeTruthy();
  const stories = await catalog.json();
  expect(stories.length).toBeGreaterThan(0);
  const slug = stories[0].slug;
  const before = await (await page.request.get(`/api/v1/adventures/${slug}?view=published`)).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/adventures/${slug}`);
  await expect(page.locator('.discovery-detail')).toBeVisible();
  await expect(page.getByText('Длительность', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Границы истории', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'За порогом истории', exact: true }),
  ).toBeVisible();
  const after = await (await page.request.get(`/api/v1/adventures/${slug}?view=published`)).json();
  expect(after.duration).toEqual(before.duration);
  expect(after.content?.boundaries).toEqual(before.content?.boundaries);
});
