import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Local synthetic accounts only. No production content, provider calls or publication.
test('author dashboard and all eight editor steps retain edits and cancel safely at desktop/mobile sizes', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const capture = async (name: string) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
    });
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `studio-${suffix}@example.test`,
      handle: `studio_${suffix}`,
      name: 'Synthetic Studio author',
      password: `Studio-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  expect(
    (
      await page.request.patch('/api/v1/account/settings', {
        data: { language: 'en', theme: 'dark' },
      })
    ).ok(),
  ).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const created = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Synthetic observatory',
      synopsis: 'A synthetic visual test story.',
      visibility: 'private',
      cover: 'observatory',
    },
  });
  expect(created.ok()).toBeTruthy();
  const story = await created.json();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Synthetic observatory' })).toHaveCount(2);
  await capture('studio-desktop-dark');
  await page.locator(`a[href="/studio/adventures/${story.id}"]`).first().click();
  const nav = page.getByRole('navigation', { name: 'Adventure creation steps' });
  await expect(nav.getByRole('button')).toHaveCount(8);
  await page.getByLabel('Adventure title', { exact: true }).fill('Synthetic observatory revised');
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await nav.getByRole('button').nth(1).click();
  await page.getByLabel(/^World and atmosphere/).fill('Synthetic floating islands.');
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await capture('studio-world-desktop');
  await expect
    .poll(async () => {
      const persisted = await (
        await page.request.get(`/api/v1/studio/adventures/${story.id}`)
      ).json();
      return [persisted.title, persisted.content.world];
    })
    .toEqual(['Synthetic observatory revised', 'Synthetic floating islands.']);
  const navigationWrites: string[] = [];
  const recordWrite = (request: import('@playwright/test').Request) => {
    if (
      request.url().includes('/api/v1/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    )
      navigationWrites.push(request.url());
  };
  page.on('request', recordWrite);
  for (let step = 2; step < 8; step++) {
    const button = nav.getByRole('button').nth(step);
    await button.click();
    await expect(button).toHaveAttribute('aria-current', 'step');
  }
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await expect(nav.getByRole('button').nth(6)).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Publication', exact: true }).first().click();
  await expect(nav.getByRole('button').nth(7)).toHaveAttribute('aria-current', 'step');
  expect(navigationWrites).toEqual([]);
  page.off('request', recordWrite);
  await nav.getByRole('button').first().click();
  await page.getByLabel('Adventure title', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Back to workshop', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(page.getByLabel('Adventure title', { exact: true })).toHaveValue('');
  await page.getByLabel('Adventure title', { exact: true }).fill('Synthetic observatory revised');
  await page.getByRole('button', { name: 'My media library', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Adventure title', { exact: true })).toHaveValue(
    'Synthetic observatory revised',
  );
  await nav.getByRole('button').nth(1).click();
  await expect(page.getByLabel(/^World and atmosphere/)).toHaveValue('Synthetic floating islands.');
  const saved = await (await page.request.get(`/api/v1/studio/adventures/${story.id}`)).json();
  expect(saved.coverAssetId).toBeNull();
  expect(saved.status).toBe('draft');
  expect(saved.visibility).toBe('private');
  for (const locale of ['ru', 'uk', 'en']) {
    await page.locator('.locale-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    for (const theme of ['light', 'dark']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.locator('.theme-button').click();
      await page.setViewportSize({ width: 390, height: 844 });
      const steps = page.locator('nav').filter({ has: page.locator('[aria-current="step"]') });
      await expect(steps.getByRole('button')).toHaveCount(8);
      await steps.getByRole('button').first().click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await capture(`studio-editor-mobile-${locale}-${theme}`);
    }
  }
  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Synthetic observatory revised' })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture('studio-mobile-dark');
});
