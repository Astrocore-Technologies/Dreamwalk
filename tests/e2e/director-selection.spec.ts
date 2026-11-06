import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  DIRECTOR_STYLE_PRESETS,
  type DirectorCatalog,
  type CampaignDirectorSelection,
} from '../../packages/contracts/src/director-style';
import {
  createUnpaidFixtureCampaign,
  setUnpaidFixtureLocale,
} from './support/unpaid-fixture-campaign';

const storyPath = '/adventures/old-observatory';
const catalog = (): DirectorCatalog => ({
  revision: 7,
  defaultProfileId: 'coauthor',
  profiles: [
    {
      id: 'coauthor',
      name: 'Balanced guide',
      description: 'An open-ended, balanced story.',
      enabled: true,
      ...DIRECTOR_STYLE_PRESETS.coauthor,
    },
    {
      id: 'storyteller',
      name: 'Patient storyteller',
      description: 'Patient atmospheric storytelling.',
      enabled: true,
      ...DIRECTOR_STYLE_PRESETS.storyteller,
    },
  ],
});
const labels = {
  ru: {
    choose: 'Ведущий для этого прохождения',
    start: 'Начать прохождение',
    create: 'Новая кампания',
    director: 'ИИ-ведущий',
    change: 'Сменить ведущего',
    readonly: 'Ведущего меняет владелец прохождения',
  },
  en: {
    choose: 'Director for this campaign',
    start: 'Start campaign',
    create: 'New campaign',
    director: 'AI director',
    change: 'Change director',
    readonly: 'Only the campaign owner can change the director',
  },
  uk: {
    choose: 'Ведучий для цього проходження',
    start: 'Почати проходження',
    create: 'Нова кампанія',
    director: 'ШІ-ведучий',
    change: 'Змінити ведучого',
    readonly: 'Ведучого змінює власник проходження',
  },
} as const;
type Locale = keyof typeof labels;

