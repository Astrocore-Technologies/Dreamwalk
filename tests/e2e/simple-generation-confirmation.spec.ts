import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import {
  authoringRequest,
  savePrivateFixture,
  publishPrivateFixture,
} from './support/private-authoring';

/** Browser-only quotes and submissions: no external provider or wallet mutation is reachable. */
async function setup(
  page: Page,
  expired = false,
  failFirstSubmission = false,
  dualWallet = false,
  turnBased = false,
) {
  const handle = `simple_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      name: 'Synthetic confirmation QA',
      email: `${handle}@example.test`,
      password: `Simple-${randomUUID()}!`,
    },
  });
  expect(registered.ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  // Legacy paid-confirmation tests require a supported hybrid save without turns.
  const adventure = await authoringRequest(page, '/studio/adventures', {
    title: 'Synthetic confirmation fixture',
  });
  const draft = createAuthoredDraft('courtyard');
  if (!turnBased) {
    draft.npcBehavior = 'reactive-v1';
    delete draft.turnRules;
  }
  await savePrivateFixture(page, adventure.id, draft);
  const release = await publishPrivateFixture(page, adventure.id);
  const created = await page.request.post('/api/v1/game/campaigns', {
    data: { playableVersionId: release.playableVersionId, turnBased },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).campaignId;
  const quotes: Record<string, unknown>[] = [];
  const submissions: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  // A removed diagnostic panel must not silently become an automatic paid preflight.
  await page.route(
    /\/api\/v1\/generation\/campaigns\/.*\/(?:consent|preflight)$/,
    async (route) => {
      forbidden.push(route.request().url());
      await route.fulfill({ status: 409, json: { code: 'SYNTHETIC_PROVIDER_FORBIDDEN' } });
    },
  );
  await page.route(`**/api/v1/game/campaigns/${id}/turns/quote`, async (route) => {
    const input = route.request().postDataJSON();
    quotes.push(input);
    await route.fulfill({
      json: {
        status: 'quoted',
        operationId: input.operationId,
        turnId: randomUUID(),
        mode: 'director',
        segments: [{ kind: 'speech', text: input.text }],
        actionPreview: [],
        quote: {
          id: randomUUID(),
          credits: 0,
          expiresAt: new Date(Date.now() + (expired ? -1000 : 300000)).toISOString(),
          demo: false,
          external: true,
          requiresConsent: true,
          provider: 'synthetic-browser-only',
          providerUpperMicros: 12500,
          chargeUnit: 'sparks',
          sparkReservedSubunits: '12500',
          ...(turnBased
            ? {
                demo: true,
                external: false,
                requiresConsent: false,
                provider: 'local-turn-resolver',
                providerUpperMicros: 0,
                chargeUnit: undefined,
                sparkReservedSubunits: undefined,
              }
            : {}),
          ...(dualWallet
            ? {
                funding: {
                  policyVersion: 'dreams-first-v1',
                  dreamsReservedSubunits: '10000',
                  sparksReservedSubunits: '2500',
                  totalReservedSubunits: '12500',
                  maxSparksSubunits: '12500',
                  allocation: 'estimate',
                },
              }
            : {}),
        },
      },
    });
  });
  await page.route(`**/api/v1/game/campaigns/${id}/turns`, async (route) => {
    expect(route.request().method()).toBe('POST');
    const input = route.request().postDataJSON();
    submissions.push(input);
    if (failFirstSubmission && submissions.length === 1) return route.abort('failed');
    // Hold the response long enough for repeated clicks to exercise the in-flight lock.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: { id: input.turnId, operationId: input.operationId, status: 'queued' },
    });
  });
  if (turnBased) {
    await page.route(`**/api/v1/game/campaigns/${id}/turns/feed`, async (route) => {
      const response = await route.fetch();
      const feed = await response.json();
      await route.fulfill({
        response,
        json: {
          ...feed,
          turns: submissions.map((input) => ({
            id: input.turnId,
            operationId: input.operationId,
            status: 'committed',
          })),
        },
      });
    });
  }
  await page.goto(`/game/${id}`);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  const story = page.getByTestId('unified-story');
  await expect(story.getByRole('button', { name: 'Отправить', exact: true })).toBeVisible();
  return { id, story, quotes, submissions, forbidden };
}

test('composer estimates once, cancels without sending, requotes edits and submits one consent', async ({
  page,
}) => {
  const { story, quotes, submissions, forbidden } = await setup(page);
  await expect(page.getByTestId('release-generation-panel')).toHaveCount(0);
  await expect(page.getByTestId('live-test-panel')).toHaveCount(0);
  await expect(page.getByTestId('text-count-preflight')).toHaveCount(0);
  const composer = story.getByRole('textbox', { name: 'Твой ход', exact: true });
  await composer.fill('Первое сообщение');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  const quote = story.getByTestId('story-quote');
  await expect(quote).toBeVisible();
  await expect(quote).toContainText(/Искр|✦/);
  await expect(quote).not.toContainText(/USD|synthetic-browser-only/);
  await expect(quote.getByRole('checkbox')).toHaveCount(0);
  await quote.screenshot({ path: test.info().outputPath('simple-confirmation-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('story-quote')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await quote.screenshot({ path: test.info().outputPath('simple-confirmation-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(quotes).toHaveLength(1);
  expect(submissions).toHaveLength(0);
  await quote.getByRole('button', { name: /Изменить|Отмена/, exact: true }).click();
  await expect(quote).toHaveCount(0);
  await expect(composer).toHaveValue('Первое сообщение');
  expect(submissions).toHaveLength(0);
  await composer.fill('Изменённое сообщение');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(quote).toBeVisible();
  expect(quotes).toHaveLength(2);
  expect(quotes[1].text).toBe('Изменённое сообщение');
  expect(quotes[1].operationId).not.toBe(quotes[0].operationId);
  // Editing while the estimate is visible invalidates it before any submission.
  await composer.fill('Окончательное сообщение');
  await expect(quote).toHaveCount(0);
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(quote).toBeVisible();
  const confirm = quote.getByRole('button', { name: /Подтвердить/, exact: false });
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    consent: true,
    text: 'Окончательное сообщение',
    operationId: quotes[2].operationId,
  });
  expect(submissions[0].quoteId).toBeTruthy();
  expect(forbidden).toEqual([]);
});

test('expired estimate never sends or grants generation consent', async ({ page }) => {
  const { story, submissions, forbidden } = await setup(page, true);
  await story.getByRole('textbox', { name: 'Твой ход', exact: true }).fill('Проверка срока оценки');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  const quote = story.getByTestId('story-quote');
  await expect(story).toContainText(/ист[её]к|устарел|заново/i);
  await expect(quote).toHaveCount(0);
  expect(submissions).toHaveLength(0);
  expect(forbidden).toEqual([]);
});

test('unknown submission keeps the draft locked and retries only the same consent operation', async ({
  page,
}) => {
  const { story, quotes, submissions, forbidden } = await setup(page, false, true);
  const composer = story.getByRole('textbox', { name: 'Твой ход', exact: true });
  await composer.fill('Не отправлять повторно автоматически');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  await story
    .getByTestId('story-quote')
    .getByRole('button', { name: /Подтвердить/ })
    .click();
  const recover = story.getByRole('button', { name: 'Повторить тот же запрос', exact: true });
  await expect(recover).toBeVisible();
  await expect(composer).toBeDisabled();
  expect(submissions).toHaveLength(1);
  expect(quotes).toHaveLength(1);
  await recover.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(quotes).toHaveLength(1);
  expect(forbidden).toEqual([]);
});

test('a stale unpaid reply gets one fresh estimate and consent without reposting the message', async ({
  page,
}) => {
  const { id, story, submissions, forbidden } = await setup(page);
  const turnId = randomUUID();
  let needsConfirmation = true;
  let estimates = 0;
  const quoteOperations: string[] = [];
  const consents: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/game/campaigns/${id}/turns/feed`, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    await route.fulfill({
      response,
      json: {
        ...feed,
        turns: needsConfirmation
          ? [
              {
                id: turnId,
                operationId: randomUUID(),
                status: 'committed',
                generationNeedsConfirmation: true,
                generationCost: null,
              },
            ]
          : [],
      },
    });
  });
  await page.route(
    `**/api/v1/game/campaigns/${id}/turns/${turnId}/replies/quote`,
    async (route) => {
      estimates++;
      quoteOperations.push(route.request().postDataJSON().operationId);
      await route.fulfill({
        json: {
          status: 'quoted',
          turnId,
          operationId: route.request().postDataJSON().operationId,
          actionPreview: [],
          quote: {
            id: randomUUID(),
            credits: 0,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            external: true,
            providerUpperMicros: 2500,
            chargeUnit: 'sparks',
            sparkReservedSubunits: '2500',
          },
        },
      });
    },
  );
  await page.route(
    `**/api/v1/game/campaigns/${id}/turns/${turnId}/replies/consent`,
    async (route) => {
      consents.push(route.request().postDataJSON());
      needsConfirmation = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ json: { status: 'authorized' } });
    },
  );
  await page.reload();
  const recovery = story.getByTestId('story-reply-confirmation');
  await expect(recovery).toBeVisible();
  expect(estimates).toBe(0);
  expect(consents).toHaveLength(0);
  await recovery.getByRole('button').click();
  await expect(recovery.getByTestId('story-cost')).toBeVisible();
  expect(estimates).toBe(1);
  await recovery.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(recovery.getByTestId('story-cost')).toHaveCount(0);
  expect(consents).toHaveLength(0);
  await recovery.getByRole('button').click();
  await expect(recovery.getByTestId('story-cost')).toBeVisible();
  await recovery
    .getByRole('button', { name: /Подтвердить/ })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(recovery).toHaveCount(0);
  expect(estimates).toBe(2);
  expect(consents).toHaveLength(1);
  expect(consents[0]).toMatchObject({ consent: true });
  expect(consents[0].operationId).toBe(quoteOperations[1]);
  expect(quoteOperations[1]).not.toBe(quoteOperations[0]);
  expect(consents[0].quoteId).toBeTruthy();
  expect(submissions).toHaveLength(0);
  expect(forbidden).toEqual([]);
});

