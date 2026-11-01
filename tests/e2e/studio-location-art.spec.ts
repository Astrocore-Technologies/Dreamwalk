import { test, expect, type Page } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
  'base64',
);
async function setup(page: Page, approved = false, existing = false, mapped = false) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
    locationId = randomUUID(),
    revisionId = randomUUID(),
    quoteId = randomUUID();
  expect(
    (
      await page.request.post('/api/v1/auth/register', {
        data: {
          handle: 'location_art_' + suffix,
          email: 'location_art_' + suffix + '@example.test',
          name: 'Location image QA',
          password: 'Test-' + randomUUID() + '!',
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.request.patch('/api/v1/account/settings', { data: { language: 'en' } });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const storyResponse = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Location image browser QA',
      sourceLanguage: 'en',
      content: {
        world: 'A quiet city library.',
        rules: 'Images never define collisions.',
        locations: [
          {
            id: locationId,
            name: 'Quiet library',
            description: 'A warm reading room with shelves and a large arched window.',
          },
        ],
        npcIds: [],
        scenes: [],
        startSceneId: '',
        boundaries: [],
      },
    },
  });
  expect(storyResponse.ok()).toBeTruthy();
  const story = await storyResponse.json(),
    adventureId = story.id;
  if (mapped) {
    const result = await page.request.put(
      `/api/v1/studio/adventures/${adventureId}/playable-draft`,
      {
        data: {
          expectedRevision: 0,
          draft: {
            schemaVersion: 1,
            title: 'Saved illustrated room',
            startMapId: 'room',
            maps: [
              {
                id: 'room',
                label: 'Saved room',
                sourceLocationId: locationId,
                width: 8,
                height: 8,
                blocked: [],
                spawns: [{ x: 1, y: 1 }],
                exits: [],
              },
            ],
            objects: [],
            npcs: [],
            roundPolicy: { maxRounds: 5, planningMs: 30000 },
          },
        },
      },
    );
    expect(result.ok()).toBeTruthy();
  }
  const actualConfig = await (await page.request.get('/api/v1/image-generation/config')).json();
  const config = approved
    ? {
        mockAvailable: true,
        externalEnabled: true,
        externalBlockReasons: [],
        verifiedUpperMicros: 100000,
        costStatus: 'verified_bound',
        estimatedTotalMicros: 100000,
        reserveMicros: 100000,
        requestProfile: {
          provider: 'synthetic',
          model: 'synthetic-image-model',
          size: '1024x1024',
          quality: 'low',
          outputs: 1,
        },
      }
    : actualConfig;
  const live = {
    enabled: true,
    sessionId: randomUUID(),
    state: 'active',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    stopCode: null,
    capMicros: 1000000,
    usedMicros: 0,
    heldMicros: 0,
    remainingMicros: 1000000,
    priorHeldReservations: 0,
    imagesEnabled: approved,
    imageBlockCode: approved ? undefined : 'VERIFIED_IMAGE_UPPER_BOUND_REQUIRED',
    text: {
      model: 'synthetic-text-model',
      upperMicros: 264036,
      maxOutputTokens: 2048,
      contextTokens: 1050000,
      costEvidence: 'synthetic',
    },
  };
  const revision = {
    id: revisionId,
    familyId: randomUUID(),
    revision: 1,
    sha256: 'b'.repeat(64),
    mime: 'image/png',
    width: 1024,
    height: 1024,
    metadata: {
      title: 'Library skylight illustration',
      kind: 'background',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['library'],
      variant: '',
      provenance: { source: 'generated', provider: 'synthetic' },
      rights: {
        basis: 'generated',
        licenseLabel: 'Private test output',
        attribution: 'Synthetic fixture',
        allowAuthorReuse: false,
        attested: true,
      },
    },
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    owned: true,
    canReuse: true,
  };
  const calls = { prepare: 0, quote: 0, jobs: 0, bind: 0, mapWrites: 0, unexpected: 0 };
  let quotedBody: Record<string, unknown> | null = null,
    bindBody: Record<string, unknown> | null = null,
    sourceHash = '',
    binding: null | { revisionId: string; sourceHash: string; stale: boolean; mapId?: string } =
      null,
    jobs: object[] = [];
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    await route.fulfill({ response, json: { ...body, user: { ...body.user, role: 'admin' } } });
  });
  await page.route(/\/api\/v1\/(?:generation|live-test)\//, async (route) => {
    if (
      new URL(route.request().url()).pathname.endsWith('/status') &&
      route.request().method() === 'GET'
    )
      return route.fulfill({ json: live });
    calls.unexpected++;
    await route.abort();
  });
  await page.route('**/api/v1/asset-library**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/file')) return route.fulfill({ contentType: 'image/png', body: png });
    if (path.endsWith('/' + revisionId)) return route.fulfill({ json: revision });
    if (path.endsWith('/asset-library') && route.request().method() === 'GET')
      return route.fulfill({ json: existing || jobs.length ? [revision] : [] });
    return route.continue();
  });
  await page.route('**/api/v1/image-generation/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    if (path.endsWith('/config') && method === 'GET') return route.fulfill({ json: config });
    if (path.endsWith('/studio-locations/prepare') && method === 'POST') {
      calls.prepare++;
      expect(req.postDataJSON()).toEqual({ adventureId, locationId });
      const saved = await (
          await page.request.get(`/api/v1/studio/adventures/${adventureId}`)
        ).json(),
        location = saved.content.locations.find((l: { id: string }) => l.id === locationId);
      sourceHash = createHash('sha256')
        .update(JSON.stringify([location.name, location.description, saved.editRevision]))
        .digest('hex');
      if (mapped && !binding) binding = { revisionId, sourceHash, stale: false, mapId: 'room' };
      return route.fulfill({
        json: {
          request: {
            adventureId,
            studioLocationContext: {
              locationId,
              expectedEditRevision: saved.editRevision,
              sourceHash,
            },
            prompt: `Location: ${location.name}. Description: ${location.description}`,
            title: location.name,
            kind: 'background',
            camera: 'top-down',
            tags: ['library'],
            background: 'opaque',
            referenceRevisionIds: [],
            privateReferenceAssetIds: [],
            mode: 'external',
          },
          sourceHash,
          sourceRevision: saved.editRevision,
          location: { id: locationId, name: location.name },
          binding: binding ? { ...binding, stale: binding.sourceHash !== sourceHash } : null,
          playable: {
            revision: mapped ? 1 : 0,
            artRevision: 0,
            maps: mapped ? [{ id: 'room', label: 'Saved room' }] : [],
          },
        },
      });
    }
    if (path.endsWith('/quotes') && method === 'POST') {
      expect(approved).toBe(true);
      calls.quote++;
      quotedBody = req.postDataJSON();
      expect(quotedBody!.mode).toBe('external');
      expect(quotedBody!.studioLocationContext).toMatchObject({ locationId, sourceHash });
      return route.fulfill({
        json: {
          decision: 'quote',
          matches: [],
          quote: {
            id: quoteId,
            mode: 'external',
            upperMicros: 100000,
            verifiedUpperMicros: 100000,
            reserveMicros: 100000,
            costBasis: 'verified_bound',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            rightsAttestationRequired: true,
          },
        },
      });
    }
    if (path.endsWith('/jobs') && method === 'GET') return route.fulfill({ json: { jobs } });
    if (path.endsWith('/jobs') && method === 'POST') {
      expect(approved).toBe(true);
      const body = req.postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.quoteId).toBe(quoteId);
      calls.jobs++;
      const job = {
        id: randomUUID(),
        operationId: body.operationId,
        status: 'admitted',
        mode: 'external',
        studioLocationId: locationId,
        studioSourceHash: sourceHash,
        revisionId,
        heldMicros: 0,
        actualMicros: 100000,
        createdAt: new Date().toISOString(),
        canCancel: false,
      };
      jobs = [job];
      return route.fulfill({ json: job });
    }
    if (path.endsWith('/studio-locations/bind') && method === 'POST') {
      calls.bind++;
      bindBody = req.postDataJSON();
      expect(bindBody).toMatchObject({
        adventureId,
        locationId,
        revisionId,
        expectedSourceHash: sourceHash,
      });
      expect(bindBody!.mapId).toBeUndefined();
      binding = { revisionId, sourceHash, stale: false };
      return route.fulfill({ json: binding });
    }
    calls.unexpected++;
    await route.abort();
  });
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/playable-draft')) calls.mapWrites++;
  });
  await page.goto(`/studio/adventures/${adventureId}`);
  await page.getByRole('button', { name: /Locations$/ }).click();
  return {
    calls,
    config,
    locationId,
    adventureId,
    get quotedBody() {
      return quotedBody;
    },
    get bindBody() {
      return bindBody;
    },
  };
}
test('Studio Locations visibly shows the real-image control, model and plain blocker before any geometry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const mock = await setup(page);
  const control = page.locator(`[data-location-art="${mock.locationId}"]`);
  await expect(control.getByRole('button', { name: 'Generate image', exact: true })).toBeVisible();
  await expect(control.getByRole('button', { name: 'Generate image', exact: true })).toBeDisabled();
  await expect(control).toContainText(mock.config.requestProfile.model);
  await expect(control).toContainText('Owner budget approval is required.');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await control.screenshot({
    path: test.info().outputPath('actual-config-location-image-control-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await control.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('actual-config-location-image-control-mobile.png'),
    fullPage: false,
  });
  await control.getByRole('button', { name: 'Budget and library settings', exact: true }).click();
  const dialog = page.getByTestId('location-image-dialog');
  await expect(
    dialog.getByRole('textbox', { name: 'Saved generation description', exact: true }),
  ).toHaveValue(/warm reading room/);
  await expect(dialog.getByLabel('Artwork description', { exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await expect(
    dialog.getByRole('option', { name: 'Fixture without API', exact: true }),
  ).toHaveCount(0);
  expect(mock.calls.quote).toBe(0);
  expect(mock.calls.jobs).toBe(0);
  expect(mock.calls.mapWrites).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('synthetic canonical location image requires quote consent and separate free binding without a playable map', async ({
  page,
}) => {
  const mock = await setup(page, true);
  await page
    .getByRole('textbox', { name: 'Location description', exact: true })
    .fill('Updated saved skylight description for this location.');
  await page
    .locator(`[data-location-art="${mock.locationId}"]`)
    .getByRole('button', { name: 'Budget and library settings', exact: true })
    .click();
  const dialog = page.getByTestId('location-image-dialog'),
    generation = dialog.getByRole('region', { name: 'Image preparation', exact: true });
  await expect(generation.getByLabel('Artwork description', { exact: true })).toHaveValue(
    /Updated saved skylight/,
  );
  await generation.getByLabel('License or terms name', { exact: true }).fill('Private test output');
  await generation
    .getByLabel('I confirm rights to this request and the selected owned references.', {
      exact: true,
    })
    .check();
  await generation
    .getByRole('button', { name: 'Check library and prepare quote', exact: true })
    .click();
  const run = generation.getByRole('button', { name: 'Run one test', exact: true });
  await expect(run).toBeDisabled();
  expect(mock.calls.jobs).toBe(0);
  await generation
    .getByLabel('I confirm one test run at this quote. Regeneration is never automatic.', {
      exact: true,
    })
    .check();
  await run.click();
  const selected = dialog.getByTestId('location-image-selection');
  await expect(selected).toBeVisible({ timeout: 15000 });
  const bind = selected.getByRole('button', { name: 'Save image for location', exact: true });
  await expect(bind).toBeDisabled();
  expect(mock.calls.bind).toBe(0);
  await selected
    .getByLabel(
      'I reviewed this image against the saved location description and want to use this revision.',
      { exact: true },
    )
    .check();
  await bind.click();
  await expect(dialog.getByRole('heading', { name: 'Saved image', exact: true })).toBeVisible();
  expect(mock.calls.jobs).toBe(1);
  expect(mock.calls.bind).toBe(1);
  expect(mock.calls.mapWrites).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('a permitted library image can be stored and recovered for a location without geometry or generation', async ({
  page,
}) => {
  const mock = await setup(page, false, true);
  const control = () => page.locator(`[data-location-art="${mock.locationId}"]`);
  await control().getByRole('button', { name: 'Budget and library settings', exact: true }).click();
  const dialog = page.getByTestId('location-image-dialog');
  await dialog
    .getByRole('button', { name: 'Choose an existing image for free', exact: true })
    .click();
  await dialog
    .getByRole('region', { name: 'Art library', exact: true })
    .getByRole('button', { name: 'Use revision', exact: true })
    .click();
  const selected = dialog.getByTestId('location-image-selection');
  await expect(
    selected.getByRole('combobox', { name: 'Image attachment', exact: true }),
  ).toHaveValue('');
  await expect(selected).toContainText('There is no linked saved map yet.');
  await selected
    .getByLabel(
      'I reviewed this image against the saved location description and want to use this revision.',
      { exact: true },
    )
    .check();
  await selected.getByRole('button', { name: 'Save image for location', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Saved image', exact: true })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await dialog.screenshot({
    path: test.info().outputPath('synthetic-location-image-without-geometry.png'),
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /Locations$/ }).click();
  await control().getByRole('button', { name: 'Budget and library settings', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Saved image', exact: true })).toBeVisible();
  expect(mock.calls.quote).toBe(0);
  expect(mock.calls.jobs).toBe(0);
  expect(mock.calls.bind).toBe(1);
  expect(mock.calls.mapWrites).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('a previously map-bound illustration still saves separately while the playable draft is dirty', async ({
  page,
}) => {
  const mock = await setup(page, false, true, true);
  // Empty map label is an invalid local draft, so autosave must preserve it in memory.
  // The image operation must neither flush that draft nor attach its stale map choice.
  await page.getByRole('textbox', { name: 'Map name', exact: true }).fill('');
  await page.getByRole('combobox', { name: 'Map tool', exact: true }).selectOption('wall');
  await page.getByRole('button', { name: 'Tile 0, 0: Floor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tile 0, 0: Wall', exact: true })).toBeVisible();
  await page
    .locator(`[data-location-art="${mock.locationId}"]`)
    .getByRole('button', { name: 'Budget and library settings', exact: true })
    .click();
  const dialog = page.getByTestId('location-image-dialog');
  await dialog.getByRole('button', { name: 'Use the saved revision', exact: true }).click();
  const selected = dialog.getByTestId('location-image-selection');
  const attachment = selected.getByRole('combobox', { name: 'Image attachment', exact: true });
  await expect(attachment).toHaveValue('');
  await expect(attachment).toBeDisabled();
  await expect(selected).toContainText('the illustration can still be saved separately.');
  await selected
    .getByLabel(
      'I reviewed this image against the saved location description and want to use this revision.',
      { exact: true },
    )
    .check();
  const save = selected.getByRole('button', { name: 'Save image for location', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    dialog.getByText('The image was saved for this location.', { exact: true }),
  ).toBeVisible();
  expect(mock.bindBody).not.toHaveProperty('mapId');
  expect(mock.bindBody).not.toHaveProperty('expectedPlayableRevision');
  expect(mock.bindBody).not.toHaveProperty('expectedArtRevision');
  expect(mock.calls.bind).toBe(1);
  expect(mock.calls.quote).toBe(0);
  expect(mock.calls.jobs).toBe(0);
  expect(mock.calls.mapWrites).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Map name', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Tile 0, 0: Wall', exact: true })).toBeVisible();
  await page
    .locator(`[data-location-art="${mock.locationId}"]`)
    .getByRole('button', { name: 'Budget and library settings', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Use the saved revision', exact: true }).click();
  await expect(attachment).toHaveValue('');
  await expect(attachment).toBeDisabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Map name', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Tile 0, 0: Wall', exact: true })).toBeVisible();
});