// Only unpaid local fixture bootstrap reaches the server. All catalog changes,
// start preparation, quotes and dispatches below are browser-only protocol fixtures.
async function register(page: Page, locale: Locale = 'ru') {
  const handle = `select_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const credentials = { email: `${handle}@example.test`, password: `Select-${randomUUID()}!` };
  const response = await page.request.post('/api/v1/auth/register', {
    data: { handle, name: 'Director selection QA', ...credentials },
  });
  expect(response.status()).toBe(201);
  expect((await setUnpaidFixtureLocale(page.request, locale)).ok()).toBeTruthy();
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  return credentials;
}
async function campaign(page: Page) {
  const response = await createUnpaidFixtureCampaign(page.request);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).campaignId as string;
}
async function publicCatalog(page: Page, read = catalog) {
  await page.route('**/api/v1/game/directors', (route) => route.fulfill({ json: read() }));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function launchFixture(
  page: Page,
  campaignId: string,
  mode: 'ready' | 'queued' | 'unknown' = 'ready',
) {
  const preparationId = randomUUID();
  const calls = {
    prepare: [] as Record<string, unknown>[],
    create: [] as Record<string, unknown>[],
    dispatch: [] as Record<string, unknown>[],
    quotes: 0,
    restores: 0,
  };
  const control = {
    ready: mode === 'ready',
    profileId: '',
    holdPrepare: null as Promise<void> | null,
    holdDispatch: null as Promise<void> | null,
  };
  const state = () => ({
    id: preparationId,
    status: control.ready ? 'ready' : 'prepared',
    reused: false,
    campaignId: null,
    directorProfileId: control.profileId,
    jobs: !control.ready && calls.dispatch.length ? [{ status: mode }] : [],
  });
  await page.route('**/api/v1/game/start-preparations**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/quote')) {
      calls.quotes++;
      return route.fulfill({
        json: {
          id: randomUUID(),
          estimatedTotalMicros: 1000,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          sparks: {
            reserveSubunits: '10000',
            rateVersion: 'api-cent-2-sparks-v2',
            walletCharging: true,
          },
        },
      });
    }
    if (path.endsWith('/dispatch')) {
      const body = request.postDataJSON();
      expect(body.consent).toBe(true);
      calls.dispatch.push(body);
      if (control.holdDispatch) await control.holdDispatch;
      return route.fulfill({ json: state() });
    }
    if (path.includes('/by-operation/')) calls.restores++;
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      calls.prepare.push(body);
      control.profileId = body.directorProfileId;
      if (control.holdPrepare) await control.holdPrepare;
    }
    return route.fulfill({ json: state() });
  });
  await page.route('**/api/v1/game/campaigns', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    calls.create.push(route.request().postDataJSON());
    return route.fulfill({ json: { campaignId } });
  });
  return { calls, control, preparationId };
}

for (const locale of ['ru', 'en', 'uk'] as const) {
  for (const surface of ['story'] as const) {
    test(`selected director reaches ${surface} creation once (${locale})`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120000);
      await register(page, locale);
      const id = await campaign(page);
      await publicCatalog(page);
      const fixture = await launchFixture(page, id);
      const text = labels[locale];
      await page.goto(surface === 'story' ? storyPath : '/game');
      const select = page.getByRole('combobox', { name: text.choose, exact: true });
      await expect(select).toHaveValue('coauthor');
      await expect(select.locator('option')).toHaveCount(2);
      await select.selectOption('storyteller');
      await expect(page.getByTestId('director-selection')).toContainText(
        'Patient atmospheric storytelling.',
      );
      await page.reload();
      await expect(select).toHaveValue('storyteller');
      expect(fixture.calls.prepare).toHaveLength(0);
      expect(fixture.calls.create).toHaveLength(0);
      if (locale === 'uk') {
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath(`director-${surface}-mobile.png`),
          fullPage: true,
        });
      }
      const held = deferred();
      if (surface === 'story') fixture.control.holdPrepare = held.promise;
      try {
        await page
          .getByRole('button', {
            name: surface === 'story' ? text.start : text.create,
            exact: true,
          })
          .click({ clickCount: 2 });
        if (surface === 'story') {
          await expect.poll(() => fixture.calls.prepare.length).toBe(1);
          await expect(select).toBeDisabled();
          expect(fixture.calls.prepare[0].directorProfileId).toBe('storyteller');
          held.resolve();
        }
        await expect(page).toHaveURL(new RegExp(`/game/${id}$`));
        expect(fixture.calls.create).toHaveLength(1);
        expect(fixture.calls.create[0].directorProfileId).toBe('storyteller');
        if (surface === 'story')
          expect(fixture.calls.create[0].startPreparationId).toBe(fixture.preparationId);
        else {
          expect(fixture.calls.prepare).toHaveLength(0);
          expect(fixture.calls.create[0].template).toBe('observatory-v1');
        }
        expect(fixture.calls.dispatch).toHaveLength(0);
      } finally {
        held.resolve();
      }
    });
  }

  test(`campaign owner changes director; reload and read-only membership retain it (${locale})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    if (locale === 'en') await page.clock.install();
    await register(page, locale);
    const id = await campaign(page);
    await publicCatalog(page);
    let saved: CampaignDirectorSelection = {
      profileId: 'coauthor',
      revision: 1,
      profile: catalog().profiles[0],
      canChange: true,
    };
    const changes: Record<string, unknown>[] = [];
    let directorReads = 0;
    let holdDirectorReads: Promise<void> | null = null;
    let generationRequests = 0;
    await page.route('**/api/v1/game/start-preparations**', (route) => {
      generationRequests++;
      return route.abort();
    });
    await page.route(`**/api/v1/game/campaigns/${id}/director`, async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        expect(body).toEqual({ profileId: 'storyteller', expectedRevision: saved.revision });
        changes.push(body);
        saved = {
          ...saved,
          revision: saved.revision + 1,
          profileId: 'storyteller',
          profile: catalog().profiles[1],
        };
      } else {
        directorReads++;
        if (holdDirectorReads) await holdDirectorReads;
      }
      return route.fulfill({ json: saved });
    });
    const text = labels[locale];
    await page.goto(`/game/${id}`);
    const director = page.getByTestId('campaign-director');
    await expect(director.locator(':scope > summary')).toContainText(
      `${text.director} · Balanced guide`,
    );
    await director.locator(':scope > summary').click();
    const select = director.getByRole('combobox', { name: text.choose, exact: true });
    await expect(select).toBeEnabled();
    await expect(director.getByRole('button', { name: text.change, exact: true })).toBeDisabled();
    await select.selectOption('storyteller');
    const change = director.getByRole('button', { name: text.change, exact: true });
    if (locale === 'en') {
      // Reselecting the saved value resumes polling without saving anything.
      await select.selectOption('coauthor');
      const readsBeforeCancel = directorReads;
      // Cross one polling interval without replaying every game-animation frame.
      await page.clock.fastForward(5100);
      await expect.poll(() => directorReads).toBeGreaterThan(readsBeforeCancel);
      await expect(select).toBeEnabled();
      await select.selectOption('storyteller');
      await expect(change).toBeEnabled();
      const readsBeforeSave = directorReads;
      const held = deferred();
      holdDirectorReads = held.promise;
      try {
        const box = await change.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        // Both automatic refresh paths must leave an unsaved owner's click intact.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.clock.fastForward(5100);
        await expect(change).toBeEnabled();
        expect(directorReads).toBe(readsBeforeSave);
        await page.mouse.up();
      } finally {
        holdDirectorReads = null;
        held.resolve();
        await page.mouse.up();
      }
    } else {
      await change.click();
    }
    await expect(director.locator(':scope > summary')).toContainText('Patient storyteller');
    expect(changes).toHaveLength(1);
    if (locale === 'en') {
      const readsAfterSave = directorReads;
      await page.clock.fastForward(5100);
      await expect.poll(() => directorReads).toBeGreaterThan(readsAfterSave);
    }
    await page.reload();
    await expect(director.locator(':scope > summary')).toContainText('Patient storyteller');
    await director.locator(':scope > summary').click();
    await expect(select).toHaveValue('storyteller');
    await expect(director).toContainText('Patient atmospheric storytelling.');

    // The API's membership capability controls the presentation; real role enforcement
    // is covered separately by integration tests, not inferred from this fixture.
    saved = { ...saved, canChange: false };
    await page.reload();
    await expect(director.locator(':scope > summary')).toContainText('Patient storyteller');
    await director.locator(':scope > summary').click();
    await expect(director.getByText(text.readonly, { exact: true })).toBeVisible();
    await expect(director.getByRole('combobox')).toHaveCount(0);
    await expect(director.getByRole('button', { name: text.change, exact: true })).toHaveCount(0);
    if (locale === 'en') {
      const memberReads = directorReads;
      await page.clock.fastForward(5100);
      await expect.poll(() => directorReads).toBeGreaterThan(memberReads);
    }
    expect(changes).toHaveLength(1);
    expect(generationRequests).toBe(0);
    if (locale === 'en') {
      await page.setViewportSize({ width: 390, height: 844 });
      await director.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('campaign-director-readonly-mobile.png') });
    }
  });
}

