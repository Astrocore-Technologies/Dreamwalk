import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { GameEnvelope } from '@dreamwalk/contracts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
  'base64',
);
async function account(page: Page) {
  const handle = `manual_ui_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const response = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      email: `${handle}@example.test`,
      name: 'Synthetic UI operator',
      password: `Test-${randomUUID()}!`,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.request.patch('/api/v1/account/settings', { data: { language: 'en' } });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  // Only the browser response is synthetic. The account retains its normal server role.
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    await route.fulfill({ response, json: { ...body, user: { ...body.user, role: 'admin' } } });
  });
}
function status(active = false) {
  return {
    enabled: true,
    sessionId: randomUUID(),
    state: active ? 'active' : 'unclaimed',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    stopCode: null as string | null,
    capMicros: 1000000,
    usedMicros: 0,
    heldMicros: 0,
    remainingMicros: 1000000,
    priorHeldReservations: 0,
    imagesEnabled: true,
    text: {
      model: 'synthetic-text-model',
      upperMicros: 264036,
      maxOutputTokens: 2048,
      contextTokens: 1050000,
      costEvidence: 'synthetic-test',
    },
  };
}
async function fixtures(page: Page, mode: 'success' | 'unknown' | 'estimate' = 'success') {
  const calls = { claim: 0, quote: 0, dispatch: 0, approve: 0, complete: 0, unexpected: 0 },
    live = status(mode !== 'success');
  const projectId = randomUUID(),
    conceptId = randomUUID(),
    portraitId = randomUUID(),
    sheetId = randomUUID(),
    quoteId = randomUUID(),
    jobId = randomUUID();
  const project = {
    id: projectId,
    kind: 'character',
    name: 'Synthetic external concept',
    sourceHash: 'a'.repeat(64),
    provider: 'external',
    revision: 1,
    status: 'concept',
    conceptUrl: null,
    plan: null,
    projection: null,
  };
  let created = false,
    quoted = false,
    dispatched = false,
    packageReady = false;
  let completeBody: Record<string, unknown> | null = null;
  const configuration = {
    externalEnabled: true,
    externalBlockReasons: [],
    verifiedUpperMicros: mode === 'estimate' ? null : 100000,
    costStatus: mode === 'estimate' ? 'approved_estimate' : 'verified_bound',
    requestProfile: {
      provider: 'synthetic',
      model: 'synthetic-image-model',
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
    },
  };
  const quote = {
    id: quoteId,
    mode: 'external',
    upperMicros: mode === 'estimate' ? null : 100000,
    ...(mode === 'estimate'
      ? { estimatedTotalMicros: 45880, reserveMicros: 100000, costBasis: 'approved_estimate' }
      : {}),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    rightsAttestationRequired: true,
  };
  const part = (role: string, revisionId: string) => ({
    role,
    revisionId,
    stage: role === 'concept' ? 'concept' : 'parts',
    status: 'admitted',
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    validation: {
      valid: true,
      width: 1024,
      height: 1024,
      ...(role === 'sheet' ? { nonemptyFrames: 24 } : {}),
    },
  });
  const generation = () => {
    const items: object[] = [];
    if (dispatched && mode === 'success') items.push(part('concept', conceptId));
    else if (dispatched)
      items.push({
        role: 'concept',
        stage: 'concept',
        status: 'unknown',
        quote: { decision: 'quote', matches: [], quote },
        job: {
          id: jobId,
          operationId: randomUUID(),
          status: 'unknown',
          mode: 'external',
          errorCode: 'PROVIDER_HTTP_403',
          diagnostic: { httpStatus: 403, billing: 'unknown' },
          heldMicros: 100000,
          createdAt: new Date().toISOString(),
          canCancel: false,
        },
      });
    else if (quoted)
      items.push({
        role: 'concept',
        stage: 'concept',
        status: 'quoted',
        quote: { decision: 'quote', matches: [], quote },
      });
    if (project.status !== 'concept')
      items.push(part('portrait', portraitId), part('sheet', sheetId));
    return {
      projectId,
      mode: 'external',
      requiredRoles: project.status === 'concept' ? ['concept'] : ['portrait', 'sheet'],
      items,
      readyForReview: dispatched && mode === 'success',
      automaticRetry: false,
      humanVisualReviewRequired: true,
      configuration,
    };
  };
  await page.route('**/api/v1/live-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status') && route.request().method() === 'GET')
      return route.fulfill({ json: live });
    if (path.endsWith('/claim') && route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ consent: true });
      calls.claim++;
      live.state = 'active';
      return route.fulfill({ json: live });
    }
    calls.unexpected++;
    await route.abort();
  });
  await page.route('**/api/v1/image-generation/**', async (route) => {
    calls.unexpected++;
    await route.abort();
  });
  await page.route('**/api/v1/asset-library/revisions/*/file', (route) =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/api/v1/visual-authoring/packages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/visual-authoring/projects**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path.endsWith('/projects') && method === 'GET')
      return route.fulfill({ json: created ? [project] : [] });
    if (path.endsWith('/projects') && method === 'POST') {
      expect(request.postDataJSON().generationMode).toBe('external');
      created = true;
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/generation') && method === 'GET')
      return route.fulfill({ json: generation() });
    if (path.endsWith('/generation/quote') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.liveTestSessionId).toBe(live.sessionId);
      expect(body.role).toBe('concept');
      calls.quote++;
      quoted = true;
      return route.fulfill({ json: { decision: 'quote', matches: [], quote } });
    }
    if (path.endsWith('/generation/dispatch') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.quoteId).toBe(quoteId);
      expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
      calls.dispatch++;
      dispatched = true;
      if (mode === 'unknown') {
        live.state = 'stopped';
        live.stopCode = 'PROVIDER_HTTP_403';
        live.heldMicros = 100000;
        live.remainingMicros = 900000;
      }
      return route.fulfill({
        json: { id: jobId, status: mode === 'success' ? 'admitted' : 'unknown' },
      });
    }
    if (path.endsWith('/approve') && method === 'POST') {
      expect(dispatched).toBe(true);
      expect(request.postDataJSON().consent).toBe(true);
      calls.approve++;
      project.status = 'approved';
      project.revision++;
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/complete') && method === 'POST') {
      completeBody = request.postDataJSON();
      expect(completeBody?.visualReview).toBe(true);
      calls.complete++;
      packageReady = true;
      project.status = 'ready';
      project.revision++;
      return route.fulfill({
        json: {
          id: randomUUID(),
          projectId,
          name: project.name,
          kind: 'character',
          version: 1,
          provider: 'external',
          providerCalls: 1,
          chargeMicros: 100000,
          parts: [
            ['concept', conceptId],
            ['portrait', portraitId],
            ['sheet', sheetId],
          ].map(([role, revisionId]) => ({
            role,
            revisionId,
            uploadId: randomUUID(),
            width: 1024,
            height: 1024,
            sha256: 'b'.repeat(64),
          })),
        },
      });
    }
    if (path.endsWith(projectId) && method === 'GET') return route.fulfill({ json: project });
    calls.unexpected++;
    await route.abort();
  });
  return {
    calls,
    get packageReady() {
      return packageReady;
    },
    get completeBody() {
      return completeBody;
    },
  };
}
async function create(page: Page) {
  await page
    .getByRole('combobox', { name: 'Artwork source', exact: true })
    .selectOption('external');
  await page
    .getByLabel('Creative brief', { exact: true })
    .fill('An adult fictional traveler in a green coat, synthetic test only.');
  await page.getByRole('button', { name: 'Save external generation project', exact: true }).click();
  await expect(page.getByTestId('external-generation')).toBeVisible();
}
test('synthetic external stages require separate image consent and human review; mount never dispatches', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page);
  await page.goto('/studio/visuals');
  const panel = page.getByTestId('live-test-panel');
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await panel.screenshot({ path: test.info().outputPath('synthetic-manual-budget-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('synthetic-manual-budget-mobile.png'),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(mock.calls.claim).toBe(0);
  expect(mock.calls.dispatch).toBe(0);
  await panel.getByLabel(/I authorize this manual test session/).check();
  await panel.getByRole('button', { name: 'Activate manual session', exact: true }).click();
  await expect(panel.getByText('Session active', { exact: true })).toBeVisible();
  await create(page);
  const approve = page.getByRole('button', { name: 'Approve this concept / plan', exact: true });
  await expect(approve).toBeDisabled();
  const concept = page.locator('[data-generation-role="concept"]');
  await concept.getByRole('button', { name: 'Estimate this image', exact: true }).click();
  await expect(concept.getByText('Upper estimate: $0.10', { exact: true })).toBeVisible();
  const dispatch = concept.getByRole('button', { name: 'Dispatch one request', exact: true });
  await expect(dispatch).toBeDisabled();
  expect(mock.calls.dispatch).toBe(0);
  await concept.getByLabel(/I have rights to the specified references/).check();
  await dispatch.click();
  await expect(approve).toBeEnabled();
  expect(mock.calls.dispatch).toBe(1);
  await approve.click();
  const complete = page.getByRole('button', { name: 'Save reviewed package', exact: true });
  await expect(complete).toBeDisabled();
  expect(mock.calls.dispatch).toBe(1);
  await page.getByLabel(/I reviewed the face, outfit, transparency/).check();
  await complete.click();
  await expect.poll(() => mock.calls.complete).toBe(1);
  expect(mock.completeBody?.visualReview).toBe(true);
  expect(mock.packageReady).toBe(true);
  expect(mock.calls.unexpected).toBe(0);
});
test('synthetic unknown image charge remains visible and cannot trigger regeneration after reload', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page, 'unknown');
  await page.goto('/studio/visuals');
  await create(page);
  const concept = page.locator('[data-generation-role="concept"]');
  await concept.getByRole('button', { name: 'Estimate this image', exact: true }).click();
  await concept.getByLabel(/I have rights to the specified references/).check();
  await concept.getByRole('button', { name: 'Dispatch one request', exact: true }).click();
  await expect(concept.getByText('PROVIDER_HTTP_403', { exact: true })).toBeVisible();
  await expect(
    concept.getByRole('button', { name: 'Dispatch one request', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(concept.getByText('PROVIDER_HTTP_403', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh stages', exact: true }).click();
  await expect(
    concept.getByRole('button', { name: 'Estimate this image', exact: true }),
  ).toHaveCount(0);
  expect(mock.calls.dispatch).toBe(1);
  expect(mock.calls.unexpected).toBe(0);
});
test('synthetic planning estimate is never shown as a free hard cap and cannot dispatch', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page, 'estimate');
  await page.goto('/studio/visuals');
  await create(page);
  const concept = page.locator('[data-generation-role="concept"]');
  await concept.getByRole('button', { name: 'Estimate this image', exact: true }).click();
  await expect(
    concept.getByText('Planning estimate, not an invoice cap: $0.04588', { exact: true }),
  ).toBeVisible();
  await expect(concept.getByText('Operational reserve: $0.10', { exact: true })).toBeVisible();
  await expect(concept.getByLabel(/I have rights to the specified references/)).toBeDisabled();
  await expect(
    concept.getByRole('button', { name: 'Dispatch one request', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await concept.screenshot({ path: test.info().outputPath('synthetic-estimate-blocked.png') });
  expect(mock.calls.dispatch).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('synthetic world requests require individual consent and stale phase fences disable approval', async ({
  page,
}) => {
  await account(page);
  const created = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1', turnBased: true },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).campaignId;
  const envelope: GameEnvelope = await (
    await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`)
  ).json();
  const live = status(true),
    original = {
      roundId: envelope.projection.turn!.roundId,
      phaseEpoch: envelope.projection.turn!.phaseEpoch + 1,
      rulesetVersion: 1 as const,
    };
  envelope.projection.turn = {
    ...envelope.projection.turn!,
    phase: 'world',
    activeActorId: null,
    ownTurn: false,
    phaseEpoch: original.phaseEpoch,
  };
  let approvals = 0;
  const requests = [
    {
      id: randomUUID(),
      subjectId: 'Mira',
      purpose: 'synthetic-response',
      permitState: null as string | null,
      upperMicros: 264036,
    },
    {
      id: randomUUID(),
      subjectId: 'Borin',
      purpose: 'synthetic-response',
      permitState: null as string | null,
      upperMicros: 264036,
    },
  ];
  await page.routeWebSocket('**/*', (ws) => ws.close());
  await page.route(`**/api/v1/game/campaigns/${id}/snapshot`, (route) =>
    route.fulfill({ json: envelope }),
  );
  await page.route('**/api/v1/live-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: live });
    if (path.endsWith('/requests') && route.request().method() === 'GET')
      return route.fulfill({ json: { turnFence: original, requests } });
    if (path.endsWith('/consent') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.turnFence).toEqual(original);
      expect(body.consent).toBe(true);
      approvals++;
      requests.find((r) => path.includes(r.id))!.permitState = 'authorized';
      return route.fulfill({
        json: { id: requests[0].id, state: 'authorized', upperMicros: 264036 },
      });
    }
    throw new Error(`Unexpected synthetic test route ${path}`);
  });
  await page.goto(`/game/${id}`);
  const panel = page.getByTestId('live-test-panel');
  await panel.getByRole('button', { name: 'Check world requests', exact: true }).click();
  const first = panel.locator(`[data-live-request="${requests[0].id}"]`),
    second = panel.locator(`[data-live-request="${requests[1].id}"]`);
  await expect(first).toBeVisible();
  expect(approvals).toBe(0);
  await first
    .getByLabel('I approve only this request up to the displayed amount.', { exact: true })
    .check();
  await first.getByRole('button', { name: 'Approve this request', exact: true }).click();
  await expect(first.getByText('Authorized', { exact: true })).toBeVisible();
  await expect(second.getByRole('checkbox')).not.toBeChecked();
  expect(approvals).toBe(1);
  envelope.projection.turn.phaseEpoch++;
  await page.reload();
  await panel.getByRole('button', { name: 'Check world requests', exact: true }).click();
  await expect(
    panel.getByText('The turn changed. Refresh requests first.', { exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .locator(`[data-live-request="${requests[1].id}"]`)
      .getByRole('button', { name: 'Approve this request', exact: true }),
  ).toBeDisabled();
  expect(approvals).toBe(1);
});

test('synthetic admin notice distinguishes manual runtime from the profile catalog without calling providers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await account(page);
  const mock = await fixtures(page, 'estimate');
  await page.route('**/api/v1/admin/**', async (route) => {
    if (
      new URL(route.request().url()).pathname.endsWith('/overview') &&
      route.request().method() === 'GET'
    )
      return route.fulfill({ json: { users: 3, adventures: 1, pendingReview: 0, openReports: 0 } });
    throw new Error('Unexpected synthetic admin route');
  });
  await page.goto('/admin');
  const notice = page.getByText(
    'A local manual API test is configured. External requests need owner consent; the available budget is shown below.',
    { exact: true },
  );
  await expect(notice).toBeVisible();
  await expect(page.getByTestId('live-test-panel')).toBeVisible();
  await expect(
    page.getByText(
      'This catalog edits profiles and demo data. It does not enable external requests by itself; manual API-test status is available only to the designated local owner.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await notice.screenshot({ path: test.info().outputPath('synthetic-admin-live-notice.png') });
  await page
    .getByTestId('live-test-panel')
    .screenshot({ path: test.info().outputPath('synthetic-admin-budget.png') });
  expect(mock.calls.claim).toBe(0);
  expect(mock.calls.dispatch).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
