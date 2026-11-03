import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ArtRevision } from '../../apps/web/components/assets/types';

function fixture(title: string, owned = true): ArtRevision {
  const id = randomUUID();
  return {
    id,
    familyId: randomUUID(),
    revision: 1,
    sha256: 'a'.repeat(64),
    mime: 'image/webp',
    width: 1536,
    height: 1024,
    url: `/api/v1/asset-library/revisions/${id}/file`,
    owned,
    canReuse: true,
    metadata: {
      title,
      kind: 'background',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['synthetic', 'observatory'],
      variant: 'default',
      provenance: { source: 'upload' },
      rights: {
        basis: 'owned',
        licenseLabel: 'Synthetic QA fixture only',
        attribution: 'Synthetic QA author',
        allowAuthorReuse: true,
        attested: true,
      },
    },
  };
}
async function mockLibrary(page: Page, initial: ArtRevision[]) {
  let revisions = [...initial];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let failAdmission = false;
  let holdSearch = false;
  let releaseSearch: (() => void) | undefined;
  const uploadId = randomUUID();
  const user = {
    id: randomUUID(),
    role: 'user',
    name: 'Synthetic art QA',
    handle: 'synthetic_art_qa',
    onboarded: true,
    settings: { language: 'en', theme: 'dark' },
  };
  await page.route('**/api/v1/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const method = route.request().method();
    if (endpoint.endsWith('/file'))
      return route.fulfill({
        path: path.resolve('apps/web/public/images/observatory.webp'),
        contentType: 'image/webp',
      });
    let json: unknown = {};
    if (endpoint === '/auth/me') json = { user };
    else if (endpoint === '/account/settings' && method === 'PATCH') {
      Object.assign(user.settings, route.request().postDataJSON());
      json = user;
    } else if (endpoint === '/asset-library') json = revisions;
    else if (endpoint.endsWith('/grants')) json = [];
    else if (endpoint === '/assets' && method === 'POST')
      json = {
        id: uploadId,
        url: `/api/v1/assets/${uploadId}/file`,
        width: 1536,
        height: 1024,
        mime: 'image/webp',
        createdAt: new Date().toISOString(),
      };
    else if (endpoint === '/asset-library/revisions' && method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ path: endpoint, body });
      if (failAdmission) {
        failAdmission = false;
        return route.fulfill({
          status: 503,
          json: { code: 'INTERNAL_ERROR', message: 'Synthetic retry required' },
        });
      }
      const admitted = {
        ...fixture(body.metadata.title),
        metadata: body.metadata,
        ...(body.familyId
          ? { familyId: body.familyId, revision: body.expectedFamilyRevision + 1 }
          : {}),
      };
      revisions = [admitted, ...revisions];
      json = admitted;
    } else if (endpoint === '/asset-library/search' && method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ path: endpoint, body });
      json = revisions.filter((art) => art.metadata.kind === body.kind);
      if (holdSearch)
        await new Promise<void>((resolve) => {
          releaseSearch = resolve;
        });
    } else if (endpoint === '/notifications') json = [];
    else if (method !== 'GET') writes.push({ path: endpoint, body: {} });
    return route.fulfill({ json });
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  return {
    writes,
    holdNextSearch: () => {
      holdSearch = true;
    },
    releaseSearch: () => {
      holdSearch = false;
      releaseSearch?.();
    },
    failNextAdmission: () => {
      failAdmission = true;
    },
  };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const dialog of await page.getByRole('dialog').all())
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
}
async function screenshot(page: Page, file: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images, async (image) => {
        image.loading = 'eager';
        await image.decode().catch(() => {});
      }),
    );
  });
  expect(
    await page
      .locator('[data-art-revision] img, [data-art-inspector] img, dialog img')
      .evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
  ).toBe(true);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}
// Supports the current topbar and the reviewed shared shell's mobile preferences drawer.
async function preferences(page: Page, locale: string, theme: string) {
  let opened = false;
  if (!(await page.locator('.locale-select:visible').count())) {
    await page.locator('.mobile-menu').click();
    opened = true;
  }
  if ((await page.locator('html').getAttribute('lang')) !== locale) {
    const persisted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/account/settings') && response.request().method() === 'PATCH',
    );
    await page.locator('.locale-select:visible').first().selectOption(locale);
    await persisted;
  }
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
    const persisted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/account/settings') && response.request().method() === 'PATCH',
    );
    await page.locator('.theme-button:visible').first().click();
    await persisted;
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  if (opened) await page.locator('.mobile-close:visible').click();
}

