import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { gameEnvelopeSchema, type GameEntity } from '@dreamwalk/contracts';
import { authoringRequest } from './support/private-authoring';

test('legacy location-only save remains read-only with original image and history', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  expect(
    (
      await page.request.post('/api/v1/auth/register', {
        data: {
          email: `scene-${suffix}@example.test`,
          handle: `scene_${suffix}`,
          name: 'Scene QA',
          password: `Scene-${randomUUID()}!`,
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (await page.request.patch('/api/v1/account/settings', { data: { language: 'en' } })).ok(),
  ).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#7895ab' },
  })
    .png()
    .toBuffer();
  const uploaded = await page.request.post('/api/v1/assets', {
    multipart: {
      file: { name: 'location.png', mimeType: 'image/png', buffer: png },
    },
  });
  expect(uploaded.status()).toBe(201);
  const upload = await uploaded.json();
  const original = await authoringRequest(page, '/asset-library/revisions', {
    operationId: randomUUID(),
    uploadId: upload.id,
    metadata: {
      title: 'Synthetic scene fixture',
      kind: 'background',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['courtyard'],
      variant: 'day',
      provenance: { source: 'upload', reference: 'Synthetic CI fixture' },
      rights: {
        basis: 'owned',
        licenseLabel: 'Test only',
        attribution: 'Synthetic scene fixture',
        allowAuthorReuse: false,
        attested: true,
      },
    },
  });
  // Only the browser receives a legacy snapshot. Never downgrade a saved campaign
  // or attempt a newly forbidden location-only launch to manufacture the fixture.
  const campaign = await authoringRequest(page, '/game/campaigns', {
    template: 'observatory-v1',
    turnBased: true,
  });
  const id = campaign.campaignId;
  const snapshot = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  const mapId = snapshot.projection.map.id;
  snapshot.projection.map = {
    ...snapshot.projection.map,
    spatialMode: 'location_only',
    spawns: [],
    blocked: [],
    exits: [],
    scenePresence: {
      version: 1,
      entrySceneId: 'opening',
      scenes: [
        {
          id: 'opening',
          participantIds: ['keeper'],
          evidence: { kind: 'authored_scene', reference: 'opening' },
        },
      ],
    },
  };
  delete snapshot.projection.map.composition;
  delete snapshot.projection.map.spatialGrounding;
  snapshot.projection.entities = snapshot.projection.entities
    .filter((entity: GameEntity) => entity.kind === 'player' || entity.id === 'keeper')
    .map((entity: GameEntity) => {
      const { x: _x, y: _y, patrolTarget: _patrol, ...saved } = entity;
      return { ...saved, spatialMode: 'location_only', sceneId: 'opening' };
    });
  const art = {
    slot: `map:${mapId}:background`,
    revisionId: original.id,
    sha256: original.sha256,
    mime: 'image/png',
    width: 1200,
    height: 800,
    url: `/api/v1/asset-library/revisions/${original.id}/file`,
    attribution: 'Synthetic scene fixture',
    licenseLabel: 'Test only',
  };
  snapshot.projection.artBindings = [
    { slot: art.slot, revisionId: original.id, sha256: original.sha256 },
  ];
  gameEnvelopeSchema.parse(snapshot);
  const savedSnapshot = JSON.stringify(snapshot);
  const feed = await authoringRequest(page, `/game/campaigns/${id}/turns/feed`);
  feed.entries = [
    {
      id: 'saved-story',
      ordinal: 1,
      sequence: 1,
      tick: 1,
      createdAt: null,
      kind: 'npc_reply',
      channel: 'say',
      authorLabel: 'Keeper',
      text: 'Saved story: we remain beside the sofa.',
    },
  ];
  await page.route(`**/api/v1/game/campaigns/${id}/snapshot`, (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.route(`**/api/v1/game/campaigns/${id}/turns/feed`, (route) =>
    route.fulfill({ json: feed }),
  );
  await page.route(`**/api/v1/asset-library/campaigns/${id}/manifest`, (route) =>
    route.fulfill({ json: { bindings: [art] } }),
  );
  const writes: string[] = [];
  const sockets: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.includes(`/campaigns/${id}`))
      writes.push(request.url());
  });
  await page.routeWebSocket('**/api/v1/game/socket**', (socket) => {
    sockets.push(socket.url());
    socket.close();
  });
  await page.goto(`/game/${id}`);
  const scene = page.getByTestId('location-only-scene');
  const image = page.getByTestId('location-map-image');
  await expect(scene).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(image).toBeVisible();
  const originalUrl = await image.getAttribute('src');
  expect(originalUrl).toContain(original.id);
  const originalFile = await page.request.get(originalUrl!);
  expect(originalFile.ok()).toBe(true);
  expect(
    createHash('sha256')
      .update(await originalFile.body())
      .digest('hex'),
  ).toBe(original.sha256);
  await expect(scene.locator('[data-scene-participant="keeper"]')).toBeVisible();
  await expect(scene.locator('[data-scene-participant="hidden"]')).toHaveCount(0);
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const img = element as HTMLImageElement;
          const rect = img.getBoundingClientRect();
          return (
            img.naturalWidth === 1200 &&
            img.naturalHeight === 800 &&
            Math.abs(rect.width / rect.height - 1.5) < 0.01
          );
        }),
      )
      .toBe(true);
    await expect(scene.locator('canvas, [data-coordinate-x], [data-coordinate-y]')).toHaveCount(0);
    await expect(page.getByTestId('map-coordinate-readout')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approach', exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId('map-grid-recovery-required')).toContainText('Game paused');
  await expect(page.getByTestId('story-feed')).toContainText(
    'Saved story: we remain beside the sofa.',
  );
  await image.click();
  await scene.getByRole('button', { name: /^Inventory/ }).click();
  const inventory = scene.getByRole('dialog', { name: 'Inventory', exact: true });
  await expect(inventory).toBeVisible();
  await inventory.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    scene
      .locator('[data-scene-participant="keeper"]')
      .getByRole('button', { name: 'Say', exact: true }),
  ).toBeDisabled();
  const composer = page.getByTestId('unified-story');
  await expect(composer.locator('textarea')).toBeDisabled();
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'End turn', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(sockets).toEqual([]);
  expect(JSON.stringify(snapshot)).toBe(savedSnapshot);
  await info.attach('location-only-map', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.reload();
  await expect(scene).toBeVisible();
  await expect(image).toHaveAttribute('src', originalUrl!);
  await expect(scene.locator('[data-scene-participant="hidden"]')).toHaveCount(0);
  await expect(scene.locator('canvas')).toHaveCount(0);
  await expect(page.getByTestId('map-grid-recovery-required')).toBeVisible();
  await expect(page.getByTestId('story-feed')).toContainText(
    'Saved story: we remain beside the sofa.',
  );
  await expect(composer.locator('textarea')).toBeDisabled();
  expect(writes).toEqual([]);
  expect(sockets).toEqual([]);
  expect(JSON.stringify(snapshot)).toBe(savedSnapshot);
});
