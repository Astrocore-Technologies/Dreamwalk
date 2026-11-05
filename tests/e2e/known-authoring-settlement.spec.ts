import { test, expect, type Page } from '@playwright/test';
import { authoringSettlementMessages as settlementMessages } from '../../apps/web/components/visual-authoring/owner-authoring-settlement-messages';
import { randomUUID } from 'node:crypto';

// All API traffic is intercepted. No real authoring job, provider or balance is changed.
const ownerId = randomUUID(),
  storyId = randomUUID(),
  jobId = randomUUID(),
  holdId = randomUUID(),
  buildId = randomUUID();
const path = `/studio/gameplay/${storyId}`;
async function fixture(page: Page, locale: 'en' | 'ru' | 'uk', unavailable = false) {
  const posts: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let settled = false;
  let projected = false;
  const quote = () => ({
    jobId,
    holdId,
    status: settled ? 'settled' : 'pending',
    actualMicros: '123',
    reservedSubunits: '1000',
    captureSubunits: '246',
    releaseSubunits: '754',
    rateVersion: 'api-cent-2-sparks-v2',
    funding: {
      dreamsCaptureSubunits: '100',
      dreamsReleaseSubunits: '0',
      sparksCaptureSubunits: '146',
      sparksReleaseSubunits: '754',
    },
    requiresConsent: !settled,
    noGameEffect: true,
  });
  const balance = {
    ownerId,
    balanceSubunits: '10000',
    heldSubunits: '0',
    availableSubunits: '10000',
    ledger: [],
  };
  await page.route('**/api/v1/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== 'GET') writes.push(endpoint);
    if (endpoint.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: {
            id: ownerId,
            name: 'Synthetic owner',
            handle: 'synthetic',
            role: 'user',
            onboarded: true,
            settings: { language: locale, theme: 'dark', reducedMotion: true },
          },
        },
      });
    if (endpoint.endsWith('/sparks/wallet'))
      return route.fulfill({ json: { ...balance, enabled: true, subunitsPerSpark: '10000' } });
    if (endpoint.endsWith('/currencies/wallet'))
      return route.fulfill({
        json: {
          dreams: {
            ...balance,
            currency: 'dreams',
            subunitsPerDream: '10000',
            spendingAvailable: true,
          },
        },
      });
    if (
      endpoint === `/api/v1/story-builds/adventures/${storyId}/latest` ||
      endpoint === `/api/v1/story-builds/${buildId}`
    )
      return route.fulfill({
        json: {
          id: buildId,
          status: 'prepared',
          sourceHash: 'synthetic-source',
          draft: null,
          sourceCurrent: true,
          jobs: [
            {
              id: jobId,
              status: 'stale',
              error_code: 'MAP_IMAGE_UNCERTAIN',
              sparkStatus: projected ? 'settled' : 'pending',
              sparkReservedSubunits: '1000',
              sparkCapturedSubunits: projected ? '246' : null,
              actual_micros: '123',
            },
          ],
        },
      });
    if (endpoint === `/api/v1/generation/authoring-text/jobs/${jobId}/settlement`) {
      if (method !== 'GET') {
        posts.push(route.request().postDataJSON());
        return route.fulfill({ status: 409, json: { code: 'UNEXPECTED_UI_MUTATION' } });
      }
      if (unavailable && !settled)
        return route.fulfill({ status: 409, json: { code: 'AUTHORING_SETTLEMENT_UNAVAILABLE' } });
      return route.fulfill({ json: quote() });
    }
    return route.fulfill({ json: {} });
  });
  return {
    posts,
    writes,
    settle: () => {
      settled = true;
    },
    project: () => {
      projected = true;
    },
  };
}

for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`authoring cost recovers automatically without browser writes in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    const { posts, writes, settle, project } = await fixture(page, locale);
    const text = settlementMessages[locale];
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    await expect(form.getByText(text.automatic, { exact: true })).toBeVisible();
    await expect(form.getByRole('button')).toHaveCount(0);
    await expect(form.getByTestId('authoring-sparks-release')).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    settle();
    const decimal = locale === 'en' ? '.' : ',';
    await expect(form.getByTestId('authoring-dreams-charge')).toHaveText(`0${decimal}0100`, {
      timeout: 10000,
    });
    await expect(form.getByTestId('authoring-sparks-charge')).toHaveText(`0${decimal}0146`);
    await expect(form.getByTestId('authoring-provider-cost')).toHaveText('0.000123');
    await expect(form.getByTestId('authoring-sparks-release')).toHaveText(`0${decimal}0754`);
    project();
    await page.reload();
    await expect(form).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
test('unverified authoring cost stays honest across reload, without a manual settlement or retry', async ({
  page,
}) => {
  const { posts, writes, settle, project } = await fixture(page, 'en', true);
  await page.goto(path);
  const form = page.getByTestId('owner-authoring-settlement');
  await expect(form.getByText(settlementMessages.en.uncertain, { exact: true })).toBeVisible();
  await expect(form.getByRole('button')).toHaveCount(0);
  await page.reload();
  await expect(form.getByText(settlementMessages.en.uncertain, { exact: true })).toBeVisible();
  expect(posts).toHaveLength(0);
  expect(writes).toHaveLength(0);
  project();
  settle();
  await expect(form).toHaveCount(0, { timeout: 10000 });
  expect(posts).toHaveLength(0);
  expect(writes).toHaveLength(0);
});
