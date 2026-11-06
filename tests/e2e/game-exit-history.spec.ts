import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  createUnpaidFixtureCampaign,
  setUnpaidFixtureLocale,
} from './support/unpaid-fixture-campaign';

// Synthetic local accounts and the existing unpaid template fixture only.
// Navigation itself must never create a campaign or accept an invitation.
async function register(page: Page) {
  const handle = `history_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'History QA',
      password: `History-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  expect((await setUnpaidFixtureLocale(page.request, 'ru')).ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  return handle;
}
async function campaign(page: Page) {
  const response = await createUnpaidFixtureCampaign(page.request);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).campaignId as string;
}
function writes(page: Page) {
  const calls: { path: string; body: unknown }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      /^\/api\/v1\/game\/campaigns(?:\/[^/]+\/accept)?$/.test(path)
    )
      calls.push({ path, body: request.postDataJSON() });
  });
  return calls;
}
async function catalog(page: Page) {
  await expect(page).toHaveURL(/\/explore(?:\?.*)?$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Открыть миры', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая кампания', exact: true })).toHaveCount(0);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('exit goes to catalog and Library resumes the same save, preserving all saves across history and refresh', async ({
  page,
}) => {
  test.setTimeout(150000);
  await register(page);
  const id = await campaign(page);
  const otherId = await campaign(page);
  const calls = writes(page);
  await page.goto(`/game/${id}`);
  await expect(page.getByTestId('game-room')).toBeVisible();
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  const beforeResponse = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
  expect(beforeResponse.ok()).toBeTruthy();
  const before = (await beforeResponse.json()).projection;
  await page.locator('#game-toolbar .game-return[href="/explore"]').click();
  await catalog(page);
  await expect(page.getByTestId('game-room')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/game/${id}$`));
  await expect(page.getByTestId('game-room')).toBeVisible();
  await page.goForward();
  await catalog(page);
  await page.reload();
  await catalog(page);
  await page.locator('#main-sidebar a[href="/library"]').click();
  await page.getByRole('button', { name: /^Прохождения/ }).click();
  await expect(page).toHaveURL(/\/library\?tab=history$/);
  const history = page.getByTestId('campaign-history');
  for (const savedId of [id, otherId]) {
    const save = history.locator(`[data-campaign-id="${savedId}"]`);
    await expect(save).toBeVisible();
    await expect(save.getByRole('link', { name: 'Продолжить приключение' })).toHaveAttribute(
      'href',
      `/game/${savedId}`,
    );
  }
  await page.reload();
  await expect(history).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  await expect(history).toHaveCount(0);
  await page.goForward();
  await expect(history).toBeVisible();
  await history.locator(`[data-campaign-id="${id}"]`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/game/${id}$`));
  await expect(page.getByTestId('game-room')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('game-room')).toBeVisible();
  const afterResponse = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
  expect(afterResponse.ok()).toBeTruthy();
  const after = (await afterResponse.json()).projection;
  expect(after.actorId).toBe(before.actorId);
  expect(after.inventory).toEqual(before.inventory);
  expect(calls).toEqual([]);
});

test('legacy game bookmarks replace into the public catalog and preserve hero intent without writes', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  const calls = writes(page);
  await page.goto('/home');
  await page.goto('/game?heroId=hero-one');
  await catalog(page);
  await expect(page).toHaveURL(/\/explore\?heroId=hero-one$/);
  await page.reload();
  await expect(page).toHaveURL(/\/explore\?heroId=hero-one$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/explore\?heroId=hero-one$/);
  await page.goto('/game');
  await catalog(page);
  expect(calls).toEqual([]);
});

for (const state of ['loading', 'error'] as const) {
  test(`unloaded ${state} game and shell fallback exit directly to catalog`, async ({ page }) => {
    await register(page);
    const id = randomUUID();
    const held = deferred();
    const calls = writes(page);
    await page.routeWebSocket('**/api/v1/game/socket**', (socket) => socket.close({ code: 4403 }));
    await page.route(`**/api/v1/game/campaigns/${id}/snapshot`, async (route) => {
      if (state === 'loading') await held.promise;
      await route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } }).catch(() => {});
    });
    try {
      await page.goto(`/game/${id}`);
      const contentExit = page.locator('#main-content .game-return');
      await expect(contentExit).toHaveAttribute('href', '/explore');
      if (state === 'error')
        await expect(page.locator('#main-content').getByRole('alert')).toBeVisible();
      await expect(page.locator('#game-toolbar .game-return')).toHaveAttribute('href', '/explore');
      await contentExit.click();
      await catalog(page);
      held.resolve();
      expect(calls).toEqual([]);
    } finally {
      held.resolve();
    }
  });
}

