import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { StoryTurnInput, StoryTurnReceipt, StoryTurnSubmit } from '@dreamwalk/contracts';

type Locale = 'uk' | 'en' | 'ru';
const copy = {
  uk: {
    send: 'Надіслати',
    confirm: 'Підтвердити хід',
    retry: 'Повторити той самий запит',
    name: 'Українська',
  },
  en: { send: 'Send', confirm: 'Confirm turn', retry: 'Retry the same request', name: 'English' },
  ru: {
    send: 'Отправить',
    confirm: 'Подтвердить ход',
    retry: 'Повторить тот же запрос',
    name: 'Русский',
  },
};

async function setup(page: Page, locale: Locale, loseFirstSubmission = false) {
  const handle = `locale_ui_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      email: `${handle}@example.test`,
      name: 'Synthetic locale player',
      password: `Test-${randomUUID()}!`,
    },
  });
  expect(registered.ok()).toBeTruthy();
  expect(
    (await page.request.patch('/api/v1/account/settings', { data: { language: locale } })).ok(),
  ).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem('dreamwalk-language', value), locale);
  const started = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1', turnBased: true },
  });
  expect(started.ok()).toBeTruthy();
  const { campaignId } = await started.json();
  const quotes: { input: StoryTurnInput; language?: string }[] = [];
  const submissions: { input: StoryTurnSubmit; language?: string }[] = [];
  const completed: StoryTurnReceipt[] = [];
  let unexpectedPaidRoute = 0;
  // No provider dispatch is possible in this UI transport test, even if a future
  // fixture or local configuration accidentally exposes a paid control.
  for (const route of ['**/api/v1/live-test/**', '**/api/v1/image-generation/**'])
    await page.route(route, async (request) => {
      unexpectedPaidRoute++;
      await request.abort();
    });
  await page.route(`**/api/v1/game/campaigns/${campaignId}/turns**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/feed'))
      return route.fulfill({
        json: {
          canonRevision: 0,
          canSubmit: true,
          configuration: {
            provider: 'mock',
            enabled: true,
            externalCallsEnabled: false,
            demo: true,
            creditPrice: 0,
            providerUpperMicros: 0,
          },
          entries: [],
          turns: completed,
        },
      });
    if (path.endsWith('/quote')) {
      const input = request.postDataJSON() as StoryTurnInput;
      quotes.push({ input, language: request.headers()['accept-language'] });
      return route.fulfill({
        json: {
          status: 'quoted',
          operationId: input.operationId,
          turnId: randomUUID(),
          mode: 'director',
          segments: [{ index: 0, kind: 'speech', text: input.text }],
          actionPreview: [],
          quote: {
            id: randomUUID(),
            credits: 0,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            demo: true,
            requiresConsent: true,
            providerUpperMicros: 0,
            provider: 'mock',
            external: false,
            policyVersion: 'ui-locale-fixture',
          },
        },
      });
    }
    if (path.endsWith('/turns') && request.method() === 'POST') {
      const input = request.postDataJSON() as StoryTurnSubmit;
      submissions.push({ input, language: request.headers()['accept-language'] });
      if (loseFirstSubmission && submissions.length === 1) return route.abort('failed');
      const receipt: StoryTurnReceipt = {
        id: input.turnId,
        operationId: input.operationId,
        status: 'committed',
        channel: input.channel,
        inputText: input.text,
        createdAt: new Date().toISOString(),
        generationCost: 0,
        confirmationCost: 0,
      };
      completed.push(receipt);
      return route.fulfill({ json: receipt });
    }
    throw new Error(`Unexpected story route: ${request.method()} ${path}`);
  });
  await page.goto(`/game/${campaignId}`);
  const story = page.getByTestId('unified-story');
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(story.locator('textarea')).toBeEnabled();
  return { story, quotes, submissions, noPaidRoutes: () => expect(unexpectedPaidRoute).toBe(0) };
}

for (const locale of ['uk', 'en', 'ru'] as const) {
  test(`selected ${locale} is captured in quote and stays pinned after the interface language changes`, async ({
    page,
  }) => {
    const next: Locale = locale === 'uk' ? 'ru' : locale === 'en' ? 'uk' : 'en';
    const { story, quotes, submissions, noPaidRoutes } = await setup(page, locale);
    await story.locator('textarea').fill('A language-neutral test post 123');
    await story.getByRole('button', { name: copy[locale].send, exact: true }).click();
    await expect(story.getByTestId('story-quote')).toBeVisible();
    expect(quotes).toHaveLength(1);
    expect(quotes[0].input.replyLocale).toBe(locale);
    expect(quotes[0].language).toBe(locale);
    await page.locator('.locale-select').selectOption(next);
    await expect(page.locator('html')).toHaveAttribute('lang', next);
    await expect(story.getByTestId('story-reply-language')).toContainText(copy[locale].name);
    await story.getByRole('button', { name: copy[next].confirm, exact: true }).click();
    await expect(story.locator('textarea')).toHaveValue('');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].input).toMatchObject(quotes[0].input);
    expect(submissions[0].input.replyLocale).toBe(locale);
    expect(submissions[0].language).toBe(next);
    await story.locator('textarea').fill('A new post after choosing another language');
    await story.getByRole('button', { name: copy[next].send, exact: true }).click();
    await expect(story.getByTestId('story-reply-language')).toContainText(copy[next].name);
    expect(quotes).toHaveLength(2);
    expect(quotes[1].input.replyLocale).toBe(next);
    noPaidRoutes();
  });
}

test('an uncertain submission retry keeps its original operation and language across another selector change', async ({
  page,
}) => {
  const { story, quotes, submissions, noPaidRoutes } = await setup(page, 'uk', true);
  await story.locator('textarea').fill('An uncertain test post');
  await story.getByRole('button', { name: copy.uk.send, exact: true }).click();
  await expect(story.getByTestId('story-quote')).toBeVisible();
  await page.locator('.locale-select').selectOption('en');
  await story.getByRole('button', { name: copy.en.confirm, exact: true }).click();
  await expect(story.getByRole('button', { name: copy.en.retry, exact: true })).toBeVisible();
  await page.locator('.locale-select').selectOption('ru');
  await story.getByRole('button', { name: copy.ru.retry, exact: true }).click();
  await expect(story.locator('textarea')).toHaveValue('');
  expect(quotes).toHaveLength(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[1].input).toEqual(submissions[0].input);
  expect(submissions[1].input.replyLocale).toBe('uk');
  expect(submissions.map((request) => request.language)).toEqual(['en', 'ru']);
  noPaidRoutes();
});