test('dual-wallet estimate shows both balances and paid ceiling with the same single consent', async ({
  page,
}) => {
  const { story, quotes, submissions, forbidden } = await setup(page, false, false, true);
  await story.getByLabel('Твой ход', { exact: true }).fill('Осматриваю звёздную карту.');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  const price = story.getByTestId('story-cost');
  await expect(price.locator('[data-wallet-funding="estimate"]')).toBeVisible();
  await expect(price).toContainText('Грёзы: 1');
  await expect(price).toContainText('Искры: 0,25');
  await expect(price).toContainText('не более 1,25');
  expect(submissions).toHaveLength(0);
  await story.getByRole('button', { name: 'Подтвердить ход', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(quotes).toHaveLength(1);
  expect(forbidden).toEqual([]);
});

test('ordinary play sends once then ends turn without another confirmation', async ({ page }) => {
  const { id, story, quotes, submissions, forbidden } = await setup(
    page,
    false,
    false,
    false,
    true,
  );
  const commands: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/game/campaigns/${id}/commands`, async (route) => {
    const input = route.request().postDataJSON();
    commands.push(input);
    await route.fulfill({ json: { status: 'committed', operationId: input.operationId } });
  });
  await page.route(`**/api/v1/game/campaigns/${id}/world-generation/**`, async (route) => {
    forbidden.push(route.request().url());
    await route.abort();
  });
  const input = story.getByRole('textbox', { name: 'Твой ход', exact: true });
  await input.fill('Осматриваю двор');
  await story.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(input).toHaveValue('');
  await expect(story.getByTestId('story-quote')).toHaveCount(0);
  await expect(story.getByRole('button', { name: 'Подтвердить ход', exact: true })).toHaveCount(0);
  expect(quotes).toHaveLength(1);
  expect(submissions[0].operationId).toBe(quotes[0].operationId);
  await page.getByRole('button', { name: 'Завершить ход', exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ type: 'turn.end', ordinaryGeneration: true });
  expect(forbidden).toEqual([]);
});
