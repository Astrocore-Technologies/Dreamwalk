import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import {
  authoringRequest,
  savePrivateFixture,
  launchPrivateFixture,
} from './support/private-authoring';

test('location-only RP preserves the full image and public scene without coordinate controls', async ({
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
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const story = await authoringRequest(page, '/studio/adventures', { title: `Scene ${suffix}` });
  const draft = createAuthoredDraft('courtyard');
  delete draft.turnRules;
  draft.maps = [
    {
      ...draft.maps[0],
      spatialMode: 'location_only',
      blocked: [],
      spawns: [],
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
          {
            id: 'elsewhere',
            participantIds: ['hidden'],
            evidence: { kind: 'authored_scene', reference: 'elsewhere' },
          },
        ],
      },
    },
  ];
  draft.objects = [];
  const { x: _x, y: _y, patrolTarget: _patrol, ...keeper } = draft.npcs[0];
  draft.npcs = [
    { ...keeper, spatialMode: 'location_only', sceneId: 'opening' },
    {
      ...keeper,
      id: 'hidden',
      label: 'Hidden stranger',
      spatialMode: 'location_only',
      sceneId: 'elsewhere',
    },
  ];
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
  draft.maps[0].locationImage = { revisionId: original.id, sha256: original.sha256 };
  await savePrivateFixture(page, story.id, draft);
  const priorArt = await authoringRequest(page, `/asset-library/stories/${story.id}/draft`);
  await authoringRequest(
    page,
    `/asset-library/stories/${story.id}/draft`,
    {
      operationId: randomUUID(),
      expectedRevision: priorArt.revision,
      bindings: [{ slot: 'map:courtyard:background', revisionId: original.id }],
    },
    'PUT',
  );
  const id = await launchPrivateFixture(page, story.id, true);
  const scene = page.getByTestId('location-only-scene');
  const image = page.getByTestId('location-map-image');
  await expect(scene).toBeVisible();
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
  const numericRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(move|stop|approach)$/.test(new URL(request.url()).pathname)
    )
      numericRequests.push(request.url());
  });
  await image.click();
  await scene.getByRole('button', { name: /^Inventory/ }).click();
  const inventory = scene.getByRole('dialog', { name: 'Inventory', exact: true });
  await expect(inventory).toBeVisible();
  await inventory.getByRole('button', { name: 'Close', exact: true }).click();
  await scene
    .locator('[data-scene-participant="keeper"]')
    .getByRole('button', { name: 'Say', exact: true })
    .click();
  await expect(page.getByTestId('unified-story').locator('textarea')).toBeVisible();
  const composer = page.getByTestId('unified-story');
  await composer.locator('textarea').fill('Hello, Keeper. I look around the courtyard.');
  await composer.locator('textarea').press('ArrowLeft');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.locator('textarea')).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ended = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/game/campaigns/${id}/commands`) &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.type === 'turn.end',
  );
  await page.getByRole('button', { name: 'End turn', exact: true }).click();
  const endedResponse = await ended;
  expect(endedResponse.ok()).toBe(true);
  expect((await endedResponse.json()).status).not.toBe('rejected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(numericRequests).toEqual([]);
  const snapshot = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  expect(snapshot.projection.map.spatialMode).toBe('location_only');
  for (const entity of snapshot.projection.entities) {
    expect(entity).not.toHaveProperty('x');
    expect(entity).not.toHaveProperty('y');
  }
  await info.attach('location-only-map', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.reload();
  await expect(scene).toBeVisible();
  await expect(image).toHaveAttribute('src', originalUrl!);
  await expect(scene.locator('[data-scene-participant="hidden"]')).toHaveCount(0);
  await expect(scene.locator('canvas')).toHaveCount(0);
});