test('guest director choice survives sign-in and a hero-selection detour without starting', async ({
  page,
}) => {
  test.setTimeout(120000);
  const credentials = await register(page);
  expect(
    (
      await page.request.post('/api/v1/account/onboarding', {
        data: { name: 'Director selection QA', genres: [], purpose: 'both', profilePublic: false },
      })
    ).ok(),
  ).toBeTruthy();
  const heroResponse = await page.request.post('/api/v1/heroes', {
    data: { name: 'Selection hero', backstory: 'Synthetic story', notes: '', traits: [] },
  });
  expect(heroResponse.ok()).toBeTruthy();
  const heroId = (await heroResponse.json()).id;
  const id = await campaign(page);
  expect((await page.request.post('/api/v1/auth/logout', { data: {} })).ok()).toBeTruthy();
  await publicCatalog(page);
  const fixture = await launchFixture(page, id);
  await page.goto(storyPath);
  const select = page.getByRole('combobox', { name: labels.ru.choose, exact: true });
  await select.selectOption('storyteller');
  await page.getByRole('button', { name: labels.ru.start, exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/auth/sign-in' && url.searchParams.get('returnTo') === storyPath,
  );
  await page.getByLabel(/^(Email|Электронная почта|Електронна пошта)$/).fill(credentials.email);
  await page.getByLabel('Пароль', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${storyPath}$`));
  await expect(select).toHaveValue('storyteller');
  expect(fixture.calls.prepare).toHaveLength(0);
  expect(fixture.calls.create).toHaveLength(0);
  await page.getByRole('link', { name: 'Подготовить героя', exact: true }).click();
  await page.getByRole('link', { name: 'Играть этим героем', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === storyPath && url.searchParams.get('heroId') === heroId,
  );
  await expect(select).toHaveValue('storyteller');
  await page.getByRole('button', { name: labels.ru.start, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/game/${id}$`));
  expect(fixture.calls.prepare).toHaveLength(1);
  expect(fixture.calls.prepare[0]).toMatchObject({ directorProfileId: 'storyteller', heroId });
  expect(fixture.calls.create[0]).toMatchObject({ directorProfileId: 'storyteller', heroId });
});

