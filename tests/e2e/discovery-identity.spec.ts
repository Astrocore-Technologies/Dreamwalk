import { test, expect } from '@playwright/test';

for (const [locale, login] of [
  ['ru', 'Логин'],
  ['en', 'Login'],
  ['uk', 'Логін'],
] as const) {
  test(`signup has exactly three identity fields in ${locale}`, async ({ page }) => {
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    await page.goto('/auth/sign-up');
    await expect(page.getByLabel(login, { exact: true })).toBeVisible();
    await expect(page.locator('.auth-form input')).toHaveCount(3);
    await expect(page.locator('.auth-form input[name="name"]')).toHaveCount(0);
    await page.getByLabel(login, { exact: true }).fill('persistent_login');
    await page.goto('/auth/sign-in');
    await page.goBack();
    await expect(page.getByLabel(login, { exact: true })).toBeEditable();
    await expect(page.locator('.auth-form input')).toHaveCount(3);
  });
}

test('normal discovery hides editorial fixtures, retains user story cards and creation', async ({
  page,
}) => {
  const response = await page.request.get('/api/v1/adventures?sort=popular');
  expect(response.ok()).toBeTruthy();
  const stories = await response.json();
  const fixture = stories.find((story: { slug: string }) => story.slug === 'old-observatory');
  expect(fixture).toBeTruthy();
  // Explicit synthetic public user story alongside the unchanged first-party records.
  const userStory = {
    ...fixture,
    id: 'synthetic-user-story',
    slug: 'synthetic-user-story',
    author: { name: 'Legacy display name', handle: 'real_author' },
  };
  await page.route(/\/api\/v1\/adventures\?/, (route) =>
    route.fulfill({ json: [...stories, userStory] }),
  );
  await page.goto('/home');
  await expect(page.getByTestId('home-featured')).toHaveAttribute(
    'data-featured-slug',
    userStory.slug,
  );
  await expect(page.locator('.studio-promo')).toHaveCount(0);
  await expect(page.locator('#main-sidebar a[href="/studio/adventures/new"]')).toHaveCount(0);
  await expect(page.locator('#main-sidebar a[href="/studio"]')).toBeVisible();
  await expect(page.locator('nav a[href="/game"]')).toHaveCount(0);
  await page.goto('/explore');
  for (const slug of ['old-observatory', 'whispering-forest', 'tidekeepers', 'city-of-lanterns']) {
    await expect(page.locator(`.adventure-card[href="/adventures/${slug}"]`)).toHaveCount(0);
  }
  await expect(page.locator(`.adventure-card[href="/adventures/${userStory.slug}"]`)).toBeVisible();
  await expect(page.locator('.card-author').filter({ hasText: 'real_author' })).toHaveCount(1);
  // Presentation filtering is not data removal or a direct-URL ban.
  expect(
    (await page.request.get('/api/v1/adventures/old-observatory?view=published')).ok(),
  ).toBeTruthy();
});