test('Library campaign invitation keeps hero choice and explicit acceptance, including retry and duplicate clicks', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  await register(page);
  const id = await campaign(page);
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const guest = await guestContext.newPage();
    const handle = await register(guest);
    expect(
      (
        await page.request.post(`/api/v1/game/campaigns/${id}/invitations`, {
          data: { username: handle },
        })
      ).ok(),
    ).toBeTruthy();
    const heroResponse = await guest.request.post('/api/v1/heroes', {
      data: { name: 'History hero', backstory: '', notes: '', traits: [] },
    });
    expect(heroResponse.ok()).toBeTruthy();
    const heroId = (await heroResponse.json()).id as string;
    const calls = writes(guest);
    await guest.goto(`/library?tab=history&heroId=${heroId}`);
    const accept = guest.getByRole('button', {
      name: 'Принять приглашение в кампанию',
      exact: true,
    });
    await expect(guest.getByLabel('Герой для этого прохождения', { exact: true })).toHaveValue(
      heroId,
    );
    await guest.reload();
    await expect(accept).toBeVisible();
    expect(calls).toEqual([]);
    let fail = true;
    const held = deferred();
    await guest.route(`**/api/v1/game/campaigns/${id}/accept`, async (route) => {
      if (fail) return route.fulfill({ status: 403, json: { code: 'SOURCE_ACCESS_REQUIRED' } });
      await held.promise;
      await route.continue();
    });
    await accept.click();
    await expect(guest.getByTestId('campaign-history').getByRole('alert')).toBeVisible();
    expect(calls).toHaveLength(1);
    fail = false;
    try {
      await accept.click({ clickCount: 2 });
      await expect.poll(() => calls.length).toBe(2);
      await expect(accept).toBeDisabled();
      held.resolve();
      await expect(guest).toHaveURL(new RegExp(`/game/${id}$`));
      await expect(guest.getByTestId('game-room')).toBeVisible();
      expect(calls).toEqual([
        { path: `/api/v1/game/campaigns/${id}/accept`, body: { heroId } },
        { path: `/api/v1/game/campaigns/${id}/accept`, body: { heroId } },
      ]);
      const pinned = await guest.request.get(`/api/v1/game/campaigns/${id}/hero`);
      expect(pinned.ok()).toBeTruthy();
      expect(JSON.stringify(await pinned.json())).toContain('History hero');
    } finally {
      held.resolve();
    }
  } finally {
    await guestContext.close();
  }
});

test('leaving the Library history tab fences a late acceptance response', async ({ page }) => {
  await register(page);
  const id = randomUUID();
  await page.route('**/api/v1/game/campaigns', (route) =>
    route.fulfill({
      json: { campaigns: [{ id, membership: 'pending', title: 'Pending fixture' }] },
    }),
  );
  const held = deferred();
  const calls = writes(page);
  await page.route(`**/api/v1/game/campaigns/${id}/accept`, async (route) => {
    await held.promise;
    await route.fulfill({ json: {} });
  });
  try {
    await page.goto('/library?tab=history');
    await page.getByRole('button', { name: 'Принять приглашение в кампанию', exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    await page.getByRole('button', { name: /^Избранные миры/ }).click();
    await expect(page).toHaveURL(/\/library\?tab=favorites$/);
    const response = page.waitForResponse((result) => result.url().endsWith(`/${id}/accept`));
    held.resolve();
    await response;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page).toHaveURL(/\/library\?tab=favorites$/);
    expect(calls).toHaveLength(1);
    await page.goBack();
    await expect(page.getByTestId('campaign-history')).toBeVisible();
    expect(calls).toHaveLength(1);
  } finally {
    held.resolve();
  }
});

for (const width of [390, 1536]) {
  test(`late private-world invitation response cannot leave the newer catalog route (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await register(page);
    const id = randomUUID();
    await page.route('**/api/v1/invitations', (route) =>
      route.fulfill({
        json: [
          {
            id,
            status: 'pending',
            adventureTitle: 'Private invitation fixture',
            adventureSlug: 'private-invitation-fixture',
            owner: { name: 'Fixture owner' },
            createdAt: '2026-11-06T00:00:00Z',
          },
        ],
      }),
    );
    const held = deferred();
    let requests = 0;
    await page.route(`**/api/v1/invitations/${id}/respond`, async (route) => {
      requests++;
      await held.promise;
      await route.fulfill({ json: { ok: true } });
    });
    try {
      await page.goto('/library?tab=invitations');
      await page.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
      await expect.poll(() => requests).toBe(1);
      const navigation = width === 390 ? '.bottom-nav' : '#main-sidebar';
      await page.locator(`${navigation} a[href="/explore"]`).click();
      await catalog(page);
      const response = page.waitForResponse((result) => result.url().endsWith(`/${id}/respond`));
      held.resolve();
      await (await response).finished();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      await catalog(page);
      await expect(page.getByRole('status').filter({ hasText: 'Приглашение принято' })).toHaveCount(
        0,
      );
      expect(requests).toBe(1);
    } finally {
      held.resolve();
    }
  });
}
