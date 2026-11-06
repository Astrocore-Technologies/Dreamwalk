import { test, expect, type Page } from '@playwright/test';
import { authoringSettlementMessages as settlementMessages } from '../../apps/web/components/visual-authoring/owner-authoring-settlement-messages';
import { randomUUID } from 'node:crypto';
import { settingsSchema, type Locale, type User } from '@dreamwalk/contracts';

// All API traffic is intercepted. No real authoring job, provider or balance is changed.
const ownerId = randomUUID(),
  storyId = randomUUID(),
  jobId = randomUUID(),
  holdId = randomUUID(),
  buildId = randomUUID();
const path = `/studio/gameplay/${storyId}`;
function syntheticOwner(id: string, locale: Locale): User {
  return {
    id,
    name: 'Synthetic owner',
    handle: 'synthetic',
    email: 'synthetic@example.invalid',
    emailVerified: true,
    bio: '',
    avatarAssetId: null,
    role: 'user',
    onboarded: true,
    settings: settingsSchema.parse({ language: locale, theme: 'dark', reducedMotion: true }),
    createdAt: '2026-11-06T00:00:00.000Z',
  };
}
async function fixture(
  page: Page,
  locale: 'en' | 'ru' | 'uk',
  options: { unavailable?: boolean; mode?: string } = { mode: 'automatic' },
) {
  const posts: Record<string, unknown>[] = [];
  const writes: string[] = [];
  let settled = false;
  let projected = false;
  let currentOwner = ownerId;
  let mode = options.mode;
  let actual = 123;
  let losePost: 'before' | 'after' | null = null;
  let gate: Promise<void> | null = null;
  let releaseRead: (() => void) | undefined;
  let blockedReads = 0;
  const quote = () => ({
    jobId,
    holdId,
    status: settled ? 'settled' : 'pending',
    actualMicros: String(actual),
    reservedSubunits: '1000',
    captureSubunits: String(actual * 2),
    releaseSubunits: String(1000 - actual * 2),
    rateVersion: 'api-cent-2-sparks-v2',
    funding: {
      dreamsCaptureSubunits: '100',
      dreamsReleaseSubunits: '0',
      sparksCaptureSubunits: String(actual * 2 - 100),
      sparksReleaseSubunits: String(1000 - actual * 2),
    },
    settlementMode: mode,
    noAuthoringEffect: true,
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
    if (endpoint.endsWith('/sparks/settlements'))
      return route.fulfill({
        json: {
          ownerId: currentOwner,
          entries: [
            {
              holdId,
              reservedSubunits: '1000',
              state: 'verified',
              kind: 'authoring',
              jobId,
              campaignId: null,
              quote: quote(),
            },
          ],
          nextCursor: null,
        },
      });
    if (endpoint.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: syntheticOwner(currentOwner, locale),
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
        if (mode !== 'legacy_confirmation')
          return route.fulfill({ status: 409, json: { code: 'UNEXPECTED_UI_MUTATION' } });
        const loss = losePost;
        losePost = null;
        if (loss !== 'before') settled = true;
        if (loss) return route.abort('failed');
        return route.fulfill({ json: quote() });
      }
      // An in-flight response belongs to the identity at request time. The old
      // valid quote must be discarded after remount, not rescued by a later 404.
      const requestOwner = currentOwner;
      const response = quote();
      if (gate) {
        blockedReads++;
        await gate;
      }
      if (requestOwner !== ownerId)
        return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
      if (options.unavailable && !settled)
        return route.fulfill({ status: 409, json: { code: 'AUTHORING_SETTLEMENT_UNAVAILABLE' } });
      return route.fulfill({ json: response });
    }
    return route.fulfill({ json: {} });
  });
  return {
    posts,
    writes,
    setMode: (value: string | undefined) => {
      mode = value;
    },
    changeAmount: () => {
      actual = 124;
    },
    loseNextPost: (when: 'before' | 'after') => {
      losePost = when;
    },
    switchOwner: () => {
      currentOwner = randomUUID();
      return syntheticOwner(currentOwner, locale);
    },
    blockRead: () => {
      gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead: () => {
      releaseRead?.();
      gate = null;
    },
    blockedReads: () => blockedReads,
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
  const { posts, writes, settle, project } = await fixture(page, 'en', {
    unavailable: true,
    mode: 'automatic',
  });
  await page.goto(path);
  const form = page.getByTestId('owner-authoring-settlement');
  await expect(form.getByText(settlementMessages.en.unavailable, { exact: true })).toBeVisible();
  await expect(form.getByRole('button')).toHaveCount(0);
  await page.reload();
  await expect(form.getByText(settlementMessages.en.unavailable, { exact: true })).toBeVisible();
  expect(posts).toHaveLength(0);
  expect(writes).toHaveLength(0);
  project();
  settle();
  await expect(form).toHaveCount(0, { timeout: 10000 });
  expect(posts).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`legacy authoring shows exact separate consent and submits once in ${locale}`, async ({
    page,
  }) => {
    const f = await fixture(page, locale, { mode: 'legacy_confirmation' });
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    const text = settlementMessages[locale];
    const decimal = locale === 'en' ? '.' : ',';
    await expect(form.getByText(text.legacyHint, { exact: true })).toBeVisible();
    await expect(form.getByTestId('authoring-dreams-charge')).toHaveText(`0${decimal}0100`);
    await expect(form.getByTestId('authoring-sparks-charge')).toHaveText(`0${decimal}0146`);
    await expect(form.getByTestId('authoring-sparks-release')).toHaveText(`0${decimal}0754`);
    await expect(form.getByTestId('authoring-provider-cost')).toHaveText('0.000123');
    await page.reload();
    await expect(form.getByRole('button', { name: text.confirm, exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(0);
    await form.getByRole('button', { name: text.confirm, exact: true }).click({ clickCount: 2 });
    await expect(form.getByText(text.complete, { exact: true })).toBeVisible();
    await expect(form.getByRole('button')).toHaveCount(0);
    await expect(form.getByText(text.legacyHint, { exact: true })).toHaveCount(0);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toEqual({
      operationId: expect.any(String),
      holdId,
      expectedActualMicros: '123',
      expectedReservedSubunits: '1000',
      expectedCaptureSubunits: '246',
      consent: true,
    });
    expect(f.writes).toEqual([`/api/v1/generation/authoring-text/jobs/${jobId}/settlement`]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.reload();
    await expect(form.getByText(text.complete, { exact: true })).toBeVisible();
    expect(f.posts).toHaveLength(1);
  });
}
for (const loss of ['before', 'after'] as const) {
  test(`lost legacy response ${loss} commit reloads read-only and preserves its operation`, async ({
    page,
  }) => {
    const f = await fixture(page, 'en', { mode: 'legacy_confirmation' });
    f.loseNextPost(loss);
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    await form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }).click();
    await expect(form.getByText(settlementMessages.en.uncertain, { exact: true })).toBeVisible();
    expect(f.posts).toHaveLength(1);
    if (loss === 'before') {
      // An interrupted attempt saved by the old UI has no settlement mode fields.
      await page.evaluate(() => {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i)!;
          if (!key.startsWith('dreamwalk:authoring-settlement:')) continue;
          const stored = JSON.parse(sessionStorage.getItem(key)!);
          delete stored.quote.settlementMode;
          delete stored.quote.noAuthoringEffect;
          sessionStorage.setItem(key, JSON.stringify(stored));
        }
      });
    }
    await page.reload();
    expect(f.posts).toHaveLength(1);
    if (loss === 'before') {
      await form.getByRole('button', { name: settlementMessages.en.retry, exact: true }).click();
      await expect(form.getByText(settlementMessages.en.complete, { exact: true })).toBeVisible();
      expect(f.posts).toHaveLength(2);
      expect(f.posts[1]).toEqual(f.posts[0]);
    } else {
      await expect(form.getByText(settlementMessages.en.complete, { exact: true })).toBeVisible();
      expect(f.posts).toHaveLength(1);
    }
  });
}
for (const change of ['amount', 'mode'] as const) {
  test(`changed legacy ${change} refuses the click without POST`, async ({ page }) => {
    const f = await fixture(page, 'en', { mode: 'legacy_confirmation' });
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    const button = form.getByRole('button', { name: settlementMessages.en.confirm, exact: true });
    await expect(button).toBeVisible();
    if (change === 'amount') f.changeAmount();
    else f.setMode('automatic');
    await button.click();
    await expect(form.getByText(settlementMessages.en.changed, { exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(0);
  });
}
for (const mode of [undefined, 'unavailable', 'future-policy']) {
  test(`unknown authoring mode ${mode} never promises automatic settlement or offers an action`, async ({
    page,
  }) => {
    const f = await fixture(page, 'en', { mode });
    await page.goto(path);
    const form = page.getByTestId('owner-authoring-settlement');
    await expect(form.getByText(settlementMessages.en.unavailable, { exact: true })).toBeVisible();
    await expect(form.getByRole('button')).toHaveCount(0);
    await expect(form.getByText(settlementMessages.en.automatic, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(form.getByRole('button')).toHaveCount(0);
    expect(f.writes).toHaveLength(0);
  });
}
test('legacy storage failure blocks the charge, while automatic polling does not need storage', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('dreamwalk:authoring-settlement:'))
        throw new Error('fixture storage denied');
      return setItem.call(this, key, value);
    };
  });
  const f = await fixture(page, 'en', { mode: 'legacy_confirmation' });
  await page.goto(path);
  const form = page.getByTestId('owner-authoring-settlement');
  await form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }).click();
  await expect(form.getByText(settlementMessages.en.storage, { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(0);
  f.setMode('automatic');
  await page.reload();
  await expect(form.getByText(settlementMessages.en.automatic, { exact: true })).toBeVisible();
  await expect(form.getByRole('button')).toHaveCount(0);
  expect(f.writes).toHaveLength(0);
});
test('owner switch during the confirmation re-read discards the old action', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const f = await fixture(page, 'en', { mode: 'legacy_confirmation' });
  await page.goto(path);
  const form = page.getByTestId('owner-authoring-settlement');
  await expect(
    form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }),
  ).toBeVisible();
  f.blockRead();
  await form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }).click();
  await expect.poll(f.blockedReads).toBeGreaterThan(0);
  const nextOwner = f.switchOwner();
  await page.evaluate((user) => {
    window.dispatchEvent(new CustomEvent('dreamwalk:account-updated', { detail: user }));
  }, nextOwner);
  // Wait for the keyed replacement controller's GET before returning the old
  // valid quote. This proves disposal, rather than racing the React owner update.
  await expect.poll(f.blockedReads).toBeGreaterThan(1);
  expect(pageErrors).toEqual([]);
  f.releaseRead();
  await expect(form.getByText(settlementMessages.en.unavailable, { exact: true })).toBeVisible();
  await expect(form.getByRole('button')).toHaveCount(0);
  expect(f.writes).toHaveLength(0);
  expect(f.posts).toHaveLength(0);
  expect(pageErrors).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith('dreamwalk:authoring-settlement:'),
      ),
    ),
  ).toEqual([]);
});

test('wallet finds a historical authoring job independently of the latest story build', async ({
  page,
}) => {
  const f = await fixture(page, 'en', { mode: 'legacy_confirmation' });
  await page.goto('/wallet/settlements');
  await expect(page.getByTestId('wallet-settlements')).toBeVisible();
  await page.getByRole('link', { name: 'Review older operation', exact: true }).click();
  await expect(page).toHaveURL(`/wallet/settlements/authoring/${jobId}`);
  const form = page.getByTestId('owner-authoring-settlement');
  await expect(
    form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }),
  ).toBeVisible();
  expect(f.posts).toHaveLength(0);
  await form.getByRole('button', { name: settlementMessages.en.confirm, exact: true }).click();
  await expect(form.getByRole('status')).toHaveText(settlementMessages.en.complete);
  expect(f.posts).toHaveLength(1);
});
