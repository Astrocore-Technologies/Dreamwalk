import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createUnpaidFixtureCampaign } from './support/unpaid-fixture-campaign';
import {
  gameEnvelopeSchema,
  storyTurnInputSchema,
  storyTurnSubmitSchema,
  type StoryTurnFeed,
  type StoryTurnInput,
  type StoryTurnReceipt,
  type StoryTurnSubmit,
} from '@dreamwalk/contracts';

type Locale = 'uk' | 'en' | 'ru';
const copy = {
  uk: {
    composer: 'Твій хід',
    send: 'Надіслати',
    confirm: 'Підтвердити хід',
    retry: 'Повторити той самий запит',
    name: 'Українська',
  },
  en: {
    composer: 'Your turn',
    send: 'Send',
    confirm: 'Confirm turn',
    retry: 'Retry the same request',
    name: 'English',
  },
  ru: {
    composer: 'Твой ход',
    send: 'Отправить',
    confirm: 'Подтвердить ход',
    retry: 'Повторить тот же запрос',
    name: 'Русский',
  },
};

async function selectLocale(page: Page, locale: Locale) {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/account/settings' &&
      response.request().method() === 'PATCH' &&
      response.request().postDataJSON()?.language === locale,
  );
  await page.locator('.locale-select').selectOption(locale);
  expect((await saved).ok()).toBeTruthy();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function setup(page: Page, locale: Locale, loseFirstSubmission = false) {
  test.setTimeout(90_000);
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
  const started = await createUnpaidFixtureCampaign(page.request);
  expect(
    started.ok(),
    `Fixture creation returned ${started.status()}: ${await started.text()}`,
  ).toBeTruthy();
  const { campaignId } = await started.json();
  const campaignPath = `/api/v1/game/campaigns/${campaignId}`;
  // Keep a real, schema-validated turn projection and socket. Only the story
  // transport is synthetic; never invent ownTurn to enable an otherwise locked UI.
  const snapshotResponse = await page.request.get(`${campaignPath}/snapshot`);
  expect(snapshotResponse.ok()).toBeTruthy();
  const { projection } = gameEnvelopeSchema.parse(await snapshotResponse.json());
  expect(projection.turn).toMatchObject({
    phase: 'player',
    ownTurn: true,
    activeActorId: projection.actorId,
    pendingResolution: false,
  });
  if (!projection.turn) throw new Error('The fixture requires a real turn-based campaign');
  const turnFence = {
    roundId: projection.turn.roundId,
    phaseEpoch: projection.turn.phaseEpoch,
    rulesetVersion: 1,
  };
  const feedResponse = await page.request.get(`${campaignPath}/turns/feed`);
  expect(feedResponse.ok()).toBeTruthy();
  const initialFeed: StoryTurnFeed = await feedResponse.json();
  expect(initialFeed.canSubmit).toBe(true);
  expect(initialFeed.configuration).toMatchObject({
    provider: 'local-turn-resolver',
    enabled: true,
    externalCallsEnabled: false,
    providerUpperMicros: 0,
  });
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
          ...initialFeed,
          entries: [],
          turns: completed,
        },
      });
    if (path.endsWith('/quote')) {
      const input = storyTurnInputSchema.parse(request.postDataJSON());
      expect(input.turnFence).toEqual(turnFence);
      expect(input.expectedCanonRevision).toBe(initialFeed.canonRevision);
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
            provider: initialFeed.configuration.provider,
            external: false,
            policyVersion: 'ui-locale-fixture',
          },
        },
      });
    }
    if (path.endsWith('/turns') && request.method() === 'POST') {
      const input = storyTurnSubmitSchema.parse(request.postDataJSON());
      expect(input.turnFence).toEqual(turnFence);
      expect(input.expectedCanonRevision).toBe(initialFeed.canonRevision);
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
  await expect(page.locator('[data-connected]')).toHaveAttribute('data-connected', 'true');
  // PartyChat has another (hidden) textarea inside UnifiedStory. Select the
  // actual localized story composer, and allow its real socket gate to settle.
  const composer = (language: Locale) =>
    story.getByRole('textbox', { name: copy[language].composer, exact: true });
  await expect(composer(locale)).toBeEnabled();
  return {
    story,
    composer,
    quotes,
    submissions,
    noPaidRoutes: () => expect(unexpectedPaidRoute).toBe(0),
  };
}

for (const locale of ['uk', 'en', 'ru'] as const) {
  test(`selected ${locale} is captured in quote and stays pinned after the interface language changes`, async ({
    page,
  }) => {
    const next: Locale = locale === 'uk' ? 'ru' : locale === 'en' ? 'uk' : 'en';
    const { story, composer, quotes, submissions, noPaidRoutes } = await setup(page, locale);
    await composer(locale).fill('A language-neutral test post 123');
    await story.getByRole('button', { name: copy[locale].send, exact: true }).click();
    await expect(story.getByTestId('story-quote')).toBeVisible();
    expect(quotes).toHaveLength(1);
    expect(quotes[0].input.replyLocale).toBe(locale);
    expect(quotes[0].language).toBe(locale);
    await selectLocale(page, next);
    await expect(story.getByTestId('story-reply-language')).toContainText(copy[locale].name);
    await story.getByRole('button', { name: copy[next].confirm, exact: true }).click();
    await expect(composer(next)).toHaveValue('');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].input).toMatchObject(quotes[0].input);
    expect(submissions[0].input.replyLocale).toBe(locale);
    expect(submissions[0].language).toBe(next);
    await composer(next).fill('A new post after choosing another language');
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
  const { story, composer, quotes, submissions, noPaidRoutes } = await setup(page, 'uk', true);
  await composer('uk').fill('An uncertain test post');
  await story.getByRole('button', { name: copy.uk.send, exact: true }).click();
  await expect(story.getByTestId('story-quote')).toBeVisible();
  await selectLocale(page, 'en');
  await story.getByRole('button', { name: copy.en.confirm, exact: true }).click();
  await expect(story.getByRole('button', { name: copy.en.retry, exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  await selectLocale(page, 'ru');
  expect(submissions).toHaveLength(1);
  await story.getByRole('button', { name: copy.ru.retry, exact: true }).click();
  await expect(composer('ru')).toHaveValue('');
  expect(quotes).toHaveLength(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[1].input).toEqual(submissions[0].input);
  expect(submissions[1].input.replyLocale).toBe('uk');
  expect(submissions.map((request) => request.language)).toEqual(['en', 'ru']);
  noPaidRoutes();
});
