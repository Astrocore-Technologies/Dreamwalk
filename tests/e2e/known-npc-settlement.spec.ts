import { test, expect, type Page } from '@playwright/test';
import { settlementMessages } from '../../apps/web/components/game/known-npc-settlement-messages';

// All API traffic is intercepted. No real campaign, provider or balance is changed.
const ownerId = '11111111-1111-4111-8111-111111111111';
const campaignId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const holdId = '44444444-4444-4444-8444-444444444444';
const path = `/game/${campaignId}/settlement/${jobId}`;
async function fixture(
  page: Page,
  locale: 'en' | 'ru' | 'uk',
  initial: 'pending' | 'settled' = 'pending',
  mode: 'automatic' | 'legacy_confirmation' = 'automatic',
) {
  const posts: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let settled = initial === 'settled';
  let acceptPost = false;
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
    settlementMode: mode,
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
    if (endpoint === `/api/v1/game/campaigns/${campaignId}/ai/jobs/${jobId}/settlement`) {
      if (method === 'POST') {
        posts.push(route.request().postDataJSON());
        if (!acceptPost) return route.abort('failed');
        settled = true;
        return route.fulfill({ json: quote() });
      }
      return route.fulfill({ json: quote() });
    }
    return route.fulfill({ json: {} });
  });
  return {
    posts,
    writes,
    accept: () => {
      acceptPost = true;
    },
    settle: () => {
      settled = true;
    },
  };
}

for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`settlement is read-only and displays confirmed funding in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    const { posts, writes, settle } = await fixture(page, locale);
    const text = settlementMessages[locale];
    await page.goto(path);
    const form = page.getByTestId('known-npc-settlement');
    await expect(form.getByRole('status')).toHaveText(text.automatic);
    await expect(form.getByRole('button')).toHaveCount(0);
    await expect(form.getByTestId('settlement-sparks-charge')).toHaveCount(0);
    await expect(form.getByText(text.noNew, { exact: true })).toBeVisible();
    settle();
    await expect(form.getByRole('status')).toHaveText(text.complete, { timeout: 10000 });
    const decimal = locale === 'en' ? '.' : ',';
    await expect(form.getByTestId('settlement-dreams-charge')).toHaveText(`0${decimal}0100`);
    await expect(form.getByTestId('settlement-sparks-charge')).toHaveText(`0${decimal}0146`);
    await expect(form.getByTestId('settlement-dreams-release')).toHaveText(`0${decimal}0000`);
    await expect(form.getByTestId('settlement-sparks-release')).toHaveText(`0${decimal}0754`);
    await page.reload();
    await expect(form.getByRole('status')).toHaveText(text.complete);
    expect(posts).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
for (const initial of ['pending', 'settled'] as const) {
  test(`reload and back navigation cannot dispatch or capture a ${initial} bill`, async ({
    page,
  }) => {
    const { posts, writes } = await fixture(page, 'en', initial);
    await page.goto(path);
    const form = page.getByTestId('known-npc-settlement');
    const expected =
      initial === 'pending' ? settlementMessages.en.automatic : settlementMessages.en.complete;
    await expect(form.getByRole('status')).toHaveText(expected);
    await page.reload();
    await expect(form.getByRole('status')).toHaveText(expected);
    await expect(form.getByRole('button')).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
}

for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`legacy NPC/player exact confirmation settles only on click in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    const f = await fixture(page, locale, 'pending', 'legacy_confirmation');
    const text = settlementMessages[locale];
    await page.goto(path);
    const form = page.getByTestId('known-npc-settlement');
    await expect(form.getByRole('status')).toHaveText(text.legacy);
    await expect(form.getByRole('button', { name: text.confirm, exact: true })).toBeVisible();
    const decimal = locale === 'en' ? '.' : ',';
    await expect(form.getByTestId('settlement-sparks-charge')).toHaveText(`0${decimal}0146`);
    await expect(form.getByTestId('settlement-sparks-release')).toHaveText(`0${decimal}0754`);
    expect(f.writes).toHaveLength(0);
    f.accept();
    await form.getByRole('button', { name: text.confirm, exact: true }).click();
    await expect(form.getByRole('status')).toHaveText(text.complete);
    expect(f.posts).toHaveLength(1);
    await page.reload();
    await expect(form.getByRole('status')).toHaveText(text.complete);
    expect(f.posts).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
test('interrupted legacy confirmation reload uses the same durable operation ID', async ({
  page,
}) => {
  const f = await fixture(page, 'en', 'pending', 'legacy_confirmation');
  await page.goto(path);
  const form = page.getByTestId('known-npc-settlement');
  await form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }).click();
  await expect(
    form.getByRole('button', { name: settlementMessages.en.retry, exact: true }),
  ).toBeVisible();
  expect(f.posts).toHaveLength(1);
  await page.reload();
  await expect(
    form.getByRole('button', { name: settlementMessages.en.retry, exact: true }),
  ).toBeVisible();
  expect(f.posts).toHaveLength(1);
  f.accept();
  await form.getByRole('button', { name: settlementMessages.en.retry, exact: true }).click();
  await expect(form.getByRole('status')).toHaveText(settlementMessages.en.complete);
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]).toEqual(f.posts[0]);
});
