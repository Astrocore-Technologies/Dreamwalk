import { test, expect, type Page } from '@playwright/test';
import { defaultDirectorCatalog } from '../../packages/contracts/src/director-style';

const storyPath = '/adventures/design-story';
const ownerId = '11111111-1111-4111-8111-111111111111';
const heroId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const artId = '44444444-4444-4444-8444-444444444444';
function story() {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    slug: 'design-story',
    title: 'An authored observatory',
    synopsis: 'A reader-visible opening about distant stars and an unfinished expedition.',
    sourceLanguage: 'en',
    sourceRevision: 1,
    author: { handle: 'design_author', name: 'Design author' },
    visibility: 'public',
    status: 'published',
    access: 'public',
    playableVersionId: versionId,
    cover: 'observatory',
    coverAssetId: artId,
    genre: 'fantasy',
    difficulty: 'normal',
    playersMin: 1,
    playersMax: 4,
    tags: [],
    favoriteCount: 7,
    likeCount: 5,
    totalRounds: 12,
    likedByMe: false,
    version: 1,
    updatedAt: '2026-11-03T00:00:00Z',
    npcs: ['Elia', 'Kai', 'Mira'].map((name, index) => ({
      id: `npc-${index}`,
      name,
      role: 'Expedition member',
      description: 'An authored public description.',
      greeting: 'Welcome, traveler.',
      portraitAssetId: index < 2 ? artId : null,
    })),
  };
}
async function fixture(
  page: Page,
  options: {
    guest?: boolean;
    locale?: string;
    theme?: string;
    private?: boolean;
    empty?: boolean;
  } = {},
) {
  const data = story();
  if (options.private) {
    data.visibility = 'private';
    data.access = 'invited';
  }
  if (options.empty) {
    data.npcs = [];
    data.playableVersionId = '';
  }
  const state = {
    readsFail: false,
    delay: 0,
    heroFail: false,
    posts: [] as string[],
    reportFails: false,
    releaseReport: null as null | (() => void),
    reportBodies: [] as unknown[],
  };
  const locale = options.locale || 'en';
  const theme = options.theme || 'dark';
  await page.addInitScript(
    ({ locale, theme }) => {
      localStorage.setItem('dreamwalk-language', locale);
      localStorage.setItem('dreamwalk-theme', theme);
    },
    { locale, theme },
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    if (req.method() !== 'GET') state.posts.push(path);
    if (path === '/auth/me')
      return route.fulfill({
        json: {
          user: options.guest
            ? null
            : {
                id: ownerId,
                handle: 'design_reader',
                name: 'Design reader',
                role: 'user',
                onboarded: true,
                settings: { language: locale, theme },
              },
        },
      });
    if (path === '/adventures/design-story') {
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      return state.readsFail
        ? route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } })
        : route.fulfill({ json: data });
    }
    if (path === `/assets/${artId}/file`)
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#423052"/><circle cx="850" cy="180" r="130" fill="#b696c5"/><path d="M0 600L300 220L650 600Z" fill="#765288"/></svg>',
      });
    if (path === '/heroes')
      return state.heroFail
        ? route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } })
        : route.fulfill({
            json: options.empty
              ? []
              : [
                  {
                    id: heroId,
                    name: 'Saved reader hero',
                    portraitAssetId: artId,
                    traits: ['Curious'],
                    notes: 'PRIVATE_HERO_NOTE',
                    backstory: 'PRIVATE_HERO_BACKSTORY',
                  },
                ],
          });
    if (path === '/game/directors') return route.fulfill({ json: defaultDirectorCatalog() });
    if (path.endsWith('/playable-versions'))
      return route.fulfill({
        json: {
          versions: [{ id: versionId, audience: 'private', approved: true, sourceRevision: 1 }],
        },
      });
    if (path === '/library') return route.fulfill({ json: { favorites: [] } });
    if (path === '/sparks/wallet' || path === '/dreams/wallet')
      return route.fulfill({
        json: {
          ownerId,
          enabled: true,
          subunitsPerSpark: '10000',
          ledger: [],
          availableSubunits: '2480000',
          heldSubunits: '0',
          balanceSubunits: '2480000',
        },
      });
    if (path === '/reports') {
      state.reportBodies.push(req.postDataJSON());
      await new Promise<void>((resolve) => {
        state.releaseReport = resolve;
      });
      return state.reportFails
        ? route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } })
        : route.fulfill({ json: {} });
    }
    if (path === '/game/start-preparations') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } });
    }
    return route.fulfill({ json: [] });
  });
  return { data, state };
}
async function readyImage(page: Page) {
  await expect(page.getByTestId('story-detail')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.querySelectorAll('.story-detail-page img')).map((img) =>
        (img as HTMLImageElement).decode(),
      ),
    );
  });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const locale of ['ru', 'en', 'uk']) {
  test(`story detail reference composition ${locale}: authored data, themes and responsive widths`, async ({
    page,
  }, info) => {
    await fixture(page, { locale });
    for (const width of [1536, 1165, 390]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const theme of ['dark', 'light']) {
        await page.goto(storyPath);
        await readyImage(page);
        await expect(
          page.getByLabel(
            locale === 'en'
              ? 'Hero for this campaign'
              : locale === 'ru'
                ? 'Герой для этого прохождения'
                : 'Герой для цього проходження',
          ),
        ).toBeVisible();
        await page.evaluate((theme) => {
          localStorage.setItem('dreamwalk-theme', theme);
          document.documentElement.dataset.theme = theme;
        }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('.sd-npc-preview')).toHaveCount(3);
        await expect(page.locator('.sd-npc-preview').first()).toContainText(
          'An authored public description.',
        );
        await expect(page.locator('.sd-npc-preview').last().locator('img')).toHaveCount(0);
        await expect(page.locator('.sd-story-poster img')).toHaveAttribute(
          'src',
          `/api/v1/assets/${artId}/file`,
        );
        await noOverflow(page);
        if (width === 1536) {
          const banner = await page.locator('.sd-story-poster').boundingBox();
          const intro = await page.locator('.sd-story-intro').boundingBox();
          const actions = await page.locator('.sd-story-actions').boundingBox();
          const body = await page.locator('.sd-story-body').boundingBox();
          expect(banner!.width / banner!.height).toBeCloseTo(4.4, 1);
          expect(actions!.x).toBeGreaterThan(intro!.x + intro!.width);
          expect(body!.x).toBe(intro!.x);
          expect(body!.y).toBeLessThan(actions!.y + actions!.height);
        }
        await info.attach(`story-detail-${locale}-${theme}-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      }
    }
  });
}
test('story detail selection, report cancellation and duplicate start preserve safe controls', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto(storyPath + `?heroId=${heroId}`);
  await readyImage(page);
  await expect(page.getByLabel('Hero for this campaign')).toHaveValue(heroId);
  await expect(page.locator('.sd-story-about')).not.toHaveAttribute('open', '');
  await page.locator('.sd-story-about summary').click();
  await expect(page.locator('.sd-story-about .prose')).toBeVisible();
  const report = page.getByRole('button', { name: 'Report content', exact: true });
  await report.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(report).toBeFocused();
  await report.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(report).toBeFocused();
  await report.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(report).toBeFocused();
  expect(state.posts).toEqual([]);
  await page.getByRole('button', { name: 'Start campaign', exact: true }).click({ clickCount: 2 });
  await expect(page.locator('.sd-prepare-panel').getByRole('alert')).toBeVisible();
  expect(state.posts.filter((path) => path === '/game/start-preparations')).toHaveLength(1);
  expect(state.posts.some((path) => path.endsWith('/dispatch') || path === '/game/campaigns')).toBe(
    false,
  );
  await expect(page).toHaveURL(new RegExp(storyPath));
});
test('story detail guest launch redirects with return path and browser back never starts', async ({
  page,
}) => {
  const { state } = await fixture(page, { guest: true });
  await page.goto(storyPath);
  await page.getByRole('button', { name: 'Start campaign', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/auth/sign-in' && url.searchParams.get('returnTo') === storyPath,
  );
  await page.goBack();
  await expect(page.getByTestId('story-detail')).toBeVisible();
  expect(state.posts).toEqual([]);
});
test('story detail loading, safe retry, empty authored data and invited access remain honest', async ({
  page,
}, info) => {
  const { state } = await fixture(page, { private: true, empty: true });
  state.readsFail = true;
  state.delay = 500;
  await page.goto(storyPath);
  await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
  await expect(page.locator('#main-content').getByRole('alert')).toBeVisible();
  state.readsFail = false;
  state.delay = 0;
  await page
    .locator('#main-content')
    .getByRole('alert')
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await readyImage(page);
  await expect(page.locator('.sd-npc-preview')).toHaveCount(0);
  await expect(page.locator('.sd-story-versions')).toHaveCount(0);
  await expect(page.locator('.private-access-note')).toBeVisible();
  await expect(page.locator('.sd-back-link')).toHaveAttribute('href', '/library?tab=shared');
  await expect(page.getByRole('button', { name: 'Start campaign', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Hero for this campaign')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Add to my library', exact: true })).toHaveCount(0);
  expect(state.posts).toEqual([]);
  await noOverflow(page);
  await info.attach('story-detail-invited-empty', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('story detail preserves long authored text and selected-hero loading errors without starting', async ({
  page,
}) => {
  const { data, state } = await fixture(page);
  data.title = 'A very long authored title '.repeat(8);
  data.synopsis = 'Authored opening with meaningful details. '.repeat(20);
  state.heroFail = true;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(storyPath + `?heroId=${heroId}`);
  await readyImage(page);
  await expect(page.getByTestId('hero-selection').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start campaign', exact: true })).toBeDisabled();
  await noOverflow(page);
  state.heroFail = false;
  await page
    .getByTestId('hero-selection')
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await expect(page.getByLabel('Hero for this campaign')).toHaveValue(heroId);
  await expect(page.getByRole('button', { name: 'Start campaign', exact: true })).toBeEnabled();
  await page.goto(storyPath + '?heroId=unavailable-hero');
  await expect(page.getByTestId('hero-selection').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start campaign', exact: true })).toBeDisabled();
  await page.getByLabel('Hero for this campaign').selectOption('');
  await expect(page.getByRole('button', { name: 'Start campaign', exact: true })).toBeEnabled();
  expect(state.posts).toEqual([]);
});

for (const fails of [false, true]) {
  test(`story report pending dismissal and duplicate submission remain safe (${fails ? 'failure' : 'success'})`, async ({
    page,
  }) => {
    const { data, state } = await fixture(page);
    state.reportFails = fails;
    await page.goto(storyPath);
    await readyImage(page);
    const trigger = page.getByRole('button', { name: 'Report content', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').fill('Please review this public story.');
    await dialog.locator('form').evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await expect.poll(() => state.releaseReport !== null).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(dialog.locator('textarea')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(state.posts).toEqual(['/reports']);
    expect(state.reportBodies).toEqual([
      { adventureId: data.id, reason: 'Please review this public story.' },
    ]);
    state.releaseReport!();
    if (fails) {
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.locator('textarea')).toHaveValue('Please review this public story.');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(state.posts).toEqual(['/reports']);
    await expect(page).toHaveURL(new RegExp(storyPath));
  });
}
test('expanded owned hero cards only select and close, restore focus and keep launch identity', async ({
  page,
}, info) => {
  const { state } = await fixture(page);
  await page.goto(storyPath);
  await readyImage(page);
  const open = page.getByRole('button', { name: 'Choose a hero', exact: true });
  // A DOM identity marker would disappear if launch or its selectors were remounted.
  await page
    .getByTestId('director-selection')
    .evaluate((el) => el.setAttribute('data-mount-proof', 'original'));
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Choose a hero' });
  await expect(dialog).toBeVisible();
  const hero = dialog.getByRole('radio', { name: /Saved reader hero/ });
  await expect(dialog.locator(`label img[src="/api/v1/assets/${artId}/file"]`)).toBeVisible();
  await expect(dialog).toContainText(
    'A reader-visible opening about distant stars and an unfinished expedition.',
  );
  await expect(dialog).toContainText('Solo / with friends (1–4)');
  await expect(dialog).not.toContainText('PRIVATE_HERO_NOTE');
  await expect(dialog).not.toContainText('PRIVATE_HERO_BACKSTORY');
  await hero.focus();
  await page.keyboard.press('Space');
  await expect(hero).toBeChecked();
  await expect(dialog.getByRole('link', { name: /Prepare a hero/ })).toHaveAttribute(
    'href',
    `/my-characters?returnTo=${encodeURIComponent(storyPath + '?heroId=' + heroId)}`,
  );
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Done choosing hero', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await expect(page.getByLabel('Hero for this campaign')).toHaveValue(heroId);
  await expect(page.getByTestId('director-selection')).toHaveAttribute(
    'data-mount-proof',
    'original',
  );
  await open.click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await open.click();
  await dialog.getByRole('button', { name: 'Close hero selection', exact: true }).click();
  await expect(open).toBeFocused();
  await expect(page).toHaveURL(new RegExp(storyPath + '$'));
  expect(state.posts).toEqual([]);
  await open.click();
  await noOverflow(page);
  await info.attach('owned-hero-choice', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('hero cards preserve unavailable choice, empty traveler and error retry without starting', async ({
  page,
}) => {
  const { state } = await fixture(page, { empty: true });
  await page.goto(storyPath + '?heroId=unavailable-hero');
  await page.getByRole('button', { name: 'Choose a hero', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a hero' });
  await expect(dialog).toContainText('You have no saved heroes yet.');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done choosing hero' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Traveler without a saved hero' }).check();
  await expect(dialog.getByRole('button', { name: 'Done choosing hero' })).toBeEnabled();
  await page.keyboard.press('Escape');
  state.heroFail = true;
  await page.reload();
  await page.getByRole('button', { name: 'Choose a hero', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).not.toContainText('You have no saved heroes yet.');
  state.heroFail = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog).toContainText('You have no saved heroes yet.');
  expect(state.posts).toEqual([]);
});

test('hero picker loading and restored pinned preparations keep all choices disabled', async ({
  page,
}) => {
  const { state } = await fixture(page);
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/heroes', async (route) => {
    await loading;
    await route.fulfill({ json: [] });
  });
  await page.goto(storyPath);
  await page.getByRole('button', { name: 'Choose a hero', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a hero' });
  try {
    await expect(dialog.getByRole('status')).toHaveText('Loading heroes…');
    await expect(dialog.getByRole('radio')).toBeDisabled();
    await expect(dialog.getByRole('link', { name: /Prepare a hero/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Done choosing hero' })).toBeDisabled();
  } finally {
    release();
  }
  await expect(dialog.getByRole('radio')).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.evaluate(
    ({ ownerId, versionId }) => {
      const base = `dreamwalk-start:${ownerId}:${versionId}:`;
      sessionStorage.setItem(base + ':director', 'coauthor');
      sessionStorage.setItem(base + ':coauthor:prepare', 'owned-operation');
    },
    { ownerId, versionId },
  );
  await page.route('**/api/v1/game/start-preparations/by-operation/owned-operation', (route) =>
    route.fulfill({
      json: { id: 'restored', status: 'ready', campaignId: 'ready-campaign', jobs: [] },
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Choose a hero', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Hero for this campaign')).toBeDisabled();
  await expect(page.getByTestId('director-selection')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(storyPath + '$'));
  expect(state.posts).toEqual([]);
});

test('closing a picker locked by selection restoration focuses its enabled local group', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.addInitScript(
    ({ ownerId, versionId, heroId }) => {
      const base = `dreamwalk-start:${ownerId}:${versionId}:${heroId}`;
      sessionStorage.setItem(base + ':director', 'coauthor');
      sessionStorage.setItem(base + ':coauthor:prepare', 'hero-owned-operation');
    },
    { ownerId, versionId, heroId },
  );
  await page.route('**/api/v1/game/start-preparations/by-operation/hero-owned-operation', (route) =>
    route.fulfill({
      json: { id: 'hero-restored', status: 'ready', campaignId: 'hero-ready-campaign', jobs: [] },
    }),
  );
  await page.goto(storyPath);
  const open = page.getByRole('button', { name: 'Choose a hero', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Choose a hero' });
  const hero = dialog.getByRole('radio', { name: /Saved reader hero/ });
  await hero.check();
  await expect(hero).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'Traveler without a saved hero' })).toBeDisabled();
  await expect(dialog.getByRole('link', { name: /Prepare a hero/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Done choosing hero' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close hero selection', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeDisabled();
  await expect(page.getByTestId('hero-selection')).toBeFocused();
  await expect(page.getByTestId('director-selection')).toBeVisible();
  await expect(page.getByLabel('Hero for this campaign')).toHaveValue(heroId);
  await expect(page).toHaveURL(new RegExp(storyPath + '$'));
  expect(state.posts).toEqual([]);
});
