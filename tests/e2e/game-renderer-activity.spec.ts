import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import { mapCamera } from '../../apps/web/components/game/map-camera';
import {
  authoringRequest,
  savePrivateFixture,
  launchPrivateFixture,
} from './support/private-authoring';

// Real canvas/WebGL and real server movement: only account/story setup is synthetic.
// This does not substitute for the existing four-client completed-adventure journey.
test('offscreen renderer pauses without stopping shared state and resumes the same canvas at current geometry', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 600 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `renderer-${suffix}@example.test`,
      handle: `render_${suffix}`,
      name: 'Renderer QA',
      password: `Renderer-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  const story = await authoringRequest(page, '/studio/adventures', { title: `Renderer ${suffix}` });
  const draft = createAuthoredDraft('courtyard');
  delete draft.turnRules;
  await savePrivateFixture(page, story.id, draft);
  const id = await launchPrivateFixture(page, story.id, false);
  const host = page.locator('[data-renderer-active]');
  await host.scrollIntoViewIfNeeded();
  await expect(host).toHaveAttribute('data-renderer-active', 'true');
  await expect(page.locator('[data-connected]')).toHaveAttribute('data-connected', 'true');
  const canvas = await host.locator('canvas').elementHandle();
  expect(canvas).not.toBeNull();
  const before = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  const actor = before.projection.entities.find(
    (entity: { id: string }) => entity.id === before.projection.actorId,
  )!;

  // Leave a real sliver intersecting the viewport: partial visibility stays active.
  await host.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + rect.bottom - 24);
  });
  await expect
    .poll(() =>
      host.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top < 0 && rect.bottom > 0 && rect.bottom < innerHeight;
      }),
    )
    .toBe(true);
  await expect(host).toHaveAttribute('data-renderer-active', 'true');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(() => host.evaluate((element) => element.getBoundingClientRect().bottom <= 0))
    .toBe(true);
  await expect(host).toHaveAttribute('data-renderer-active', 'false');

  const target = { x: 4, y: 2 };
  expect({ x: actor.x, y: actor.y }).not.toEqual(target);
  const moved = await page.request.post(`/api/v1/game/campaigns/${id}/move`, {
    data: {
      connectionEpoch: before.connectionEpoch,
      inputSeq: (actor.lastInputSeq || 0) + 1,
      movementGeneration: actor.movementGeneration || 0,
      target,
    },
  });
  expect(moved.ok(), 'Known real API movement must succeed; no retry').toBeTruthy();
  await expect
    .poll(async () => {
      const snapshot = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
      const current = snapshot.projection.entities.find(
        (entity: { id: string }) => entity.id === snapshot.projection.actorId,
      )!;
      return {
        x: current.x,
        y: current.y,
        advanced: snapshot.projection.tick > before.projection.tick,
      };
    })
    .toEqual({ ...target, advanced: true });
  // Socket/UI state still receives changes even while its GPU rendering is paused.
  await expect(page.getByTestId('game-position')).toHaveAttribute('data-x', String(target.x));
  await expect(page.getByTestId('game-position')).toHaveAttribute('data-y', String(target.y));
  await expect(host).toHaveAttribute('data-renderer-active', 'false');

  await page.setViewportSize({ width: 520, height: 600 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(host).toHaveAttribute('data-renderer-active', 'false');
  await host.scrollIntoViewIfNeeded();
  await expect(host).toHaveAttribute('data-renderer-active', 'true');
  await expect(host).toHaveAttribute('data-rendered-map-id', before.projection.map.id);
  await expect(host).toHaveAttribute('data-rendered-actor-x', String(target.x));
  await expect(host).toHaveAttribute('data-rendered-actor-y', String(target.y));
  expect(
    await canvas!.evaluate(
      (element) =>
        element.isConnected && element === document.querySelector('[data-renderer-active] canvas'),
    ),
  ).toBe(true);
  await expect
    .poll(async () => {
      const geometry = await host.evaluate((element) => {
        const node = element as HTMLElement,
          rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          scale: Number(node.dataset.cameraScale),
          x: Number(node.dataset.cameraX),
          y: Number(node.dataset.cameraY),
        };
      });
      const camera = mapCamera({
        viewportWidth: geometry.width,
        viewportHeight: geometry.height,
        worldWidth: before.projection.map.width * 48,
        worldHeight: before.projection.map.height * 48,
        focusX: target.x * 48 + 24,
        focusY: target.y * 48 + 24,
      });
      return Math.max(
        Math.abs(geometry.scale - camera.scale),
        Math.abs(geometry.x - camera.x),
        Math.abs(geometry.y - camera.y),
      );
    })
    .toBeLessThan(0.01);
  await page.getByRole('link', { name: 'К кампаниям', exact: true }).click();
  await expect(host).toHaveCount(0);
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(false);
  await canvas!.dispose();
});
