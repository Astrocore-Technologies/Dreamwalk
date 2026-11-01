import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { VisualPackage, GameProjection } from '@dreamwalk/contracts';

async function api(page: Page, path: string, data?: unknown, method = 'POST') {
  const response =
    data === undefined
      ? await page.request.get(`/api/v1${path}`)
      : await page.request.fetch(`/api/v1${path}`, { method, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}
async function account(page: Page) {
  const handle = `visual_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await api(page, '/auth/register', {
    handle,
    email: `${handle}@example.test`,
    name: 'Visual QA',
    password: `Visual-${randomUUID()}!`,
  });
  await api(page, '/account/settings', { language: 'en' }, 'PATCH');
  await api(page, '/account/onboarding', {
    name: 'Visual QA',
    genres: [],
    purpose: 'both',
    profilePublic: false,
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
}
async function clickCell(page: Page, x: number, y: number) {
  const host = page.locator('[data-camera-x]').first();
  await expect(host.locator('canvas')).toBeVisible();
  const x0 = Number(await host.getAttribute('data-camera-x')),
    y0 = Number(await host.getAttribute('data-camera-y')),
    scale = Number(await host.getAttribute('data-camera-scale'));
  await host
    .locator('canvas')
    .click({ position: { x: x0 + (x + 0.5) * 48 * scale, y: y0 + (y + 0.5) * 48 * scale } });
}
async function equipPackage(page: Page) {
  const equipped = page.waitForResponse(
    (r) =>
      r.url().includes('/visual-authoring/packages/') &&
      r.url().endsWith('/equip') &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Use for character', exact: true }).click();
  expect((await equipped).ok()).toBeTruthy();
}
async function approveAndComplete(page: Page): Promise<VisualPackage> {
  await page.getByRole('button', { name: 'Approve this concept / plan', exact: true }).click();
  await expect(
    page.getByText('Concept approved. Portrait and animations are not ready yet.', { exact: true }),
  ).toBeVisible();
  const completed = page.waitForResponse(
    (r) =>
      r.url().includes('/visual-authoring/projects/') &&
      r.url().endsWith('/complete') &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Assemble package · free', exact: true }).click();
  const response = await completed;
  expect(response.ok()).toBeTruthy();
  const pack = await response.json();
  expect(pack.providerCalls).toBe(0);
  expect(pack.chargeMicros).toBe(0);
  return pack;
}

test('drawn character concept becomes a reusable animated hero and author NPC package', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await account(page);
  const name = `Lyra ${randomUUID().slice(0, 6)}`,
    hero = await api(page, '/heroes', { name }),
    npc = await api(page, '/npcs', { name: 'Mira visual QA', description: 'A calm alchemist.' });
  let creates = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/visual-authoring/projects')) creates++;
  });
  await page.goto(`/studio/visuals?heroId=${hero.id}`);
  await expect(page.getByRole('heading', { name: 'Visual workshop', exact: true })).toBeVisible();
  await expect(page.getByText(/this sample is not AI-generated/)).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page
    .getByLabel('Creative brief', { exact: true })
    .fill('An adult copper-haired traveler in an emerald cloak and leather boots.');
  await page.getByRole('button', { name: 'Prepare sample · free', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '1 · Full-body concept approval', exact: true }),
  ).toBeVisible();
  const concept = page.getByRole('img', { name, exact: true });
  await expect(concept).toBeVisible();
  await expect
    .poll(() => concept.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await concept.screenshot({ path: test.info().outputPath('character-full-body-concept.png') });
  const pack = await approveAndComplete(page);
  expect(pack.parts.map((p) => p.role)).toEqual(['concept', 'portrait', 'sheet']);
  const motion = page.getByRole('img', { name: '4 directions · idle and walk', exact: true });
  await expect(motion).toBeVisible();
  const initial = await motion.evaluate(
    (element) => (element as HTMLElement).style.backgroundPosition,
  );
  await expect
    .poll(() => motion.evaluate((element) => (element as HTMLElement).style.backgroundPosition))
    .not.toBe(initial);
  await page.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('2');
  await motion.screenshot({ path: test.info().outputPath('character-walk-east.png') });
  await page.getByRole('button', { name: 'Idle', exact: true }).click();
  await page.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('0');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: test.info().outputPath('character-desktop.png'), fullPage: false });
  await equipPackage(page);
  await expect(
    page.getByText('Saved for new campaigns. Existing versions keep their pinned package.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await api(page, '/heroes')).find((h: { id: string }) => h.id === hero.id)
      .characterPackageVersionId,
  ).toBe(pack.id);
  await page.getByRole('combobox', { name: 'Use for', exact: true }).selectOption('npc');
  await page.getByRole('combobox', { name: 'Use for character', exact: true }).selectOption(npc.id);
  await equipPackage(page);
  expect((await api(page, `/npcs/${npc.id}`)).characterPackageVersionId).toBe(pack.id);
  await page.reload();
  await page
    .getByRole('article')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Select', exact: true })
    .click();
  await expect(motion).toBeVisible();
  expect(creates).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await motion.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: test.info().outputPath('character-mobile.png'), fullPage: false });
});

test('location plan is editable, engine preview walks and opens a door, and explicit apply reuses it', async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await account(page);
  const story = await api(page, '/studio/adventures', {
    title: 'Rainlight visual QA',
    content: {
      world: 'A city of rain and glass.',
      rules: 'Use only confirmed doors and objects.',
      locations: [],
      npcIds: [],
      scenes: [],
      startSceneId: '',
      boundaries: [],
    },
  });
  await page.goto(`/studio/visuals?adventureId=${story.id}`);
  await page
    .getByLabel('Creative brief', { exact: true })
    .fill(
      'A rainlit alchemist atelier, warm worktables, shelves and a glass door to the journal room.',
    );
  await page.getByRole('button', { name: 'Prepare sample · free', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '1 · Spatial plan and reachability', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Element', { exact: true }).selectOption('worktable');
  await page.getByLabel('Y coordinate', { exact: true }).fill('5');
  await page.getByLabel('Element artwork', { exact: true }).selectOption('counter');
  const edited = page.waitForResponse(
    (r) => r.url().endsWith('/layers') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Reposition selected element', exact: true }).click();
  expect((await edited).ok()).toBeTruthy();
  const pack = await approveAndComplete(page);
  expect(pack.kind).toBe('location');
  await expect(page.getByText(/2 · Walk in the engine/)).toBeVisible();
  const host = page.locator('[data-art-loaded]').first();
  await expect
    .poll(async () => Number(await host.getAttribute('data-art-loaded')))
    .toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await host.screenshot({ path: test.info().outputPath('location-layered-desktop.png') });
  const project = (await api(page, '/visual-authoring/projects')).find(
    (p: { id: string }) => p.id === pack.projectId,
  );
  expect(
    project.plan.maps[0].composition.layers.find((l: { id: string }) => l.id === 'worktable'),
  ).toMatchObject({ y: 5, visual: 'counter' });
  const beforePreview = page.waitForResponse(
    (r) => r.url().endsWith('/preview') && r.request().method() === 'POST',
  );
  await clickCell(page, 13, 5);
  const walked = await beforePreview;
  expect(walked.ok()).toBeTruthy();
  const walkedResult = await walked.json();
  expect(
    walkedResult.projection.entities.find(
      (e: { id: string }) => e.id === walkedResult.projection.actorId,
    ),
  ).toMatchObject({ x: 13, y: 5 });
  await expect(page.getByRole('button', { name: 'Open door', exact: true })).toBeEnabled();
  const opened = page.waitForResponse(
    (r) => r.url().endsWith('/preview') && r.request().postDataJSON()?.action?.kind === 'open',
  );
  await page.getByRole('button', { name: 'Open door', exact: true }).click();
  expect((await opened).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Close door', exact: true })).toBeVisible();
  await host.screenshot({ path: test.info().outputPath('location-door-open.png') });
  await page
    .getByLabel('Replace this story’s playable draft with this package', { exact: true })
    .check();
  const applied = page.waitForResponse(
    (r) => r.url().endsWith('/apply') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Apply to story', exact: true }).click();
  expect((await applied).ok()).toBeTruthy();
  const saved = await api(page, `/studio/adventures/${story.id}/playable-draft`);
  expect(saved.draft.maps[0].composition.layers).toHaveLength(5);
  const art = await api(page, `/asset-library/stories/${story.id}/draft`);
  expect(art.bindings.some((b: { slot: string }) => b.slot.includes(':layer:'))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.screenshot({ path: test.info().outputPath('location-layered-mobile.png') });
  const heroProject = await api(page, '/visual-authoring/projects', {
    kind: 'character',
    operationId: randomUUID(),
    brief: {
      name: 'Lyra preview',
      description: 'An adult copper-haired traveler in a green cloak.',
      outfit: 'Cloak and boots',
      appearance: 'Copper hair',
      style: 'drawn2D',
      source: 'text',
      allowOutputReuse: false,
    },
  });
  const approved = await api(page, `/visual-authoring/projects/${heroProject.id}/approve`, {
    operationId: randomUUID(),
    expectedRevision: heroProject.revision,
    consent: true,
  });
  const heroPack: VisualPackage = await api(
    page,
    `/visual-authoring/projects/${heroProject.id}/complete`,
    { operationId: randomUUID(), expectedRevision: approved.revision, consent: true },
  );
  const hero = await api(page, '/heroes', { name: 'Lyra preview' });
  await api(page, `/visual-authoring/packages/${heroPack.id}/equip`, {
    operationId: randomUUID(),
    heroId: hero.id,
  });
  const version = await api(page, `/studio/adventures/${story.id}/playable-versions`, {
    expectedRevision: saved.revision,
    expectedArtRevision: art.revision,
  });
  const campaign = await api(page, '/game/campaigns', {
    playableVersionId: version.versionId,
    heroId: hero.id,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/game/${campaign.campaignId}`);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  const gameHost = page.locator('[data-art-loaded]').first();
  await expect
    .poll(async () => Number(await gameHost.getAttribute('data-art-loaded')))
    .toBeGreaterThan(5);
  const initial: GameProjection = (
    await api(page, `/game/campaigns/${campaign.campaignId}/snapshot`)
  ).projection;
  const actor = initial.entities.find((e) => e.id === initial.actorId)!;
  await clickCell(page, actor.x + 1, actor.y);
  await expect(page.getByTestId('game-position')).toHaveAttribute('data-x', String(actor.x + 1));
  await gameHost.screenshot({ path: test.info().outputPath('playable-location-walking-hero.png') });
  await gameHost.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({
    path: test.info().outputPath('playable-location-desktop-viewport.png'),
    fullPage: false,
  });
  await page.reload();
  const restored: GameProjection = (
    await api(page, `/game/campaigns/${campaign.campaignId}/snapshot`)
  ).projection;
  expect(restored.map.composition?.layers).toHaveLength(5);
  expect(restored.entities.find((e) => e.id === restored.actorId)?.characterAnimation?.rows).toBe(
    4,
  );
  await expect
    .poll(async () => Number(await gameHost.getAttribute('data-art-loaded')))
    .toBeGreaterThan(5);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await gameHost.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({
    path: test.info().outputPath('playable-location-mobile-viewport.png'),
    fullPage: false,
  });
  await gameHost.screenshot({ path: test.info().outputPath('playable-location-mobile-scene.png') });
});

test('photo reference requires separate permission and cancel leaves it private', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await account(page);
  await page.goto('/studio/visuals');
  await page.getByRole('combobox', { name: 'Character', exact: true }).selectOption('photo');
  await expect(
    page.getByRole('button', { name: 'Prepare sample · free', exact: true }),
  ).toBeDisabled();
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 4, background: '#88aa99' },
  })
    .png()
    .toBuffer();
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/assets') && r.request().method() === 'POST',
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'synthetic-reference.png', mimeType: 'image/png', buffer: bytes });
  const photoId = (await (await uploaded).json()).id;
  await expect(page.getByText(/The photo stays private/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Prepare sample · free', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('I have permission to use this photo to create my character.', { exact: true })
    .check();
  await expect(
    page.getByLabel('Allow me to grant output reuse later. No access is granted automatically.', {
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Prepare sample · free', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Approve this concept / plan', exact: true }),
  ).toHaveCount(0);
  const foreignContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const foreign = await foreignContext.newPage();
    await account(foreign);
    expect((await foreign.request.get(`/api/v1/assets/${photoId}/file`)).status()).toBe(404);
  } finally {
    await foreignContext.close();
  }
});
