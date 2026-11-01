import { expect, type Page } from '@playwright/test';
import type { GameProjection } from '@dreamwalk/contracts';
import { entityLayout } from '../../../apps/web/components/game/scene-geometry';
export async function readProjection(page: Page, campaignId: string): Promise<GameProjection> {
  const response = await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).projection;
}
export async function position(page: Page, campaignId: string) {
  const projection = await readProjection(page, campaignId);
  const actor = projection.entities.find((entity) => entity.id === projection.actorId)!;
  return [actor.x, actor.y];
}
export async function mapMenu(page: Page, campaignId: string, id: string, exit = false) {
  const projection = await readProjection(page, campaignId);
  const target = exit
    ? projection.map.exits.find((e) => e.id === id)
    : projection.entities.find((e) => e.id === id);
  expect(target, `Visible map target ${id} must exist`).toBeTruthy();
  const canvas = page.locator('[data-camera-scale]');
  await expect(canvas).toHaveAttribute('data-camera-scale', /[0-9]/);
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const camera = await canvas.evaluate((element) => ({
    x: Number((element as HTMLElement).dataset.cameraX),
    y: Number((element as HTMLElement).dataset.cameraY),
    scale: Number((element as HTMLElement).dataset.cameraScale),
  }));
  const layout = exit
    ? { x: target!.x * 48, y: target!.y * 48, width: 48, height: 48 }
    : entityLayout(
        projection.entities.find((entity) => entity.id === id)!,
        projection.entities,
      );
  await page.mouse.click(
    box.x + camera.x + (layout.x + layout.width / 2) * camera.scale,
    box.y + camera.y + (layout.y + layout.height / 2) * camera.scale,
    { button: 'right' },
  );
  const menu = page.getByRole('dialog', { name: 'Действия', exact: true });
  await expect(menu).toBeVisible();
  if (!exit) await expect(menu.locator(`[data-map-target="${id}"]`)).toBeVisible();
  return exit ? menu : menu.locator(`[data-map-target="${id}"]`);
}
export async function inventory(page: Page, english = false) {
  const name = english ? 'Inventory' : 'Инвентарь';
  const panel = page.getByRole('dialog', { name, exact: true });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(panel).toBeVisible();
  return panel;
}
export async function closeInventory(page: Page) {
  await page
    .getByRole('dialog', { name: 'Инвентарь', exact: true })
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
}

// Retain legacy free-running journeys separately from current turn-based launch coverage.
export async function legacyRealtimeLaunch(page: Page) {
  await page.route('**/api/v1/game/campaigns', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.continue({
      postData: JSON.stringify({ ...route.request().postDataJSON(), turnBased: false }),
    });
  });
}
export async function approachTarget(page: Page, campaignId: string, id: string, exit = false) {
  const menu = await mapMenu(page, campaignId, id, exit);
  const approach = menu.getByRole('button', { name: 'Подойти', exact: true });
  if (await approach.count()) await approach.click();
  else
    await page
      .getByRole('dialog', { name: 'Действия', exact: true })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();
  await expect
    .poll(async () => {
      const p = await readProjection(page, campaignId),
        actor = p.entities.find((e) => e.id === p.actorId)!;
      const target = exit
        ? p.map.exits.find((e) => e.id === id)!
        : p.entities.find((e) => e.id === id)!;
      return Math.abs(actor.x - target.x) + Math.abs(actor.y - target.y);
    })
    .toBeLessThanOrEqual(1);
}
export async function mapAction(
  page: Page,
  campaignId: string,
  id: string,
  name: string,
  exit = false,
) {
  await (
    await mapMenu(page, campaignId, id, exit)
  )
    .getByRole('button', { name, exact: true })
    .click();
}
