import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('new hero portrait is explicit, private, recoverable and never auto-saves or starts generation', async ({
  page,
}) => {
  const revisionId = randomUUID(),
    assetId = randomUUID(),
    ownerId = randomUUID(),
    jobId = randomUUID();
  let mutations = 0,
    selectedReads = 0;
  let failSelection = true;
  let release: (() => void) | undefined;
  let delaySelection = false;
  const revision = {
    id: revisionId,
    familyId: randomUUID(),
    revision: 1,
    owned: true,
    canReuse: true,
    width: 100,
    height: 100,
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    metadata: {
      title: 'Recovered hero portrait',
      kind: 'portrait',
      camera: 'portrait',
      style: 'drawn2D',
      tags: ['hero-portrait'],
    },
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (route.request().method() !== 'GET') mutations++;
    let json: unknown = {};
    if (path === '/auth/me')
      json = {
        user: {
          id: ownerId,
          role: 'user',
          name: 'Hero QA',
          handle: 'hero_qa',
          onboarded: true,
          settings: { language: 'en', theme: 'dark' },
        },
      };
    else if (path === '/heroes' || path === '/asset-library') json = [];
    else if (path === '/image-generation/config')
      json = {
        externalEnabled: false,
        mockAvailable: true,
        externalBlockReasons: ['GENERATION_DISABLED'],
      };
    else if (path === '/image-generation/hero-portraits')
      json = {
        jobs: [
          {
            id: jobId,
            status: 'admitted',
            mode: 'external',
            revisionId,
            heldMicros: 0,
            actualMicros: 0,
            canCancel: false,
          },
        ],
      };
    else if (path === `/asset-library/revisions/${revisionId}`) json = revision;
    else if (path === `/image-generation/hero-portraits/${revisionId}/asset`) {
      selectedReads++;
      if (delaySelection)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (failSelection)
        return route.fulfill({
          status: 503,
          json: { code: 'INTERNAL_ERROR', message: 'Selection temporarily unavailable' },
        });
      json = { assetId };
    } else if (path.endsWith('/file') || path.startsWith('/assets/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    return route.fulfill({ json });
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  await page.goto('/my-characters');
  await page.getByRole('button', { name: 'Create hero', exact: true }).click();
  await page.getByLabel('Hero name').fill('Aster');
  await page.getByLabel('Backstory', { exact: true }).fill('A forest wanderer');
  await page.getByLabel('Private notes').fill('NEVER_SEND_PRIVATE_NOTES');
  await page.getByRole('button', { name: 'Generate hero art', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Artwork description' });
  await expect(prompt).toHaveValue(/Aster.*forest wanderer/);
  await expect(prompt).not.toHaveValue(/NEVER_SEND_PRIVATE_NOTES/);
  expect(await page.locator('form form').count()).toBe(0);
  const use = page.getByRole('button', { name: 'Use revision', exact: true });
  await use.click();
  await expect(
    page.getByText('The service is temporarily unavailable. Please try later.'),
  ).toBeVisible();
  failSelection = false;
  await use.click();
  await expect(page.getByText('Portrait selected. Save the hero.')).toBeVisible();
  await expect(page.locator('img.upload-preview')).toHaveAttribute('src', new RegExp(assetId));
  expect(selectedReads).toBe(2);
  expect(mutations).toBe(0);
  delaySelection = true;
  await use.click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Create hero', exact: true }).click();
  release!();
  await expect(page.getByLabel('Hero name')).toHaveValue('');
  await expect(page.locator('img.upload-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate hero art', exact: true })).toBeVisible();
  expect(mutations).toBe(0);
});
