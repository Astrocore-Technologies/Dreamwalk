import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import {
  authoringRequest,
  savePrivateFixture,
  launchPrivateFixture,
} from './support/private-authoring';

test.use({ hasTouch: true });

test('map coordinates stay legible and cell-aligned on mobile, zoom and resize without intercepting input', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 700 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `coordinates-${suffix}@example.test`,
      handle: `coords_${suffix}`,
      name: 'Coordinate QA',
      password: `Coordinates-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  const story = await authoringRequest(page, '/studio/adventures', {
    title: `Coordinates ${suffix}`,
  });
  const draft = createAuthoredDraft('courtyard');
  delete draft.turnRules;
  await savePrivateFixture(page, story.id, draft);
  const id = await launchPrivateFixture(page, story.id, false);
  const host = page.locator('[data-renderer-active]');
  const readout = page.getByTestId('map-coordinate-readout');
  const map = page.getByRole('group', { name: 'Карта приключения', exact: true });
  const inventoryToggle = map.getByRole('button', { name: /^Инвентарь/ });
  const inventory = map.getByRole('dialog', { name: 'Инвентарь', exact: true });
  await host.scrollIntoViewIfNeeded();
  await expect(host).toHaveAttribute('data-renderer-active', 'true');
  const before = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  const actor = before.projection.entities.find(
    (entity: { id: string }) => entity.id === before.projection.actorId,
  )!;
  await expect(readout).toHaveAttribute('data-x', String(actor.x));
  await expect(readout).toHaveAttribute('data-y', String(actor.y));

  const verifyRulers = async () => {
    await expect
      .poll(() =>
        host.evaluate((element) => {
          const node = element as HTMLElement;
          const surface = node.parentElement!;
          let labels = 0;
          let error = 0;
          let smallestFont = Infinity;
          let spacing = Infinity;
          for (const axis of ['x', 'y'] as const) {
            let previous: number | undefined;
            for (const label of surface.querySelectorAll<HTMLElement>(
              `[data-coordinate-${axis}]:not([hidden])`,
            )) {
              const value = Number(label.dataset[axis === 'x' ? 'coordinateX' : 'coordinateY']);
              const position = parseFloat(label.style[axis === 'x' ? 'left' : 'top']);
              const expected =
                Number(node.dataset[axis === 'x' ? 'cameraX' : 'cameraY']) +
                (value + 0.5) * 48 * Number(node.dataset.cameraScale);
              error = Math.max(error, Math.abs(position - expected));
              if (label.dataset.labeled !== 'true') continue;
              labels++;
              smallestFont = Math.min(smallestFont, parseFloat(getComputedStyle(label).fontSize));
              if (previous !== undefined) spacing = Math.min(spacing, position - previous);
              previous = position;
            }
          }
          return labels > 4 && error < 0.6 && smallestFont >= 11 && spacing >= 25.9;
        }),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  };

  const cellPoint = (x: number, y: number) =>
    host.evaluate(
      (element, point) => {
        const node = element as HTMLElement;
        const bounds = node.getBoundingClientRect();
        return {
          x:
            bounds.left +
            Number(node.dataset.cameraX) +
            (point.x + 0.5) * 48 * Number(node.dataset.cameraScale),
          y:
            bounds.top +
            Number(node.dataset.cameraY) +
            (point.y + 0.5) * 48 * Number(node.dataset.cameraScale),
        };
      },
      { x, y },
    );

  await verifyRulers();
  // At mobile fit, (2,3) lies under the inventory toolbar. A Pixi hover alone
  // does not prove a canvas hit: Pixi also observes document pointer movement.
  const target = { x: 7, y: 12 };
  const point = await cellPoint(target.x, target.y);
  expect(
    await host.evaluate(
      (element, point) =>
        document.elementFromPoint(point.x, point.y) === element.querySelector('canvas'),
      point,
    ),
    'The touch target must hit the canvas, not an overlaid control',
  ).toBe(true);
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(point.x, point.y);
  await expect(readout).toHaveAttribute('data-x', String(target.x));
  await expect(readout).toHaveAttribute('data-y', String(target.y));
  await page.touchscreen.tap(point.x, point.y);
  await expect(readout).toHaveAttribute('data-x', String(target.x));
  await expect(readout).toHaveAttribute('data-y', String(target.y));
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inventory).toHaveCount(0);

  await page.getByRole('button', { name: 'Увеличить карту', exact: true }).click();
  await expect(host).toHaveAttribute('data-camera-zoom', '1.200');
  await verifyRulers();
  await testInfo.attach('coordinates-mobile-zoom', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await host.scrollIntoViewIfNeeded();
  await verifyRulers();
  await expect(host).toHaveAttribute('data-camera-zoom', '1.200');
  await page.getByRole('button', { name: 'Центрировать камеру', exact: true }).click();
  await expect(host).toHaveAttribute('data-camera-zoom', '1.000');
  await verifyRulers();
  await testInfo.attach('coordinates-desktop-fit', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // Rulers never become another toolbar/menu or a pointer interception layer.
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'false');
  await inventoryToggle.click();
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(inventory).toBeVisible();
  await inventory.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(inventory).toHaveCount(0);
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inventoryToggle).toBeFocused();
  await inventoryToggle.click();
  await expect(inventory).toBeVisible();
  await inventory.press('Escape');
  await expect(inventory).toHaveCount(0);
  await expect(inventoryToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(inventoryToggle).toBeFocused();
  await expect(page.locator('[data-coordinate-x]')).toHaveCount(before.projection.map.width);
  await expect(page.locator('[data-coordinate-y]')).toHaveCount(before.projection.map.height);
});
