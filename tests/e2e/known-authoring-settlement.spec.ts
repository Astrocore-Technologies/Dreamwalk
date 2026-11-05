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
async function fixture(
  page: Page,
  locale: 'en' | 'ru' | 'uk',
  lost: false | 'pending' | 'settled' = false,
) {
  const posts: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let settled = false;
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
              sparkStatus: settled ? 'settled' : 'pending',
              sparkReservedSubunits: '1000',
              sparkCapturedSubunits: settled ? '246' : null,
              actual_micros: '123',
            },
          ],
        },
      });
    if (endpoint === `/api/v1/generation/authoring-text/jobs/${jobId}/settlement`) {
      if (method === 'POST') {
        posts.push(route.request().postDataJSON());
        if (lost && posts.length === 1) {
          settled = lost === 'settled';
          return route.abort('failed');
        }
        settled = true;
      }
      return route.fulfill({ json: quote() });
    }
    return route.fulfill({ json: {} });
  });
  return { posts, writes };
}

for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`authoring settlement displays exact funding and requires explicit confirmation in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    const { posts, writes } = await fixture(page, locale);
    const text = settlementMessages[locale];
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    const button = form.getByRole('button', { name: text.confirm, exact: true });
    await expect(button).toBeEnabled();
    const decimal = locale === 'en' ? '.' : ',';
    await expect(form.getByTestId('authoring-dreams-charge')).toHaveText(`0${decimal}0100`);
    await expect(form.getByTestId('authoring-sparks-charge')).toHaveText(`0${decimal}0146`);
    await expect(form.getByTestId('authoring-provider-cost')).toHaveText('0.000123');
    await expect(form.getByTestId('authoring-sparks-release')).toHaveText(`0${decimal}0754`);
    await expect(form.getByText(text.noNew, { exact: true })).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    await expect(
      page.getByRole('button', {
        name:
          locale === 'en'
            ? 'Prepare plan'
            : locale === 'ru'
              ? 'Подготовить план'
              : 'Підготувати план',
        exact: true,
      }),
    ).toHaveCount(0);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(form).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      holdId,
      expectedActualMicros: '123',
      expectedReservedSubunits: '1000',
      expectedCaptureSubunits: '246',
      consent: true,
    });
    expect(posts[0].operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes).toEqual([`/api/v1/generation/authoring-text/jobs/${jobId}/settlement`]);
    await expect(button).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

for (const outcome of ['pending', 'settled'] as const) {
  test(`lost authoring settlement response survives reload with ${outcome} server state and no automatic replay`, async ({
    page,
  }) => {
    const { posts } = await fixture(page, 'en', outcome);
    const text = settlementMessages.en;
    await page.goto(path);
    await page.getByRole('button', { name: text.confirm, exact: true }).click();
    await expect(page.getByRole('button', { name: text.retry, exact: true })).toBeEnabled();
    expect(posts).toHaveLength(1);
    const original = posts[0];
    await page.reload();
    if (outcome === 'settled') {
      await expect(page.getByTestId('owner-authoring-settlement')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Prepare plan', exact: true })).toBeEnabled();
      expect(posts).toHaveLength(1);
    } else {
      const retry = page.getByRole('button', { name: text.retry, exact: true });
      await expect(retry).toBeEnabled();
      expect(posts).toHaveLength(1);
      await retry.click();
      await expect(page.getByTestId('owner-authoring-settlement')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Prepare plan', exact: true })).toBeEnabled();
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(original);
    }
  });
}