test('asset browsing shows real result art above the fold and a rights inspector across layouts', async ({
  page,
}, info) => {
  const own = fixture('Synthetic observatory at dusk');
  const shared = fixture('Synthetic shared landscape', false);
  shared.metadata.tags = ['synthetic', 'forest'];
  const { writes } = await mockLibrary(page, [own, shared, fixture('Synthetic library study')]);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/studio/assets');
  const cards = page.locator('[data-art-revision]');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toBeInViewport();
  const inspector = page.locator('[data-art-inspector]');
  await expect(inspector).toContainText(own.metadata.title);
  await expect(inspector).toContainText('Synthetic QA fixture only');
  await expect(inspector.getByRole('region', { name: 'Reuse grants' })).toHaveCount(0);
  await cards.first().getByRole('button', { name: 'Details', exact: true }).click();
  await expect(inspector.getByRole('region', { name: 'Reuse grants' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search by title or tags' }).fill('forest');
  await expect(cards).toHaveCount(1);
  await expect(inspector).toContainText(shared.metadata.title);
  await expect(inspector.getByRole('region', { name: 'Reuse grants' })).toHaveCount(0);
  await page.getByRole('searchbox').fill('no match');
  await expect(cards).toHaveCount(0);
  await expect(inspector).toContainText('Select art to see its details and rights.');
  await page.getByRole('searchbox').clear();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(cards).toHaveCount(3);
  for (const [width, height] of [
    [1536, 1024],
    [390, 900],
  ]) {
    await page.setViewportSize({ width, height });
    for (const locale of ['ru', 'uk', 'en']) {
      for (const theme of ['dark', 'light']) {
        await preferences(page, locale, theme);
        await expect(cards.first()).toBeVisible();
        await noOverflow(page);
        await screenshot(page, info.outputPath(`asset-library-${width}-${locale}-${theme}.png`));
      }
    }
  }
  await page.setViewportSize({ width: 1165, height: 900 });
  await preferences(page, 'ru', 'dark');
  await noOverflow(page);
  await screenshot(page, info.outputPath('asset-library-1165-ru-dark.png'));
  expect(writes.filter((write) => write.path.startsWith('/asset-library'))).toEqual([]);
});

test('art dialog cancels cleanly, previews upload and retains explicit rights on idempotent retry', async ({
  page,
}, info) => {
  const art = fixture('Synthetic initial art');
  const server = await mockLibrary(page, [art]);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/studio/assets');
  const add = page.getByRole('button', { name: 'Add to library', exact: true });
  await add.click();
  let dialog = page.getByRole('dialog', { name: 'Add to library', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Asset title').fill('Discarded unsaved title');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  dialog = page.getByRole('dialog', { name: 'Add to library', exact: true });
  await expect(dialog.getByLabel('Asset title')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Add to library', exact: true })).toBeDisabled();
  await dialog
    .locator('input[type=file]')
    .setInputFiles(path.resolve('apps/web/public/images/observatory.webp'));
  await expect(dialog.locator('img')).toBeVisible();
  await dialog.getByLabel('Asset title').fill('Synthetic newly registered art');
  await dialog.getByLabel('License or terms name').fill('Synthetic test permission');
  await dialog.getByLabel('I confirm I have the rights for this use.').check();
  await dialog.getByLabel('Rights basis', { exact: true }).selectOption('licensed');
  await expect(dialog.getByLabel('I confirm I have the rights for this use.')).not.toBeChecked();
  await dialog.getByLabel('I confirm I have the rights for this use.').check();
  await dialog.getByLabel('Allow issuing explicit reuse grants to other authors').check();
  await expect(dialog.getByLabel('I confirm I have the rights for this use.')).not.toBeChecked();
  await dialog.getByLabel('I confirm I have the rights for this use.').check();
  await screenshot(page, info.outputPath('register-art-desktop.png'));
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await screenshot(page, info.outputPath('register-art-mobile.png'));
  server.failNextAdmission();
  await dialog.getByRole('button', { name: 'Add to library', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic retry required');
  await dialog.getByRole('button', { name: 'Add to library', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-art-inspector]')).toContainText(
    'Synthetic newly registered art',
  );
  const admissions = server.writes.filter((write) => write.path === '/asset-library/revisions');
  expect(admissions).toHaveLength(2);
  expect(admissions[0].body.operationId).toBe(admissions[1].body.operationId);
  expect(admissions[1].body.metadata).toMatchObject({
    rights: {
      basis: 'licensed',
      licenseLabel: 'Synthetic test permission',
      attested: true,
      allowAuthorReuse: true,
    },
  });
  // A new revision remains a separate upload and attestation, not an in-place edit.
  await page
    .locator(`[data-art-revision="${art.id}"]`)
    .getByRole('button', { name: 'Create new revision', exact: true })
    .click();
  const revisionDialog = page.getByRole('dialog', { name: 'Create new revision', exact: true });
  await expect(revisionDialog.getByLabel('Asset title')).toHaveValue(art.metadata.title);
  await expect(revisionDialog.locator('img')).toHaveCount(0);
  await expect(
    revisionDialog.getByLabel('I confirm I have the rights for this use.'),
  ).not.toBeChecked();
  await revisionDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(revisionDialog).toHaveCount(0);
  expect(server.writes.filter((write) => write.path === '/asset-library/revisions')).toHaveLength(
    2,
  );
});

test('new art filters ignore a late compatibility search without admitting or generating art', async ({
  page,
}) => {
  const background = fixture('Synthetic background');
  const portrait = fixture('Synthetic portrait');
  portrait.metadata.kind = 'portrait';
  portrait.metadata.camera = 'unrestricted';
  const server = await mockLibrary(page, [background, portrait]);
  await page.goto('/studio/assets');
  await expect(page.locator('[data-art-revision]')).toHaveCount(2);
  await page.getByText('Size and compatible revision search', { exact: true }).click();
  await page.getByLabel('Asset type', { exact: true }).selectOption('background');
  await page.getByLabel('Camera', { exact: true }).selectOption('top-down');
  server.holdNextSearch();
  await page.getByRole('button', { name: 'Find matching art', exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);
  await page.getByLabel('Asset type', { exact: true }).selectOption('portrait');
  await expect(page.locator('[data-art-revision]')).toHaveCount(1);
  await expect(page.locator('[data-art-revision]')).toHaveAttribute(
    'data-art-revision',
    portrait.id,
  );
  const response = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith('/asset-library/search'),
  );
  server.releaseSearch();
  await response;
  await expect(page.locator('[data-art-revision]')).toHaveAttribute(
    'data-art-revision',
    portrait.id,
  );
  await expect(page.locator('[data-art-inspector]')).toContainText(portrait.metadata.title);
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]).toMatchObject({
    path: '/asset-library/search',
    body: { kind: 'background', camera: 'top-down', style: 'drawn2D' },
  });
});