for (const surface of ['story'] as const) {
  test(`catalog errors block ${surface} starts until a successful retry`, async ({ page }) => {
    test.setTimeout(120000);
    await register(page);
    let fail = true;
    const calls: string[] = [];
    await page.route('**/api/v1/game/directors', (route) =>
      route.fulfill(fail ? { status: 503, json: { code: 'INTERNAL_ERROR' } } : { json: catalog() }),
    );
    await page.route('**/api/v1/game/start-preparations**', (route) => {
      calls.push(route.request().url());
      return route.abort();
    });
    await page.route('**/api/v1/game/campaigns', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { campaigns: [] } });
      calls.push(route.request().url());
      return route.abort();
    });
    await page.goto(surface === 'story' ? storyPath : '/game');
    const selection = page.getByTestId('director-selection');
    await expect(selection.getByRole('alert')).toBeVisible();
    const start = page.getByRole('button', {
      name: surface === 'story' ? labels.ru.start : labels.ru.create,
      exact: true,
    });
    await expect(start).toBeDisabled();
    expect(calls).toEqual([]);
    fail = false;
    await selection.getByRole('alert').getByRole('button').click();
    await expect(selection.getByRole('combobox')).toHaveValue('coauthor');
    await expect(start).toBeEnabled();
    expect(calls).toEqual([]);
  });
}

