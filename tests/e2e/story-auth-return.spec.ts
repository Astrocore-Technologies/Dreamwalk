import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const storyPath = '/adventures/old-observatory';
function credentials() {
  const handle = `return_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return { handle, email: `${handle}@example.test`, password: `Return-${randomUUID()}!` };
}
async function chooseStory(page: Page) {
  await page.goto('/home');
  const featured = page.getByTestId('home-featured');
  await expect(featured).toHaveAttribute('data-featured-slug', /.+/);
  for (
    let i = 0;
    i < 30 && (await featured.getAttribute('data-featured-slug')) !== 'old-observatory';
    i++
  )
    await page.getByTestId('home-next').click();
  await expect(featured).toHaveAttribute('data-featured-slug', 'old-observatory');
  await page.getByTestId('home-start-adventure').click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/auth/sign-in' && url.searchParams.get('returnTo') === storyPath,
  );
}
async function signIn(page: Page, account: ReturnType<typeof credentials>) {
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Пароль', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}
async function assertNoCampaigns(page: Page) {
  const response = await page.request.get('/api/v1/game/campaigns');
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).campaigns).toHaveLength(0);
}
test('guest selected story survives signup and onboarding; explicit hero launch saves and Home resumes the same campaign', async ({
  page,
}) => {
  test.setTimeout(120000);
  const account = credentials();
  await chooseStory(page);
  // Cancellation is ordinary navigation, not a hidden campaign creation.
  await page.getByRole('link', { name: 'Вернуться к выбранной истории', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${storyPath}$`));
  await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
  await page.getByRole('link', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/auth/sign-up' && url.searchParams.get('returnTo') === storyPath,
  );
  await page.getByLabel('Как тебя называть?').fill('Story return QA');
  await page.getByLabel('Адрес профиля').fill(account.handle);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Пароль', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/onboarding' && url.searchParams.get('returnTo') === storyPath,
  );
  await page.getByLabel('Имя', { exact: true }).fill('Story return QA');
  await page.getByRole('button', { name: 'Открыть Dreamwalk', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${storyPath}$`));
  await assertNoCampaigns(page);
  const hero = await page.request.post('/api/v1/heroes', {
    data: {
      name: 'Вернувшаяся Лира',
      backstory: 'Исследовательница звёзд.',
      notes: '',
      traits: [],
    },
  });
  expect(hero.ok()).toBeTruthy();
  const heroId = (await hero.json()).id;
  await page.getByRole('link', { name: 'Подготовить героя', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/my-characters' && url.searchParams.get('returnTo') === storyPath,
  );
  await page.getByRole('link', { name: 'Играть этим героем', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === storyPath && url.searchParams.get('heroId') === heroId,
  );
  await expect(page.getByLabel('Герой для этого прохождения')).toHaveValue(heroId);
  await assertNoCampaigns(page);
  let creations = 0;
  await page.route('**/api/v1/game/campaigns', async (route) => {
    if (route.request().method() === 'POST') {
      creations++;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await route.continue();
  });
  await page
    .getByRole('button', { name: 'Начать прохождение', exact: true })
    .click({ clickCount: 2 });
  await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
  const campaignPath = new URL(page.url()).pathname;
  await expect(
    page
      .getByTestId('campaign-hero')
      .getByRole('heading', { name: 'Вернувшаяся Лира', exact: true }),
  ).toBeVisible();
  expect(creations).toBe(1);
  const loggedOut = page.waitForResponse(
    (r) => r.url().endsWith('/auth/logout') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  expect((await loggedOut).ok()).toBeTruthy();
  await page.goto('/auth/sign-in');
  await signIn(page, account);
  await expect(page).toHaveURL(/\/home$/);
  const resume = page.getByTestId('home-continue').locator(`a[href="${campaignPath}"]`);
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`${campaignPath}$`));
  await expect(
    page
      .getByTestId('campaign-hero')
      .getByRole('heading', { name: 'Вернувшаяся Лира', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByTestId('campaign-hero')
      .getByRole('heading', { name: 'Вернувшаяся Лира', exact: true }),
  ).toBeVisible();
  expect(creations).toBe(1);
});
test('failed sign-in retains selected story and safe Back flow; successful sign-in does not start it automatically', async ({
  page,
}) => {
  const account = credentials();
  expect(
    (
      await page.request.post('/api/v1/auth/register', { data: { ...account, name: 'Return QA' } })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post('/api/v1/account/onboarding', {
        data: { name: 'Return QA', genres: [], purpose: 'both', profilePublic: false },
      })
    ).ok(),
  ).toBeTruthy();
  expect((await page.request.post('/api/v1/auth/logout', { data: {} })).ok()).toBeTruthy();
  await chooseStory(page);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Пароль', { exact: true }).fill('Definitely-not-the-password');
  const rejected = page.waitForResponse(
    (r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page).toHaveURL((url) => url.searchParams.get('returnTo') === storyPath);
  await expect(
    page.getByRole('link', { name: 'Вернуться к выбранной истории', exact: true }),
  ).toHaveAttribute('href', storyPath);
  let releaseLogin!: () => void;
  let responseReady!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    responseReady = resolve;
  });
  await page.route('**/api/v1/auth/login', async (route) => {
    const response = await route.fetch(); // Real successful authentication; only delivery is delayed.
    expect(response.ok()).toBeTruthy();
    responseReady();
    await held;
    await route.fulfill({ response });
  });
  try {
    await signIn(page, account);
    await ready;
    await page.getByRole('link', { name: 'Вернуться к выбранной истории', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${storyPath}$`));
    // Choose another page before delivery: merely staying on the same story would not
    // distinguish a correctly cancelled form from a stale redirect to that story.
    await page.locator('a[href="/explore"]').first().click();
    await expect(page).toHaveURL(/\/explore$/);
    const delivered = page.waitForResponse((r) => r.url().endsWith('/auth/login') && r.ok());
    releaseLogin();
    await delivered;
    // A cancelled form must not use its late success to navigate to Home or create a save.
    await expect(page).toHaveURL(/\/explore$/);
    await assertNoCampaigns(page);
    await expect(page).toHaveURL(/\/explore$/);
  } finally {
    releaseLogin();
    await page.unroute('**/api/v1/auth/login');
  }
});
test('external return target is not propagated through auth links', async ({ page }) => {
  await page.goto('/auth/sign-in?returnTo=https%3A%2F%2Fexample.com%2Fsteal');
  await expect(
    page.getByRole('link', { name: 'Вернуться к выбранной истории', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-up$/);
});
