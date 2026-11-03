import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('story cover quotes once, cancels freely, recovers and selects without nested forms', async ({
  page,
}, testInfo) => {
  const ownerId = randomUUID(),
    revisionId = randomUUID(),
    assetId = randomUUID(),
    jobId = randomUUID();
  let quotes = 0,
    dispatches = 0,
    coverReads = 0;
  let pending = true;
  let recovered = false,
    selectionFails = true;
  let selectionRelease: (() => void) | undefined;
  let delaySelection = false;
  const revision = {
    id: revisionId,
    familyId: randomUUID(),
    revision: 1,
    owned: true,
    canReuse: true,
    width: 1536,
    height: 1024,
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    metadata: {
      title: 'Recovered story cover',
      kind: 'background',
      camera: 'unrestricted',
      style: 'drawn2D',
      tags: ['story-cover'],
    },
  };
  const job = {
    id: jobId,
    status: 'admitted',
    mode: 'external',
    revisionId,
    heldMicros: 100000,
    actualMicros: 100000,
    canCancel: false,
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let json: unknown = {};
    if (path === '/auth/me')
      json = {
        user: {
          id: ownerId,
          role: 'user',
          name: 'Cover QA',
          handle: 'cover_qa',
          onboarded: true,
          settings: { language: 'en', theme: 'dark' },
        },
      };
    else if (['/genres', '/tags', '/asset-library', '/assets'].includes(path)) json = [];
    else if (path === '/image-generation/config')
      json = {
        externalEnabled: true,
        mockAvailable: true,
        verifiedUpperMicros: 100000,
        externalBlockReasons: [],
      };
    else if (path === '/generation/status')
      json = {
        enabled: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
        state: 'active',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        remainingMicros: 1000000,
        imagesEnabled: true,
      };
    else if (path === '/image-generation/story-covers')
      json = { jobs: recovered ? [{ ...job, status: pending ? 'dispatched' : 'admitted' }] : [] };
    else if (path === '/image-generation/quotes') {
      quotes++;
      const request = route.request().postDataJSON();
      expect(request.storyCoverContext.draftId).toBeTruthy();
      expect(request.adventureId).toBeUndefined();
      expect(request.rights.allowAuthorReuse).toBe(false);
      expect(request.prompt).toContain('Floating castle');
      expect(request.prompt).not.toContain('Default art:');
      expect(request.kind).toBe('background');
      expect(request.camera).toBe('unrestricted');
      json = {
        decision: 'quote',
        matches: [],
        quote: {
          id: randomUUID(),
          mode: 'external',
          upperMicros: 100000,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          rightsAttestationRequired: true,
          sparks: {
            quoteId: randomUUID(),
            reserveSubunits: '100000',
            rateVersion: 'test',
            walletCharging: true,
          },
        },
      };
    } else if (path === '/image-generation/jobs' && route.request().method() === 'POST') {
      dispatches++;
      expect(route.request().postDataJSON().consent).toBe(true);
      recovered = true;
      json = { ...job, status: pending ? 'dispatched' : 'admitted' };
    } else if (path === `/asset-library/revisions/${revisionId}`) json = revision;
    else if (path === `/image-generation/story-covers/${revisionId}/asset`) {
      coverReads++;
      if (delaySelection)
        await new Promise<void>((resolve) => {
          selectionRelease = resolve;
        });
      if (selectionFails) return route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR' } });
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
  await page.goto('/studio/adventures/new');
  await page.getByRole('button', { name: 'Generate AI cover', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate AI cover' });
  await expect(page.locator('form form')).toHaveCount(0);
  await expect(dialog.getByText('Advanced settings', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Artwork description' })).not.toHaveValue(
    /Default art:/,
  );
  await dialog
    .getByRole('textbox', { name: 'Artwork description' })
    .fill('Floating castle above a quiet sea');
  await dialog.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Confirm and generate', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('[data-image-quote-price]')).toContainText('10.0000 Sparks');
  await expect(dialog.locator('[data-image-quote-price]')).toHaveCount(1);
  await expect(dialog.locator('[data-spark-quote-price], [data-request-reserve]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('image-single-estimate.png') });
  expect(dispatches).toBe(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(dispatches).toBe(0);
  await dialog.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm and generate', exact: true }).dblclick();
  const progress = dialog.locator('[data-generation-progress="dispatched"]');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('aria-busy', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(progress.locator('[aria-hidden="true"]')).toHaveCSS('animation-name', 'none');
  pending = false;
  await expect(dialog.getByRole('button', { name: 'Use revision', exact: true })).toBeVisible();
  await expect(progress).toHaveCount(0);
  expect(dispatches).toBe(1);
  expect(quotes).toBe(2);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByAltText('Selected image')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Generate AI cover', exact: true }).click();
  const use = dialog.getByRole('button', { name: 'Use revision', exact: true });
  await use.click();
  await expect(
    dialog.getByText('The service is temporarily unavailable. Please try later.'),
  ).toBeVisible();
  selectionFails = false;
  delaySelection = true;
  await use.click();
  await expect.poll(() => !!selectionRelease).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  selectionRelease!();
  await expect(page.getByAltText('Selected image')).toHaveCount(0);
  delaySelection = false;
  await page.getByRole('button', { name: 'Generate AI cover', exact: true }).click();
  await use.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByAltText('Selected image')).toHaveAttribute('src', new RegExp(assetId));
  expect(coverReads).toBe(3);
  expect(dispatches).toBe(1);
  await expect(page.getByText('Upload cover', { exact: true })).toBeVisible();
});
