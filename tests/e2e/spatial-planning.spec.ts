import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  createAuthoredDraft,
  compilePlayableDraft,
  createStateFromPlayable,
  projectState,
} from '@dreamwalk/game-core';
import type { AuthoredGameDraft } from '@dreamwalk/contracts';

async function account(page: Page) {
  const handle = `spatial_ui_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      email: `${handle}@example.test`,
      name: 'Synthetic spatial author',
      password: `Test-${randomUUID()}!`,
    },
  });
  expect(registered.ok()).toBeTruthy();
  await page.request.patch('/api/v1/account/settings', { data: { language: 'en' } });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    await route.fulfill({ response, json: { ...body, user: { ...body.user, role: 'admin' } } });
  });
}
function plan() {
  const draft = createAuthoredDraft('courtyard');
  const names: Record<string, string> = { courtyard: 'atelier', garden: 'annex' };
  draft.title = 'A quiet research library';
  draft.startMapId = 'atelier';
  for (const map of draft.maps) {
    map.id = names[map.id];
    for (const exit of map.exits) exit.destinationMapId = names[exit.destinationMapId];
  }
  for (const entity of [...draft.objects, ...draft.npcs]) entity.mapId = names[entity.mapId];
  const npc = draft.npcs[0];
  npc.label = 'Hana the archivist';
  npc.mapId = 'annex';
  npc.x = 6;
  npc.y = 3;
  npc.patrolTarget = { x: 6, y: 4 };
  npc.publicProfile = {
    role: 'Archivist',
    description: 'Keeps the herb index in the annex.',
    appearance: 'Blue robe and spectacles.',
  };
  npc.initialFacts = [
    {
      id: 'sealed-record',
      title: 'SPATIAL_PRIVATE_TITLE',
      text: 'SPATIAL_PRIVATE_NPC_CANARY',
      disclosure: 'never',
    },
  ];
  const first = draft.maps[0],
    second = draft.maps[1];
  first.label = 'Quiet research room';
  first.width = 24;
  first.height = 24;
  first.composition = {
    version: 1,
    provenance: 'original-drawn-fixture',
    layers: [{ id: 'study-table', visual: 'table', x: 2, y: 7, width: 4, height: 1, solid: true }],
  };
  first.blocked.push(...[2, 3, 4, 5].map((x) => ({ x, y: 7 })));
  second.label = 'Herb annex';
  second.width = 24;
  second.height = 24;
  second.composition = {
    version: 1,
    provenance: 'original-drawn-fixture',
    layers: [{ id: 'rare-shelf', visual: 'shelf', x: 6, y: 5, width: 2, height: 1, solid: true }],
  };
  second.blocked.push({ x: 6, y: 5 }, { x: 7, y: 5 });
  const compiled = compilePlayableDraft(draft);
  expect(compiled.errors).toEqual([]);
  return {
    draft,
    projection: projectState(
      createStateFromPlayable(compiled.playable!, ['spatial-preview']),
      'spatial-preview',
    ),
  };
}
type Mode = 'success' | 'unknown' | 'invalid' | 'queued' | 'stale' | 'response-lost' | 'manual';
async function fixtures(page: Page, mode: Mode = 'success') {
  const scene = plan(),
    projectId = randomUUID(),
    adventureId = randomUUID(),
    quoteId = randomUUID(),
    jobId = randomUUID(),
    proposalId = randomUUID(),
    sessionId = randomUUID();
  const sourceHash = 'a'.repeat(64);
  const project: {
    id: string;
    kind: 'location';
    name: string;
    sourceHash: string;
    revision: number;
    provider: 'external';
    status: string;
    planProvenance: string;
    plan: AuthoredGameDraft | null;
    projection: typeof scene.projection | null;
    conceptUrl: null;
  } = {
    id: projectId,
    kind: 'location',
    name: 'Synthetic spatial library',
    sourceHash,
    revision: 1,
    provider: 'external',
    status: 'concept',
    planProvenance: mode === 'manual' ? 'deterministic-editable-template' : 'ai-pending',
    plan: mode === 'manual' ? structuredClone(scene.draft) : null,
    projection: mode === 'manual' ? scene.projection : null,
    conceptUrl: null,
  };
  const live = {
    enabled: true,
    sessionId,
    state: 'active',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    stopCode: null as string | null,
    capMicros: 1000000,
    usedMicros: 0,
    heldMicros: 0,
    remainingMicros: 1000000,
    priorHeldReservations: 0,
    imagesEnabled: false,
    imageBlockCode: 'VERIFIED_IMAGE_UPPER_BOUND_REQUIRED',
    text: {
      model: 'synthetic-text-model',
      upperMicros: 264036,
      maxOutputTokens: 2048,
      contextTokens: 1050000,
      costEvidence: 'synthetic',
    },
  };
  const quote = {
    id: quoteId,
    upperMicros: 264036,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    consumed: false,
  };
  const calls = {
    quote: 0,
    dispatch: 0,
    apply: 0,
    cancel: 0,
    edit: 0,
    approve: 0,
    imageRead: 0,
    unexpected: 0,
  };
  let created = false,
    quoted = false,
    dispatched = false,
    cancelled = false,
    applied = false;
  let edited: Record<string, unknown> | null = null;
  const job = () => ({
    id: jobId,
    projectId,
    status: cancelled
      ? 'cancelled'
      : mode === 'queued'
        ? 'queued'
        : mode === 'unknown'
          ? 'unknown'
          : mode === 'invalid'
            ? 'failed'
            : 'committed',
    canCancel: !cancelled && mode === 'queued',
    canRetry: false,
    upperMicros: 264036,
    actualMicros:
      mode === 'unknown' || (mode === 'queued' && !cancelled) ? null : cancelled ? 0 : 264036,
    costStatus:
      mode === 'unknown' ? 'unknown' : mode === 'queued' && !cancelled ? 'reserved' : 'settled',
    errorCode:
      mode === 'unknown' ? 'PROVIDER_HTTP_403' : mode === 'invalid' ? 'SPATIAL_PLAN_INVALID' : null,
    createdAt: new Date().toISOString(),
    result: ['success', 'stale', 'response-lost'].includes(mode) ? { proposalId } : null,
  });
  const proposal = () => ({
    id: proposalId,
    status: applied ? 'applied' : 'proposed',
    projectRevision: 1,
    sourceHash: mode === 'stale' ? 'b'.repeat(64) : sourceHash,
    plan: scene.draft,
    projection: scene.projection,
    validated: true,
  });
  const state = () => ({
    available: true,
    canQuote: !dispatched && project.status === 'concept',
    manualDispatchOnly: true,
    model: 'synthetic-text-model',
    maxOutputTokens: 2048,
    upperMicros: 264036,
    quotes: quoted ? [quote] : [],
    jobs: dispatched ? [job()] : [],
    ...(dispatched && ['success', 'stale', 'response-lost'].includes(mode)
      ? { currentProposal: proposal() }
      : {}),
    canApply: dispatched && !applied && ['success', 'stale', 'response-lost'].includes(mode),
    blockers: [],
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
  await page.route('**/api/v1/image-generation/**', async (route) => {
    calls.unexpected++;
    await route.abort();
  });
  await page.route('**/api/v1/visual-authoring/packages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/visual-authoring/projects**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path.endsWith('/projects') && method === 'GET')
      return route.fulfill({ json: created ? [project] : [] });
    if (path.endsWith('/projects') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.generationMode).toBe('external');
      expect(body.spatialMode).toBe(mode === 'manual' ? 'manual' : 'ai');
      expect(body.brief.description).toContain('quiet research library');
      created = true;
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/spatial-plan') && method === 'GET') return route.fulfill({ json: state() });
    if (path.endsWith('/spatial-plan/quote') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.sessionId).toBe(sessionId);
      expect(body.expectedRevision).toBe(project.revision);
      calls.quote++;
      quoted = true;
      return route.fulfill({
        json: {
          ...quote,
          requiresConsent: true,
          model: 'synthetic-text-model',
          costEvidence: 'synthetic',
        },
      });
    }
    if (path.endsWith('/spatial-plan/dispatch') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.quoteId).toBe(quoteId);
      calls.dispatch++;
      dispatched = true;
      quote.consumed = true;
      if (mode === 'unknown') {
        live.state = 'stopped';
        live.stopCode = 'PROVIDER_HTTP_403';
        live.heldMicros = 264036;
        live.remainingMicros -= 264036;
      } else if (mode === 'queued') {
        live.heldMicros = 264036;
        live.remainingMicros -= 264036;
      } else {
        live.usedMicros = 264036;
        live.remainingMicros -= 264036;
      }
      if (mode === 'response-lost') return route.abort('failed');
      return route.fulfill({ json: job() });
    }
    if (path.endsWith('/spatial-plan/apply') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.proposalId).toBe(proposalId);
      expect(mode).not.toBe('stale');
      calls.apply++;
      applied = true;
      project.revision++;
      project.planProvenance = 'ai-generated-plan';
      project.plan = structuredClone(scene.draft);
      project.projection = scene.projection;
      return route.fulfill({ json: project });
    }
    if (path.endsWith(`/spatial-plan/jobs/${jobId}/cancel`) && method === 'POST') {
      calls.cancel++;
      cancelled = true;
      live.heldMicros = 0;
      live.remainingMicros = 1000000;
      return route.fulfill({ json: job() });
    }
    if (path.endsWith('/layers') && method === 'POST') {
      const body = request.postDataJSON();
      expect(body.expectedRevision).toBe(project.revision);
      expect(body.mapId).toBe('annex');
      expect(body.layerId).toBe('rare-shelf');
      edited = body;
      calls.edit++;
      const map = project.plan!.maps.find((map) => map.id === body.mapId)!,
        layer = map.composition!.layers[0];
      map.blocked = map.blocked.filter(
        (point) => !(point.y === layer.y && point.x >= layer.x && point.x < layer.x + layer.width),
      );
      layer.x = body.point.x;
      layer.y = body.point.y;
      layer.visual = body.visual;
      for (let x = 0; x < layer.width; x++) map.blocked.push({ x: layer.x + x, y: layer.y });
      project.revision++;
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/approve') && method === 'POST') {
      expect(project.plan).not.toBeNull();
      calls.approve++;
      project.status = 'approved';
      project.revision++;
      return route.fulfill({ json: project });
    }
    if (path.endsWith('/generation') && method === 'GET') {
      calls.imageRead++;
      return route.fulfill({
        json: {
          projectId,
          mode: 'external',
          requiredRoles: ['background'],
          items: [],
          readyForReview: false,
          automaticRetry: false,
          humanVisualReviewRequired: true,
          configuration: {
            externalEnabled: false,
            externalBlockReasons: ['VERIFIED_IMAGE_UPPER_BOUND_REQUIRED'],
            verifiedUpperMicros: null,
          },
        },
      });
    }
    if (path.endsWith(projectId) && method === 'GET') return route.fulfill({ json: project });
    calls.unexpected++;
    await route.abort();
  });
  return {
    calls,
    adventureId,
    npcProjected: scene.projection.entities.some((entity) => entity.id === scene.draft.npcs[0].id),
    get project() {
      return project;
    },
    get edited() {
      return edited;
    },
  };
}
async function create(page: Page, adventureId: string, manual = false) {
  await page.goto(`/studio/visuals?adventureId=${adventureId}`);
  await page
    .getByRole('combobox', { name: 'Artwork source', exact: true })
    .selectOption('external');
  await expect(
    page.getByRole('combobox', { name: 'How to create the spatial plan', exact: true }),
  ).toHaveValue('ai');
  if (manual)
    await page
      .getByRole('combobox', { name: 'How to create the spatial plan', exact: true })
      .selectOption('manual');
  await page
    .getByLabel('Creative brief', { exact: true })
    .fill(
      'A quiet research library with two connected rooms, tables, shelves and a helpful archivist.',
    );
  await page.getByRole('button', { name: 'Save external generation project', exact: true }).click();
}
async function dispatch(page: Page, twice = false) {
  const planner = page.getByTestId('spatial-planner');
  await planner.getByRole('button', { name: 'Estimate one plan request', exact: true }).click();
  await expect(planner.getByTestId('spatial-quote')).toBeVisible();
  const send = planner.getByRole('button', { name: 'Request one AI proposal', exact: true });
  await expect(send).toBeDisabled();
  await planner.getByLabel(/I approve one external text request using the saved brief/).check();
  if (twice) await send.dblclick();
  else await send.click();
}
test('AI location description produces an inert validated proposal before author apply and dynamic-map editing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await account(page);
  const mock = await fixtures(page);
  await create(page, mock.adventureId);
  const planner = page.getByTestId('spatial-planner'),
    approve = page.getByRole('button', { name: 'Approve this concept / plan', exact: true });
  await expect(planner).toBeVisible();
  await expect(approve).toBeDisabled();
  expect(mock.calls.dispatch).toBe(0);
  expect(mock.calls.imageRead).toBe(0);
  expect(mock.project.plan).toBeNull();
  await dispatch(page, true);
  const proposal = planner.getByTestId('spatial-proposal');
  await expect(proposal.getByText('Server validation passed', { exact: true })).toBeVisible();
  await expect(proposal.locator('canvas')).toBeVisible();
  await expect(approve).toBeDisabled();
  expect(mock.calls.apply).toBe(0);
  expect(mock.project.plan).toBeNull();
  expect(mock.calls.dispatch).toBe(1);
  await expect(page.getByTestId('live-test-panel')).toContainText('$0.735964');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await proposal.screenshot({
    path: test.info().outputPath('synthetic-ai-spatial-proposal-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await proposal.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({
    path: test.info().outputPath('synthetic-ai-spatial-proposal-mobile.png'),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const apply = proposal.getByRole('button', { name: 'Apply validated plan', exact: true });
  await expect(apply).toBeDisabled();
  await proposal.getByLabel(/I reviewed the rooms, entrances, exits/).check();
  await apply.click();
  await expect(approve).toBeEnabled();
  expect(mock.calls.apply).toBe(1);
  await page.getByRole('combobox', { name: 'Map to edit', exact: true }).selectOption('annex');
  await expect(page.getByRole('combobox', { name: 'Element', exact: true })).toHaveValue(
    'rare-shelf',
  );
  await expect(page.getByLabel('X coordinate', { exact: true })).toHaveAttribute('max', '9');
  await expect(page.getByLabel('Y coordinate', { exact: true })).toHaveAttribute('max', '8');
  await page.getByLabel('Y coordinate', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Reposition selected element', exact: true }).click();
  await expect.poll(() => mock.calls.edit).toBe(1);
  expect(mock.edited).toMatchObject({
    mapId: 'annex',
    layerId: 'rare-shelf',
    point: { x: 6, y: 6 },
  });
  await approve.click();
  await expect(page.getByTestId('external-generation')).toBeVisible();
  expect(mock.calls.dispatch).toBe(1);
  expect(mock.calls.unexpected).toBe(0);
});
for (const mode of ['unknown', 'invalid'] as const)
  test(`planner ${mode} outcome preserves state and never creates another paid attempt`, async ({
    page,
  }) => {
    await account(page);
    const mock = await fixtures(page, mode);
    await create(page, mock.adventureId);
    await dispatch(page);
    const planner = page.getByTestId('spatial-planner'),
      expectedCode = mode === 'unknown' ? 'PROVIDER_HTTP_403' : 'SPATIAL_PLAN_INVALID';
    await expect(planner.getByText(expectedCode, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve this concept / plan', exact: true }),
    ).toBeDisabled();
    await expect(
      planner.getByRole('button', { name: 'Estimate one plan request', exact: true }),
    ).toBeDisabled();
    await expect(
      planner.getByRole('button', { name: 'Apply validated plan', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(planner.getByText(expectedCode, { exact: true })).toBeVisible();
    await planner.getByRole('button', { name: 'Refresh plan status', exact: true }).click();
    expect(mock.calls.dispatch).toBe(1);
    expect(mock.calls.apply).toBe(0);
    expect(mock.project.plan).toBeNull();
    expect(mock.calls.unexpected).toBe(0);
  });
test('queued planning can be cancelled without retry or fallback after reload', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page, 'queued');
  await create(page, mock.adventureId);
  await dispatch(page);
  const planner = page.getByTestId('spatial-planner');
  await planner.getByRole('button', { name: 'Request planning cancellation', exact: true }).click();
  await expect(planner.getByText('Planning cancelled', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    planner.getByRole('button', { name: 'Estimate one plan request', exact: true }),
  ).toBeDisabled();
  expect(mock.calls.cancel).toBe(1);
  expect(mock.calls.dispatch).toBe(1);
  expect(mock.project.plan).toBeNull();
  expect(mock.calls.unexpected).toBe(0);
});
test('a validated proposal with a stale source cannot be applied', async ({ page }) => {
  await account(page);
  const mock = await fixtures(page, 'stale');
  await create(page, mock.adventureId);
  await dispatch(page);
  const proposal = page.getByTestId('spatial-proposal');
  await expect(
    proposal.getByText(
      'The brief or project changed. Estimate a new request against the current saved version.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(proposal.getByLabel(/I reviewed the rooms, entrances, exits/)).toBeDisabled();
  await expect(
    proposal.getByRole('button', { name: 'Apply validated plan', exact: true }),
  ).toBeDisabled();
  expect(mock.calls.apply).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('lost dispatch response is reconciled by a read without a second paid request', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page, 'response-lost');
  await create(page, mock.adventureId);
  await dispatch(page);
  const planner = page.getByTestId('spatial-planner');
  await expect(
    planner.getByText(
      'The outcome or charge is unknown. The reservation remains; no new request is sent. Refresh status.',
      { exact: true },
    ),
  ).toBeVisible();
  await planner.getByRole('button', { name: 'Refresh plan status', exact: true }).click();
  await expect(planner.getByTestId('spatial-proposal')).toBeVisible();
  expect(mock.calls.dispatch).toBe(1);
  expect(mock.calls.apply).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});
test('manual template remains an explicit free choice and never requests an AI plan', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page, 'manual');
  await create(page, mock.adventureId, true);
  await expect(page.getByTestId('spatial-planner')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Approve this concept / plan', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/The plan is an editable template, not AI output/)).toBeVisible();
  expect(mock.calls.quote).toBe(0);
  expect(mock.calls.dispatch).toBe(0);
  expect(mock.calls.unexpected).toBe(0);
});

test('proposal summary shows every room position and public NPC profile without leaking private facts', async ({
  page,
}) => {
  await account(page);
  const mock = await fixtures(page);
  await create(page, mock.adventureId);
  await dispatch(page);
  expect(mock.npcProjected).toBe(false);
  const summary = page.getByTestId('spatial-public-summary');
  await summary.locator('summary').click();
  await expect(summary.getByText('Hana the archivist', { exact: true })).toBeVisible();
  await expect(
    summary.getByText('Keeps the herb index in the annex.', { exact: true }),
  ).toBeVisible();
  await expect(summary.getByText('Blue robe and spectacles.', { exact: true })).toBeVisible();
  await expect(summary).toContainText('Herb annex (6, 3)');
  await expect(summary).toContainText('Entry positions');
  await expect(page.getByText('SPATIAL_PRIVATE_NPC_CANARY', { exact: true })).toHaveCount(0);
  await expect(page.getByText('SPATIAL_PRIVATE_TITLE', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await summary.screenshot({
    path: test.info().outputPath('synthetic-ai-spatial-public-summary.png'),
  });
  expect(mock.calls.apply).toBe(0);
  expect(mock.calls.dispatch).toBe(1);
  expect(mock.calls.unexpected).toBe(0);
});
