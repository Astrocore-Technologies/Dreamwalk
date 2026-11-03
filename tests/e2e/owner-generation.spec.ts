import { test, expect, type Page } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';

// Browser-only synthetic provider results. No server credentials or paid transport.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
  'base64',
);
const budgetConsent =
  'I own this configuration. I acknowledge the combined budget, including prior reservations and unknown charges. I will approve each request separately.';
type Locale = 'uk' | 'en' | 'ru';
async function fixture(
  page: Page,
  options: {
    locale?: Locale;
    release?: boolean;
    adminPresentation?: boolean;
    maxReferenceImages?: 0 | 1 | 2;
    forbidden?: boolean;
    stalePricing?: boolean;
    claimLost?: boolean;
    outcome?: 'success' | 'unknown' | 'response-lost';
  } = {},
) {
  const locale = options.locale ?? 'en',
    handle = `owner_ui_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registration = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      email: `${handle}@example.test`,
      name: 'Synthetic owner UI',
      password: `Test-${randomUUID()}!`,
    },
  });
  expect(registration.ok()).toBeTruthy();
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user.role).not.toBe('admin');
  expect(
    (await page.request.patch('/api/v1/account/settings', { data: { language: locale } })).ok(),
  ).toBeTruthy();
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  // Presentation-only role fixture for technical admin controls. The registered server
  // account remains ordinary; this mock does not assert or grant server administrator access.
  if (options.adminPresentation !== false)
    await page.route('**/api/v1/auth/me', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      await route.fulfill({ response, json: { ...body, user: { ...body.user, role: 'admin' } } });
    });
  const authorizationId = randomUUID(),
    locationId = randomUUID(),
    revisionId = randomUUID();
  let quoteId = randomUUID();
  const story = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Synthetic owner generation',
      sourceLanguage: 'en',
      content: {
        world: 'A quiet library.',
        rules: 'Pictures are not collisions.',
        npcIds: [],
        scenes: [],
        startSceneId: '',
        boundaries: [],
        locations: [
          { id: locationId, name: 'Library', description: 'A quiet room with a large skylight.' },
        ],
      },
    },
  });
  expect(story.ok()).toBeTruthy();
  const adventureId = (await story.json()).id;
  const draft = {
    schemaVersion: 1,
    title: 'Owner illustration room',
    startMapId: 'room',
    maps: [
      {
        id: 'room',
        label: 'Library map',
        sourceLocationId: locationId,
        width: 24,
        height: 24,
        blocked: [],
        spawns: [{ x: 1, y: 1 }],
        exits: [],
      },
    ],
    objects: [],
    npcs: [],
    roundPolicy: { maxRounds: 5, planningMs: 30000 },
  };
  expect(
    (
      await page.request.put(`/api/v1/studio/adventures/${adventureId}/playable-draft`, {
        data: { expectedRevision: 0, draft },
      })
    ).ok(),
  ).toBeTruthy();
  const config = {
    generationMode: options.release ? 'release' : 'owner',
    mockAvailable: false,
    externalEnabled: true,
    externalBlockReasons: [],
    ownerEstimateEnabled: true,
    estimateRiskConsentRequired: true,
    providerEnforcesQuotedCap: false,
    costStatus: 'approved_estimate',
    costBasis: 'approved_estimate',
    verifiedUpperMicros: null,
    estimatedTotalMicros: 45880,
    reserveMicros: 100000,
    requestProfile: {
      provider: 'synthetic',
      model: 'synthetic-image-model',
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      maxReferenceImages: options.maxReferenceImages ?? 0,
    },
  };
  const configFingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const status = {
    configFingerprint,
    ...(options.release ? { policyRevision: 1, policyHash: configFingerprint } : {}),
    mode: options.release ? 'release' : 'owner',
    enabled: true,
    authorizationId: null as string | null,
    sessionId: null as string | null,
    state: options.release ? 'active' : 'unclaimed',
    expiresAt: null,
    pricingValidUntil: new Date(
      Date.now() + (options.stalePricing ? -1000 : 86400000),
    ).toISOString(),
    capMicros: options.release ? null : 1000000,
    ...(options.release
      ? { allowance: 'unlimited', textCapMicros: null, imageCapMicros: null }
      : {}),
    usedMicros: 0,
    heldMicros: 0,
    remainingMicros: 1000000,
    priorHeldReservations: 0,
    imagesEnabled: options.release === true,
    imageBlockCode: (options.release ? null : 'GENERATION_AUTHORIZATION_REQUIRED') as string | null,
    stopCode: null as string | null,
    imageConfiguration: { requestProfile: config.requestProfile },
    text: {
      model: 'synthetic-text-model',
      upperMicros: 20000,
      maxOutputTokens: 2048,
      contextTokens: 64000,
      costEvidence: 'synthetic-test',
    },
  };
  const revision = {
    id: revisionId,
    familyId: randomUUID(),
    revision: 1,
    sha256: 'b'.repeat(64),
    mime: 'image/png',
    width: 1,
    height: 1,
    metadata: {
      title: 'Synthetic owner illustration',
      kind: 'background',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['library'],
      variant: '',
      provenance: { source: 'generated', provider: 'synthetic-browser-fixture' },
      rights: {
        basis: 'generated',
        licenseLabel: 'Synthetic test output',
        attribution: 'Synthetic browser fixture',
        allowAuthorReuse: false,
        attested: true,
      },
    },
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    owned: true,
    canReuse: true,
  };
  const calls = {
    claim: 0,
    quote: 0,
    dispatch: 0,
    bind: 0,
    mapWrites: 0,
    storyDraftReads: 0,
    libraryReads: 0,
    unexpected: 0,
    unexpectedRequests: [] as string[],
    legacy: 0,
  };
  let sourceHash = '',
    binding: null | { revisionId: string; sourceHash: string; stale: boolean; mapId: string } =
      null;
  const jobs: object[] = [];
  await page.route('**/api/v1/live-test/**', async (route) => {
    calls.legacy++;
    await route.abort();
  });
  await page.route('**/api/v1/generation/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (options.forbidden)
      return route.fulfill({ status: 403, json: { code: 'GENERATION_OWNER_REQUIRED' } });
    if (path.endsWith('/status') && req.method() === 'GET') return route.fulfill({ json: status });
    if (path.endsWith('/claim') && req.method() === 'POST') {
      expect(req.postDataJSON()).toEqual({
        consent: true,
        candidateFingerprint: configFingerprint,
      });
      calls.claim++;
      status.state = 'active';
      status.authorizationId = authorizationId;
      status.sessionId = authorizationId;
      status.imagesEnabled = true;
      status.imageBlockCode = null;
      if (options.claimLost) return route.abort();
      return route.fulfill({ json: status });
    }
    calls.unexpected++;
    calls.unexpectedRequests.push(`${req.method()} ${path}`);
    await route.abort();
  });
  await page.route('**/api/v1/asset-library**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === 'GET' && path === `/api/v1/asset-library/stories/${adventureId}/draft`) {
      // Keep an explicitly requested owned art-draft read on the real API.
      // The ordinary builder no longer mounts the removed manual map editor.
      calls.storyDraftReads++;
      return route.fallback();
    }
    if (path.endsWith('/file')) return route.fulfill({ contentType: 'image/png', body: png });
    if (path.endsWith('/' + revisionId)) return route.fulfill({ json: revision });
    if (path.endsWith('/asset-library') && req.method() === 'GET') {
      calls.libraryReads++;
      return route.fulfill({
        json: jobs.length && (options.outcome ?? 'success') === 'success' ? [revision] : [],
      });
    }
    calls.unexpected++;
    calls.unexpectedRequests.push(`${req.method()} ${path}`);
    await route.abort();
  });
  await page.route('**/api/v1/image-generation/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    if (path.endsWith('/config') && method === 'GET') return route.fulfill({ json: config });
    if (path.endsWith('/studio-locations/prepare') && method === 'POST') {
      expect(req.postDataJSON()).toEqual({ adventureId, locationId });
      const saved = await (
        await page.request.get(`/api/v1/studio/adventures/${adventureId}`)
      ).json();
      const location = saved.content.locations.find(
        (item: { id: string }) => item.id === locationId,
      );
      sourceHash = createHash('sha256')
        .update(JSON.stringify([location.name, location.description, saved.editRevision]))
        .digest('hex');
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
          binding,
          playable: {
            revision: 1,
            artRevision: binding ? 1 : 0,
            maps: [{ id: 'room', label: 'Library map' }],
          },
        },
      });
    }
    if (path.endsWith('/quotes') && method === 'POST') {
      const body = req.postDataJSON();
      expect(status.state).toBe('active');
      expect(body).toMatchObject({
        mode: 'external',
        ...(options.release ? {} : { liveTestSessionId: authorizationId }),
        studioLocationContext: { locationId, sourceHash },
      });
      if (options.release) {
        expect(body.liveTestSessionId).toBeUndefined();
        expect(body.generationAuthorizationId).toBeUndefined();
        // First successful quote persists authority; a subsequent read must not invalidate it.
        status.authorizationId = authorizationId;
        status.sessionId = authorizationId;
      }
      calls.quote++;
      // Production creates a fresh immutable quote for each explicit estimate.
      quoteId = randomUUID();
      return route.fulfill({
        json: {
          decision: 'quote',
          matches: [],
          quote: {
            id: quoteId,
            mode: 'external',
            generationMode: options.release ? 'release' : 'owner',
            estimateRiskConsentRequired: true,
            providerEnforcesQuotedCap: false,
            costBasis: 'approved_estimate',
            upperMicros: null,
            estimatedTotalMicros: 45880,
            reserveMicros: 100000,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            rightsAttestationRequired: true,
            ...(options.release
              ? {
                  policyRevision: 1,
                  policyHash: configFingerprint,
                  sparks: {
                    quoteId: randomUUID(),
                    reserveSubunits: '100000',
                    rateVersion: 'api-cent-1-spark-v1',
                    walletCharging: true,
                  },
                }
              : {}),
          },
        },
      });
    }
    if (path.endsWith('/jobs') && method === 'GET') return route.fulfill({ json: { jobs } });
    if (path.endsWith('/jobs') && method === 'POST') {
      const body = req.postDataJSON();
      expect(body).toMatchObject({ quoteId, consent: true, estimateRiskConsent: true });
      expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(status.state).toBe('active');
      calls.dispatch++;
      const succeeded = (options.outcome ?? 'success') === 'success';
      const job = {
        id: randomUUID(),
        operationId: body.operationId,
        mode: 'external',
        status: succeeded ? 'admitted' : 'unknown',
        studioLocationId: locationId,
        studioSourceHash: sourceHash,
        ...(succeeded ? { revisionId, actualMicros: 45880 } : { errorCode: 'SYNTHETIC_UNKNOWN' }),
        heldMicros: succeeded ? 0 : 100000,
        createdAt: new Date().toISOString(),
        canCancel: false,
      };
      jobs.push(job);
      if (!succeeded) {
        status.state = 'stopped';
        status.stopCode = 'GENERATION_UNKNOWN_COST';
        status.heldMicros = 100000;
        status.remainingMicros = 900000;
        status.imagesEnabled = false;
      }
      if (options.outcome === 'response-lost') return route.abort();
      return route.fulfill({ json: job });
    }
    if (path.endsWith('/studio-locations/bind') && method === 'POST') {
      expect(req.postDataJSON()).toMatchObject({
        adventureId,
        locationId,
        revisionId,
        mapId: 'room',
        expectedSourceHash: sourceHash,
        expectedPlayableRevision: 1,
        expectedArtRevision: 0,
      });
      expect(req.postDataJSON().operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(calls.dispatch).toBe(1);
      calls.bind++;
      binding = { revisionId, sourceHash, stale: false, mapId: 'room' };
      return route.fulfill({ json: binding });
    }
    calls.unexpected++;
    calls.unexpectedRequests.push(`${method} ${path}`);
    await route.abort();
  });
  await page.route('**/api/v1/visual-authoring/packages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/visual-authoring/projects', (route) => route.fulfill({ json: [] }));
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/playable-draft')) calls.mapWrites++;
  });
  return { adventureId, locationId, authorizationId, status, calls, draft, config };
}
async function openLocation(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(`/studio/adventures/${f.adventureId}`);
  await page.getByRole('button', { name: /Locations$/ }).click();
  await page
    .locator(`[data-location-art="${f.locationId}"]`)
    .getByRole('button', { name: 'Choose an image from library', exact: true })
    .click();
  return page.getByTestId('location-image-dialog');
}
async function explicitlyOpenLibrary(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  generationMounts: number,
) {
  const dialog = page.getByTestId('location-image-dialog');
  // ImageGeneration loads the owned-reference catalog on EACH mount, even before
  // the free library picker opens. Success mounts it three times (initial,
  // dismissed/reopened, reload/reopened); unknown outcomes mount it twice.
  // useResource runs once in production, twice under Next dev StrictMode.
  const before = f.calls.libraryReads;
  expect(before).toBeGreaterThanOrEqual(generationMounts);
  expect(before).toBeLessThanOrEqual(generationMounts * 2);
  const dispatches = f.calls.dispatch,
    quotes = f.calls.quote,
    bindings = f.calls.bind;
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/asset-library' && r.request().method() === 'GET',
  );
  await dialog
    .getByRole('button', { name: 'Choose an existing image for free', exact: true })
    .click();
  expect((await response).ok()).toBeTruthy();
  await expect(dialog.getByRole('heading', { name: 'Art library', exact: true })).toBeVisible();
  // Observe past the existing two-second job-status polling interval. That read
  // may reconcile an unknown receipt; it must not reload the catalog or dispatch.
  // Both StrictMode mount effects have a chance to finish before the final delta.
  await page.waitForTimeout(2200);
  expect([1, 2]).toContain(f.calls.libraryReads - before);
  expect(f.calls.libraryReads).toBeLessThanOrEqual((generationMounts + 1) * 2);
  expect(f.calls.dispatch).toBe(dispatches);
  expect(f.calls.quote).toBe(quotes);
  expect(f.calls.bind).toBe(bindings);
  const settledReads = f.calls.libraryReads;
  await page.waitForTimeout(2200);
  expect(f.calls.libraryReads).toBe(settledReads);
  expect(f.calls.dispatch).toBe(dispatches);
  expect(f.calls.quote).toBe(quotes);
  expect(f.calls.bind).toBe(bindings);
}
async function claim(page: Page) {
  const panel = page.getByTestId('live-test-panel');
  await expect(panel).toHaveAttribute('data-generation-mode', 'owner');
  await expect(panel).not.toContainText('Expires:');
  const button = panel.getByRole('button', { name: 'Authorize owner budget', exact: true });
  await expect(button).toBeDisabled();
  await panel.getByLabel(budgetConsent, { exact: true }).check();
  await button.click();
  await expect(panel).toContainText('Owner authorization active');
}
async function prepare(page: Page) {
  const generation = page.getByRole('region', { name: 'Image preparation', exact: true });
  await generation.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await expect(generation).toContainText('Estimated Sparks equivalent');
  await expect(generation).toContainText('Provider reserve in Sparks');
  await expect(generation).toContainText('do not guarantee a maximum provider invoice');
  return generation;
}
for (const locale of ['uk', 'en', 'ru'] as const)
  test(`technical owner configuration is localized (${locale}) on the admin presentation surface and has no temporary session expiry`, async ({
    page,
  }) => {
    const f = await fixture(page, { locale });
    await page.goto('/studio/visuals');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const titles = {
      uk: 'Генерація на сервері',
      en: 'Server generation',
      ru: 'Генерация на сервере',
    };
    const panel = page.getByTestId('live-test-panel');
    await expect(panel.getByRole('heading', { name: titles[locale], exact: true })).toBeVisible();
    await expect(panel).toHaveAttribute('data-generation-mode', 'owner');
    await expect(panel).not.toContainText('Invalid Date');
    await expect(panel).not.toContainText('1970');
    await expect(panel.locator('button').first()).toBeDisabled();
    await expect(
      page.locator('select').filter({ has: page.locator('option[value="external"]') }),
    ).toHaveValue('external');
    expect(f.calls.claim).toBe(0);
    expect(f.calls.dispatch).toBe(0);
    expect(f.calls.legacy).toBe(0);
  });
test('ordinary author sees no technical budget controls and cannot dispatch without owner authorization', async ({
  page,
}) => {
  const f = await fixture(page, { adminPresentation: false });
  await page.goto('/studio/visuals');
  await expect(page.getByTestId('live-test-panel')).toHaveCount(0);
  await expect(page.getByTestId('owner-policy-review')).toHaveCount(0);
  const dialog = await openLocation(page, f);
  await expect(dialog.getByTestId('live-test-panel')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Authorize owner budget', exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Estimate cost', exact: true })).toBeDisabled();
  expect(f.calls.claim).toBe(0);
  expect(f.calls.dispatch).toBe(0);
  expect(f.calls.legacy).toBe(0);
  expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
});
test('synthetic owner image has one explicit cost confirmation, then separate free library/map binding', async ({
  page,
}) => {
  const f = await fixture(page),
    dialog = await openLocation(page, f);
  expect(f.calls.dispatch).toBe(0);
  await claim(page);
  const generation = await prepare(page),
    run = generation.getByRole('button', { name: 'Confirm and generate', exact: true });
  await expect(run).toBeEnabled();
  expect(f.calls.dispatch).toBe(0);
  // Dismissal must not dispatch; reopening requires a new explicit confirmation.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(f.calls.dispatch).toBe(0);
  await page
    .locator(`[data-location-art="${f.locationId}"]`)
    .getByRole('button', { name: 'Choose an image from library', exact: true })
    .click();
  const fresh = await prepare(page);
  await expect(
    fresh.getByRole('button', { name: 'Confirm and generate', exact: true }),
  ).toBeEnabled();
  await fresh.getByRole('button', { name: 'Confirm and generate', exact: true }).click();
  const selection = dialog.getByTestId('location-image-selection');
  await expect(selection).toBeVisible({ timeout: 15000 });
  const bind = selection.getByRole('button', { name: 'Save image for location', exact: true });
  await expect(bind).toBeEnabled();
  expect(f.calls.bind).toBe(0);
  await selection.getByLabel('Image attachment', { exact: true }).selectOption('room');
  await bind.click();
  await expect(dialog.getByRole('heading', { name: 'Saved image', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Locations$/ }).click();
  await page
    .locator(`[data-location-art="${f.locationId}"]`)
    .getByRole('button', { name: 'Choose an image from library', exact: true })
    .click();
  await expect(dialog.getByRole('heading', { name: 'Saved image', exact: true })).toBeVisible();
  expect(f.calls.claim).toBe(1);
  expect(f.calls.quote).toBe(2);
  expect(f.calls.dispatch).toBe(1);
  expect(f.calls.bind).toBe(1);
  expect(f.calls.mapWrites).toBe(0);
  await explicitlyOpenLibrary(page, f, 3);
  expect(f.calls.dispatch).toBe(1);
  expect(f.calls.bind).toBe(1);
  expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
  expect(f.calls.legacy).toBe(0);
});
for (const outcome of ['unknown', 'response-lost'] as const)
  test(`synthetic owner ${outcome} holds the reserve and cannot silently retry after refresh`, async ({
    page,
  }) => {
    const f = await fixture(page, { outcome });
    await openLocation(page, f);
    await claim(page);
    const generation = await prepare(page);
    await generation.getByRole('button', { name: 'Confirm and generate', exact: true }).click();
    await expect(
      page.getByTestId('location-image-dialog').locator('[data-image-job-status="unknown"]'),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByTestId('live-test-panel')
      .getByRole('button', { name: 'Refresh status', exact: true })
      .click();
    await expect(page.getByTestId('live-test-panel')).toContainText('Generation stopped');
    await expect(
      generation.getByRole('button', { name: 'Estimate cost', exact: true }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: /Locations$/ }).click();
    const control = page.locator(`[data-location-art="${f.locationId}"]`);
    await expect(
      control.getByRole('button', { name: 'Estimate cost', exact: true }),
    ).toBeDisabled();
    await control
      .getByRole('button', { name: 'Choose an image from library', exact: true })
      .click();
    await expect(
      page.getByTestId('location-image-dialog').locator('[data-image-job-status="unknown"]'),
    ).toBeVisible();
    expect(f.calls.dispatch).toBe(1);
    expect(f.calls.bind).toBe(0);
    await explicitlyOpenLibrary(page, f, 2);
    expect(f.calls.dispatch).toBe(1);
    expect(f.calls.bind).toBe(0);
    await expect(page.getByTestId('live-test-panel')).toContainText('Generation stopped');
    expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
    expect(f.calls.legacy).toBe(0);
  });
test('owner claim with a lost response is reconciled by status, never by fabricating or resubmitting an ID', async ({
  page,
}) => {
  const f = await fixture(page, { claimLost: true });
  await openLocation(page, f);
  const panel = page.getByTestId('live-test-panel');
  await panel.getByLabel(budgetConsent, { exact: true }).check();
  await panel.getByRole('button', { name: 'Authorize owner budget', exact: true }).click();
  await expect(panel).toContainText('NETWORK_ERROR');
  await panel.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(panel).toContainText('Owner authorization active');
  await expect(
    panel.getByRole('button', { name: 'Authorize owner budget', exact: true }),
  ).toHaveCount(0);
  expect(f.calls.claim).toBe(1);
  expect(f.calls.dispatch).toBe(0);
  expect(f.calls.legacy).toBe(0);
});
test('a forbidden owner status never falls back to manual routes or offers a claim', async ({
  page,
}) => {
  const f = await fixture(page, { forbidden: true });
  await page.goto('/studio/visuals');
  await expect(page.getByTestId('generation-unavailable')).toContainText(
    'GENERATION_OWNER_REQUIRED',
  );
  await expect(page.getByTestId('live-test-panel')).toHaveCount(0);
  expect(f.calls.claim).toBe(0);
  expect(f.calls.dispatch).toBe(0);
  expect(f.calls.legacy).toBe(0);
});
test('stale pricing blocks owner activation without inventing a session expiry', async ({
  page,
}) => {
  const f = await fixture(page, { stalePricing: true });
  await page.goto('/studio/visuals');
  const panel = page.getByTestId('live-test-panel');
  await expect(panel).toContainText('Pricing is stale.');
  await expect(panel).toContainText('Owner authorization has no session timer.');
  await expect(
    panel.getByRole('button', { name: 'Authorize owner budget', exact: true }),
  ).toHaveCount(0);
  expect(f.calls.claim).toBe(0);
  expect(f.calls.dispatch).toBe(0);
});

test('owner text-only profile blocks photo concepts before project creation without switching to sample mode', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/studio/visuals');
  const source = page.getByRole('combobox', { name: 'Character', exact: true });
  await expect(source).toHaveValue('text');
  await expect(source.getByRole('option', { name: 'From photo', exact: true })).toBeDisabled();
  await expect(
    page.getByText(
      'The configured image profile accepts text only. Photo concepts and reference-dependent package parts are unavailable. References are not removed and samples are not substituted.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Artwork source', exact: true })).toHaveValue(
    'external',
  );
  expect(f.calls.dispatch).toBe(0);
  expect(f.calls.quote).toBe(0);
  expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
});

for (const maxReferenceImages of [1, 2] as const)
  test(`owner reference capacity ${maxReferenceImages} permits a private photo concept and reference-based part only with one explicit cost confirmation`, async ({
    page,
  }) => {
    const f = await fixture(page, { maxReferenceImages });
    const photoId = randomUUID(),
      projectId = randomUUID();
    const revisions = { concept: randomUUID(), portrait: randomUUID() };
    const quotes = new Map<
      string,
      {
        id: string;
        mode: 'external';
        generationMode: 'owner';
        estimateRiskConsentRequired: true;
        providerEnforcesQuotedCap: false;
        costBasis: 'approved_estimate';
        upperMicros: null;
        estimatedTotalMicros: number;
        reserveMicros: number;
        expiresAt: string;
        rightsAttestationRequired: true;
      }
    >();
    const admitted = new Set<string>();
    const calls = {
      upload: 0,
      create: 0,
      quote: [] as string[],
      dispatch: [] as string[],
      approve: 0,
    };
    const project = {
      id: projectId,
      kind: 'character',
      name: 'Synthetic private photo hero',
      sourceHash: 'a'.repeat(64),
      provider: 'external',
      revision: 1,
      status: 'concept',
      conceptUrl: null,
      plan: null,
      projection: null,
    };
    await page.route('**/api/v1/assets', async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['content-type']).toContain('multipart/form-data');
      calls.upload++;
      await route.fulfill({ json: { id: photoId, mimeType: 'image/png', size: png.length } });
    });
    await page.route(`**/api/v1/assets/${photoId}/file`, (route) =>
      route.fulfill({ contentType: 'image/png', body: png }),
    );
    await page.route('**/api/v1/asset-library/revisions/*/file', (route) =>
      route.fulfill({ contentType: 'image/png', body: png }),
    );
    await page.route('**/api/v1/visual-authoring/projects**', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path.endsWith('/projects') && req.method() === 'GET')
        return route.fulfill({ json: calls.create ? [project] : [] });
      if (path.endsWith('/projects') && req.method() === 'POST') {
        expect(req.postDataJSON()).toMatchObject({
          kind: 'character',
          generationMode: 'external',
          brief: {
            source: 'photo',
            sourcePhotoAssetId: photoId,
            sourcePhotoPermission: true,
            allowOutputReuse: false,
          },
        });
        calls.create++;
        return route.fulfill({ json: project });
      }
      if (path.endsWith('/generation') && req.method() === 'GET') {
        const roles = project.status === 'concept' ? ['concept'] : ['portrait', 'sheet'];
        const items = [...new Set([...roles, ...admitted])].map((role) => {
          if (admitted.has(role))
            return {
              role,
              stage: role === 'concept' ? 'concept' : 'parts',
              status: 'admitted',
              revisionId: revisions[role as keyof typeof revisions],
              url: `/api/v1/asset-library/revisions/${revisions[role as keyof typeof revisions]}/file`,
              validation: { valid: true, width: 1024, height: 1024 },
            };
          return {
            role,
            stage: role === 'concept' ? 'concept' : 'parts',
            status: quotes.has(role) ? 'quoted' : 'idle',
            ...(quotes.has(role)
              ? { quote: { decision: 'quote', matches: [], quote: quotes.get(role) } }
              : {}),
          };
        });
        return route.fulfill({
          json: {
            projectId,
            mode: 'external',
            requiredRoles: roles,
            items,
            readyForReview: false,
            automaticRetry: false,
            humanVisualReviewRequired: true,
            configuration: f.config,
          },
        });
      }
      if (path.endsWith('/generation/quote') && req.method() === 'POST') {
        const body = req.postDataJSON();
        expect(body.liveTestSessionId).toBe(f.authorizationId);
        expect(body.expectedRevision).toBe(project.revision);
        expect(['concept', 'portrait']).toContain(body.role);
        // References are resolved from the owned project on the server, never replaced by a client URL.
        expect(body.sourcePhotoAssetId).toBeUndefined();
        expect(body.referenceRevisionIds).toBeUndefined();
        if (body.role === 'portrait') expect(admitted.has('concept')).toBe(true);
        const quote = {
          id: randomUUID(),
          mode: 'external' as const,
          generationMode: 'owner' as const,
          estimateRiskConsentRequired: true as const,
          providerEnforcesQuotedCap: false as const,
          costBasis: 'approved_estimate' as const,
          upperMicros: null,
          estimatedTotalMicros: f.config.estimatedTotalMicros,
          reserveMicros: f.config.reserveMicros,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          rightsAttestationRequired: true as const,
        };
        quotes.set(body.role, quote);
        calls.quote.push(body.role);
        return route.fulfill({ json: { decision: 'quote', matches: [], quote } });
      }
      if (path.endsWith('/generation/dispatch') && req.method() === 'POST') {
        const body = req.postDataJSON();
        expect(body).toMatchObject({
          expectedRevision: project.revision,
          consent: true,
          estimateRiskConsent: true,
          quoteId: quotes.get(body.role)?.id,
        });
        expect(admitted.has(body.role)).toBe(false);
        expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
        admitted.add(body.role);
        calls.dispatch.push(body.role);
        return route.fulfill({ json: { id: randomUUID(), status: 'admitted' } });
      }
      if (path.endsWith('/approve') && req.method() === 'POST') {
        expect(admitted.has('concept')).toBe(true);
        expect(req.postDataJSON().consent).toBe(true);
        calls.approve++;
        project.status = 'approved';
        project.revision++;
        return route.fulfill({ json: project });
      }
      if (path.endsWith(projectId) && req.method() === 'GET')
        return route.fulfill({ json: project });
      throw new Error(`Unexpected synthetic owner photo route ${path}`);
    });
    await page.goto('/studio/visuals');
    await claim(page);
    const source = page.getByRole('combobox', { name: 'Character', exact: true });
    await expect(source.getByRole('option', { name: 'From photo', exact: true })).toBeEnabled();
    await source.selectOption('photo');
    await page.getByLabel('Private reference photo', { exact: true }).setInputFiles({
      name: 'synthetic-private-reference.png',
      mimeType: 'image/png',
      buffer: png,
    });
    await expect(page.getByAltText('Private reference photo', { exact: true })).toBeVisible();
    const create = page.getByRole('button', {
      name: 'Save external generation project',
      exact: true,
    });
    await expect(create).toBeDisabled();
    await page
      .getByLabel('I have permission to use this photo to create my character.', { exact: true })
      .check();
    await page
      .getByLabel('Creative brief', { exact: true })
      .fill('A synthetic adult fictional traveler in a green cloak.');
    await create.click();
    for (const role of ['concept', 'portrait'] as const) {
      const stage = page.locator(`[data-generation-role="${role}"]`);
      await stage.getByRole('button', { name: 'Estimate cost', exact: true }).click();
      const dispatch = stage.getByRole('button', { name: 'Confirm and generate', exact: true });
      await expect(dispatch).toBeEnabled();
      await dispatch.click();
      await expect(stage.getByText('Structural validation passed', { exact: true })).toBeVisible();
      if (role === 'concept')
        await page
          .getByRole('button', { name: 'Approve this concept / plan', exact: true })
          .click();
    }
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page
        .locator('[data-generation-role="portrait"]')
        .getByText('Structural validation passed', { exact: true }),
    ).toBeVisible();
    expect(calls.upload).toBe(1);
    expect(calls.create).toBe(1);
    expect(calls.approve).toBe(1);
    expect(calls.quote).toEqual(['concept', 'portrait']);
    expect(calls.dispatch).toEqual(['concept', 'portrait']);
    expect(f.calls.dispatch).toBe(0);
    expect(f.calls.legacy).toBe(0);
    expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
  });

test('ordinary release author generates without Live Test claim or session ID and keeps first quote after admission', async ({
  page,
}) => {
  const f = await fixture(page, { release: true, adminPresentation: false });
  const dialog = await openLocation(page, f);
  await expect(dialog.getByTestId('live-test-panel')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Authorize owner budget', exact: true }),
  ).toHaveCount(0);
  const generation = page.getByRole('region', { name: 'Image preparation', exact: true });
  const prepareQuote = generation.getByRole('button', {
    name: 'Estimate cost',
    exact: true,
  });
  // Release authority is first persisted by this POST, never an operator claim.
  expect(f.status.authorizationId).toBeNull();
  expect(f.status.capMicros).toBeNull();
  expect(f.status.allowance).toBe('unlimited');
  await expect(prepareQuote).toBeEnabled();
  await prepareQuote.click();
  const run = generation.getByRole('button', { name: 'Confirm and generate', exact: true });
  await expect(run).toBeEnabled();
  await run.click();
  await expect.poll(() => f.calls.dispatch).toBe(1);
  expect(f.calls.claim).toBe(0);
  expect(f.calls.legacy).toBe(0);
  expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
});

test('one image confirmation cancels cleanly, invalidates edited quotes and prevents duplicate dispatch', async ({
  page,
}) => {
  const f = await fixture(page, { release: true, adminPresentation: false });
  await openLocation(page, f);
  const generation = await prepare(page);
  let confirmation = generation.locator('[data-image-confirmation]');
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(confirmation).toContainText('actual usage may exceed the estimate and reserve');
  expect(f.calls.dispatch).toBe(0);
  await confirmation.evaluate((element) => {
    const buttons = element.querySelectorAll('button');
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
  });
  await expect(confirmation).toHaveCount(0);
  expect(f.calls.dispatch).toBe(0);
  await prepare(page);
  await generation.getByText('Advanced options', { exact: true }).click();
  await generation
    .getByLabel('License or terms name', { exact: true })
    .fill('Updated owned artwork terms');
  await expect(generation.locator('[data-image-confirmation]')).toHaveCount(0);
  expect(f.calls.dispatch).toBe(0);
  await prepare(page);
  confirmation = generation.locator('[data-image-confirmation]');
  await confirmation
    .getByRole('button', { name: 'Confirm and generate', exact: true })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect.poll(() => f.calls.dispatch).toBe(1);
  expect(f.calls.quote).toBe(3);
  expect(f.calls.claim).toBe(0);
  expect(f.calls.unexpected, f.calls.unexpectedRequests.join('\n')).toBe(0);
});

test('inline map image requests no quote before the bottom button and uses one confirm/cancel', async ({
  page,
}) => {
  const f = await fixture(page, { release: true, adminPresentation: false });
  await page.goto(`/studio/adventures/${f.adventureId}`);
  await page.getByRole('button', { name: /Locations$/ }).click();
  const control = page.locator(`[data-location-art="${f.locationId}"]`);
  const estimate = control.getByRole('button', { name: 'Estimate cost', exact: true });
  await expect(estimate).toBeEnabled();
  expect(f.calls.quote).toBe(0);
  expect(f.calls.dispatch).toBe(0);
  await estimate.click();
  const confirmation = control.locator('[data-image-confirmation]');
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator('input[type="checkbox"]')).toHaveCount(0);
  expect(f.calls.quote).toBe(1);
  expect(f.calls.dispatch).toBe(0);
  await confirmation.evaluate((element) => {
    const buttons = element.querySelectorAll('button');
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();
  });
  await expect(confirmation).toHaveCount(0);
  expect(f.calls.dispatch).toBe(0);
  await estimate.click();
  await confirmation.getByRole('button', { name: 'Confirm and generate', exact: true }).click();
  await expect.poll(() => f.calls.dispatch).toBe(1);
  expect(f.calls.quote).toBe(2);
});