for (const outcome of ['queued', 'unknown'] as const) {
  test(`pending ${outcome} paid preparation pins its director through reload and archive`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await register(page);
    const id = await campaign(page);
    let visible = catalog();
    await publicCatalog(page, () => visible);
    const fixture = await launchFixture(page, id, outcome);
    const dispatch = deferred();
    fixture.control.holdDispatch = dispatch.promise;
    try {
      await page.goto(storyPath);
      const select = page.getByRole('combobox', { name: labels.ru.choose, exact: true });
      await select.selectOption('storyteller');
      await page.getByRole('button', { name: labels.ru.start, exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Even before dispatch, this preparation already owns its selected profile.
      await expect(select).toBeDisabled();
      await expect(select).toHaveValue('storyteller');
      await page.getByRole('button', { name: labels.ru.start, exact: true }).click();
      await page
        .getByRole('button', { name: 'Подтвердить и начать', exact: true })
        .click({ clickCount: 2 });
      await expect.poll(() => fixture.calls.dispatch.length).toBe(1);
      await expect(select).toBeDisabled();
      await expect(select).toHaveValue('storyteller');
      expect(fixture.calls.create).toHaveLength(0);
      dispatch.resolve();
      await expect(
        page.getByRole('status').filter({
          hasText:
            outcome === 'queued'
              ? 'Готовим игру. Она откроется автоматически.'
              : 'Результат запроса пока неизвестен',
        }),
      ).toBeVisible();
      const prepares = fixture.calls.prepare.length;
      const quotes = fixture.calls.quotes;
      // Administrators can archive a profile while a paid operation is pending.
      // Existing operation restoration must not silently switch to the new default.
      visible = { ...visible, revision: visible.revision + 1, profiles: [visible.profiles[0]] };
      await page.reload();
      await expect.poll(() => fixture.calls.restores).toBeGreaterThan(0);
      await expect(select).toBeDisabled();
      await expect(select).toHaveValue('storyteller');
      await expect(
        page.getByRole('status').filter({
          hasText: outcome === 'queued' ? 'Подготовка игры' : 'Результат запроса пока неизвестен',
        }),
      ).toBeVisible();
      expect(fixture.calls.prepare).toHaveLength(prepares);
      expect(fixture.calls.quotes).toBe(quotes);
      expect(fixture.calls.dispatch).toHaveLength(1);
      expect(fixture.calls.create).toHaveLength(0);
      fixture.control.ready = true;
      if (outcome === 'unknown')
        await page.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Открыть игру', exact: true })).toBeVisible();
      expect(fixture.calls.create).toHaveLength(0);
      await page.getByRole('button', { name: 'Открыть игру', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/game/${id}$`));
      expect(fixture.calls.create).toHaveLength(1);
      expect(fixture.calls.create[0]).toMatchObject({
        directorProfileId: 'storyteller',
        startPreparationId: fixture.preparationId,
      });
      expect(fixture.calls.dispatch).toHaveLength(1);
      expect(fixture.calls.prepare.every((body) => body.directorProfileId === 'storyteller')).toBe(
        true,
      );
    } finally {
      dispatch.resolve();
    }
  });
}

test('archived campaign director stays visible and stale owner changes require the refreshed revision', async ({
  page,
}) => {
  test.setTimeout(120000);
  await register(page, 'en');
  const id = await campaign(page);
  await publicCatalog(page);
  let saved: CampaignDirectorSelection = {
    profileId: 'archived',
    revision: 4,
    profile: {
      ...catalog().profiles[1],
      id: 'archived',
      name: 'Retired storyteller',
      enabled: false,
    },
    canChange: true,
  };
  const changes: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/game/campaigns/${id}/director`, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      changes.push(body);
      if (changes.length === 1) {
        expect(body).toEqual({ profileId: 'storyteller', expectedRevision: 4 });
        saved = { ...saved, revision: 5, profileId: 'coauthor', profile: catalog().profiles[0] };
        return route.fulfill({ status: 409, json: { code: 'DIRECTOR_STYLE_STALE' } });
      }
      expect(body).toEqual({ profileId: 'storyteller', expectedRevision: 5 });
      saved = { ...saved, revision: 6, profileId: 'storyteller', profile: catalog().profiles[1] };
    }
    return route.fulfill({ json: saved });
  });
  await page.goto(`/game/${id}`);
  const director = page.getByTestId('campaign-director');
  await expect(director.locator(':scope > summary')).toContainText('Retired storyteller');
  await director.locator(':scope > summary').click();
  const select = director.getByRole('combobox', { name: labels.en.choose, exact: true });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('archived');
  await expect(select.locator('option[value="archived"]')).toHaveText(
    'Retired storyteller · Archived',
  );
  await select.selectOption('storyteller');
  const change = director.getByRole('button', { name: labels.en.change, exact: true });
  await change.click();
  await expect(director.getByRole('alert')).toContainText('The director selection changed.');
  await expect(select).toHaveValue('coauthor');
  await expect(director.locator(':scope > summary')).toContainText('Balanced guide');
  expect(changes).toHaveLength(1);
  await select.selectOption('storyteller');
  await change.click();
  await expect(director.locator(':scope > summary')).toContainText('Patient storyteller');
  await expect(director.getByRole('alert')).toHaveCount(0);
  expect(changes).toHaveLength(2);
});
