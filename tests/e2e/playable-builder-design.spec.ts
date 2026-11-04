import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import { settingsSchema } from '../../packages/contracts/src/index';

// Fully intercepted synthetic responses. No account, provider or production mutation.
async function fixture(page: Page, locale = 'en', theme = 'dark') {
  const draft = createAuthoredDraft('courtyard');
  draft.title = 'Synthetic prepared world';
  draft.maps[0].label = 'Synthetic courtyard';
  draft.maps[0].labelTranslations = {
    ru: 'Синтетический двор',
    uk: 'Синтетичне подвір’я',
    en: 'Synthetic courtyard',
  };
  draft.npcs[0].label = 'Synthetic keeper';
  draft.npcs[0].publicProfile = {
    role: 'Synthetic guide',
    description: 'Synthetic public description',
    appearance: 'Synthetic public appearance',
  };
  const build = {
    id: 'synthetic-build',
    status: 'proposed',
    sourceHash: 'synthetic-source',
    sourceCurrent: true,
    draft: draft as typeof draft | null,
    jobs: [{ id: 'synthetic-job', status: 'committed', error_code: '' }],
  };
  const control = {
    build: build as typeof build | null,
    fail: false,
    holdLatest: false,
    latestStarted: false,
    holdApply: false,
    release: () => {},
    requests: [] as { path: string; body: Record<string, unknown> }[],
  };
  const user = {
    id: 'synthetic-author',
    name: 'Synthetic author',
    handle: 'synthetic_author',
    role: 'user',
    onboarded: true,
    settings: settingsSchema.parse({ language: locale, theme }),
  };
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
    if (path === '/auth/me') return route.fulfill({ json: { user } });
    if (path === '/taxonomy')
      return route.fulfill({ json: { revision: 1, genres: [], genreDefinitions: [], tags: [] } });
    if (path === '/notifications') return route.fulfill({ json: [] });
    if (path === '/generation/status')
      return route.fulfill({ json: { sessionId: 'synthetic-authorization' } });
    if (path.startsWith('/story-builds/')) {
      if (req.method() !== 'GET') {
        const body = req.postDataJSON();
        control.requests.push({ path, body });
        if (path.endsWith('/prepare')) {
          control.build = { ...build, status: 'prepared', draft: null, jobs: [] };
          return route.fulfill({ json: { id: build.id } });
        }
        if (path.endsWith('/quote'))
          return route.fulfill({
            json: {
              id: 'synthetic-quote',
              reserveMicros: 5000,
              estimatedTotalMicros: 3000,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              imageInputCount: 0,
              schematicMapCount: 2,
            },
          });
        if (path.endsWith('/dispatch')) {
          control.build = {
            ...build,
            status: 'dispatched',
            draft: null,
            jobs: [{ id: 'synthetic-job', status: 'unknown', error_code: '' }],
          };
          return route.fulfill({ json: {} });
        }
        if (path.endsWith('/apply')) {
          if (control.holdApply)
            await new Promise<void>((resolve) => {
              control.release = resolve;
            });
          control.build = { ...build, status: 'applied' };
          return route.fulfill({ json: {} });
        }
      }
      if (control.fail)
        return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
      if (path.endsWith('/latest')) control.latestStarted = true;
      if (path.endsWith('/latest') && control.holdLatest)
        await new Promise<void>((resolve) => {
          control.release = resolve;
        });
      return route.fulfill({ json: control.build });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return { control, build };
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.getByTestId('story-playable-builder').getByRole('group').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-rendered-players="1"]')).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
for (const locale of ['ru', 'uk', 'en']) {
  for (const variant of [
    { width: 1536, height: 1024, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    ...(locale === 'ru' ? [{ width: 800, height: 1024, theme: 'dark' }] : []),
  ]) {
    test(`playable builder review ${locale} ${variant.width} ${variant.theme}`, async ({
      page,
    }, info) => {
      const { control } = await fixture(page, locale, variant.theme);
      await page.setViewportSize(variant);
      await page.goto('/studio/gameplay/synthetic-story');
      const root = page.getByTestId('story-playable-builder');
      await expect(root.locator('ol > li')).toHaveCount(5);
      await expect(root.locator('ol > li').nth(3)).toHaveAttribute('aria-current', 'step');
      await expect(root.locator('aside ul')).toHaveCount(3);
      for (const item of await root.locator('ol > li').all()) {
        expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      await expect(root.locator('aside')).toContainText('Synthetic keeper');
      await expect(root.locator('aside')).toContainText('Synthetic guide');
      await expect(root.locator('aside')).not.toContainText('Synthetic public description');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('data-theme', variant.theme);
      const consent = root.getByRole('checkbox');
      const apply = root.locator('button').last();
      await expect(consent).not.toBeChecked();
      await expect(apply).toBeDisabled();
      await consent.focus();
      await page.keyboard.press('Space');
      await expect(consent).toBeChecked();
      await expect(apply).toBeEnabled();
      await page.keyboard.press('Space');
      await expect(apply).toBeDisabled();
      expect(control.requests).toEqual([]);
      await capture(page, info, `builder-${locale}-${variant.width}-${variant.theme}`);
      const back = root.locator('a[href="/studio/adventures/synthetic-story"]');
      await expect(back).toHaveCount(1);
      await expect(root).not.toContainText('[Translation missing]');
    });
  }
}

test('builder keeps loading, retry, empty, stale and uncertain generation separate from consent', async ({
  page,
}, info) => {
  const { control, build } = await fixture(page);
  control.holdLatest = true;
  await page.goto('/studio/gameplay/synthetic-story');
  const root = page.getByTestId('story-playable-builder');
  await expect(root.getByRole('status')).toContainText('Restoring build status');
  await expect(root.getByRole('button', { name: 'Prepare plan', exact: true })).toBeDisabled();
  await expect.poll(() => control.latestStarted).toBe(true);
  control.holdLatest = false;
  control.release();
  await expect(root.getByRole('checkbox')).toBeVisible();
  await root.getByRole('checkbox').check();
  control.build = { ...build, sourceCurrent: false };
  await root.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(root.getByRole('alert')).toContainText('The story changed');
  await expect(root.getByRole('checkbox')).not.toBeChecked();
  await expect(root.getByRole('checkbox')).toBeDisabled();
  await expect(root.getByRole('button', { name: 'Apply to story', exact: true })).toBeDisabled();
  expect(control.requests).toEqual([]);

  control.fail = true;
  await page.reload();
  await expect(root.getByRole('alert')).toBeVisible();
  await expect(root.getByRole('button', { name: 'Prepare plan', exact: true })).toBeDisabled();
  control.fail = false;
  control.build = null;
  await root.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(root.getByRole('button', { name: 'Prepare plan', exact: true })).toBeEnabled();
  await expect(root.locator('aside')).toHaveCount(0);
  await root.getByRole('button', { name: 'Prepare plan', exact: true }).click();
  await expect(root.getByRole('button', { name: 'Quote AI plan', exact: true })).toBeEnabled();
  expect(control.requests).toHaveLength(1);
  await root.getByRole('button', { name: 'Quote AI plan', exact: true }).click();
  await expect(
    root.getByRole('button', { name: 'Generate plan at the quoted cost', exact: true }),
  ).toBeEnabled();
  await expect(root).toContainText('Provider reserve on confirmation');
  expect(control.requests.map((request) => request.path)).toEqual([
    '/story-builds/adventures/synthetic-story/prepare',
    '/story-builds/synthetic-build/quote',
  ]);
  await root.getByRole('button', { name: 'Generate plan at the quoted cost', exact: true }).click();
  await expect(root.getByRole('status').filter({ hasText: 'Do not regenerate' })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Prepare plan', exact: true })).toHaveCount(0);
  await expect(root.getByRole('button', { name: 'Apply to story', exact: true })).toHaveCount(0);
  expect(control.requests.at(-1)?.body).toMatchObject({
    quoteId: 'synthetic-quote',
    consent: true,
  });
  await page.reload();
  await expect(root.getByRole('status').filter({ hasText: 'Do not regenerate' })).toBeVisible();
  expect(control.requests).toHaveLength(3);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath('builder-unresolved.png'), fullPage: true });
});

test('builder apply remains explicit, source-bound and locked during repeated actions', async ({
  page,
}, info) => {
  const { control } = await fixture(page);
  await page.goto('/studio/gameplay/synthetic-story');
  const root = page.getByTestId('story-playable-builder');
  const apply = root.getByRole('button', { name: 'Apply to story', exact: true });
  await expect(apply).toBeDisabled();
  await root.getByRole('checkbox').check();
  control.holdApply = true;
  await apply.click();
  await expect.poll(() => control.requests.length).toBe(1);
  await expect(apply).toBeDisabled();
  await expect(root.getByRole('checkbox')).toBeDisabled();
  await apply.evaluate((button: HTMLButtonElement) => button.click());
  await page.keyboard.press('Enter');
  expect(control.requests).toHaveLength(1);
  expect(control.requests[0].body).toMatchObject({
    sourceHash: 'synthetic-source',
    reviewed: true,
    imageReuseConsent: true,
  });
  expect(control.requests[0].body.operationId).toEqual(expect.any(String));
  control.release();
  await expect(root.getByRole('status').filter({ hasText: 'not published yet' })).toBeVisible();
  await expect(root.getByRole('checkbox')).toHaveCount(0);
  await expect(root.locator('ol > li').nth(4)).toHaveAttribute('aria-current', 'step');
  await capture(page, info, 'builder-applied');
  await page.reload();
  await expect(root.getByRole('status').filter({ hasText: 'not published yet' })).toBeVisible();
  expect(control.requests).toHaveLength(1);
});
