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
  // One rendered DOM roundtrip: four live canvases make separate trace/actionability
  // snapshots expensive. This changes test observation cost, never simulation.
  const camera = await canvas.evaluate((element) => {
    let bounds = element.getBoundingClientRect();
    if (
      bounds.top < 0 ||
      bounds.left < 0 ||
      bounds.bottom > innerHeight ||
      bounds.right > innerWidth
    ) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      bounds = element.getBoundingClientRect();
    }
    const data = (element as HTMLElement).dataset;
    return {
      left: bounds.left,
      top: bounds.top,
      x: Number(data.cameraX),
      y: Number(data.cameraY),
      scale: Number(data.cameraScale),
    };
  });
  expect(camera.scale).toBeGreaterThan(0);
  const layout = exit
    ? { x: target!.x * 48, y: target!.y * 48, width: 48, height: 48 }
    : entityLayout(
        projection.entities.find((entity) => entity.id === id)!,
        projection.entities,
      );
  await page.mouse.click(
    camera.left + camera.x + (layout.x + layout.width / 2) * camera.scale,
    camera.top + camera.y + (layout.y + layout.height / 2) * camera.scale,
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
  const before = await readProjection(page, campaignId);
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
      expect(p.map.id, 'Approach must not transition maps').toBe(before.map.id);
      const target = exit
        ? p.map.exits.find((e) => e.id === id)!
        : p.entities.find((e) => e.id === id)!;
      expect(target?.id, 'Approach retains the intended visible target').toBe(id);
      return Math.abs(actor.x - target.x) + Math.abs(actor.y - target.y);
    })
    .toBeLessThanOrEqual(1);
}
type ExpectedCommand = {
  type: string;
  action?: { kind: string; targetId: string };
  npcId?: string;
  decision?: string;
};
/** Each repeat is a fresh visible user decision after a proven no-effect rejection.
 * Unknown outcomes, HTTP errors and other rejection codes are never retried. */
export async function reconfirmKnownStale(
  page: Page,
  campaignId: string,
  expected: ExpectedCommand,
  perform: () => Promise<void>,
  prepare?: () => Promise<void>,
) {
  const operations = new Set<string>();
  let intended: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const unexpectedStops: string[] = [];
    const watchStop = (request: import('@playwright/test').Request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/v1/game/campaigns/${campaignId}/stop`
      )
        unexpectedStops.push(request.url());
    };
    if (expected.type === 'action') page.on('request', watchStop);
    // UI readiness is a separate bounded phase. Do not consume the command's
    // existing response timeout while opening/observing a four-player canvas menu.
    try {
      await prepare?.();
    } catch (error) {
      page.off('request', watchStop);
      throw error;
    }
    let observedCommandResponse = false;
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      if (
        request.method() !== 'POST' ||
        new URL(response.url()).pathname !== `/api/v1/game/campaigns/${campaignId}/commands`
      )
        return false;
      const body = request.postDataJSON();
      const matches =
        body.type === expected.type &&
        (!expected.action ||
          (body.action?.kind === expected.action.kind &&
            body.action?.targetId === expected.action.targetId)) &&
        (!expected.npcId || body.npcId === expected.npcId) &&
        (!expected.decision || body.decision === expected.decision);
      if (matches) observedCommandResponse = true;
      return matches;
    });
    const refreshed = page.waitForResponse(
      (response) =>
        observedCommandResponse &&
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/v1/game/campaigns/${campaignId}/snapshot`,
    );
    // Attach handlers immediately; awaiting below preserves failure while avoiding
    // unhandled rejection noise if the visible interaction itself fails.
    void responsePromise.catch(() => undefined);
    void refreshed.catch(() => undefined);
    let response: import('@playwright/test').Response;
    try {
      await perform();
      response = await responsePromise;
      expect(unexpectedStops, 'Internal map/menu focus must not race an action with stop').toEqual(
        [],
      );
    } finally {
      page.off('request', watchStop);
    }
    expect(response.ok(), 'HTTP/unknown outcome must not be retried').toBeTruthy();
    const request = response.request().postDataJSON();
    expect(typeof request.operationId).toBe('string');
    expect(operations.has(request.operationId), 'Reconfirmation needs a new operation').toBe(false);
    operations.add(request.operationId);
    const intent = {
      type: request.type,
      action: request.action,
      npcId: request.npcId,
      promiseId: request.promiseId,
      decision: request.decision,
    };
    if (attempt === 0) intended = intent;
    else expect(intent, 'Reconfirmation must preserve the exact intended action').toEqual(intended);
    const result = await response.json();
    expect(result.operationId).toBe(request.operationId);
    if (result.status === 'committed') return;
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('STALE_STATE');
    expect(result.events).toEqual([]);
    const snapshot = await refreshed;
    expect(snapshot.ok()).toBeTruthy();
    expect((await snapshot.json()).projection.revision).toBeGreaterThan(request.expectedRevision);
    await expect(
      page.getByText(
        /Мир изменился\. Состояние обновлено\.|Ход уже изменился\. Обнови состояние перед действием\./,
      ),
    ).toBeVisible();
    expect(attempt, 'Three explicit decisions exhausted without commit').toBeLessThan(2);
  }
}
export async function mapAction(
  page: Page,
  campaignId: string,
  id: string,
  name: string,
  exit = false,
) {
  let button: import('@playwright/test').Locator;
  const prepare = async () => {
    button = (await mapMenu(page, campaignId, id, exit)).getByRole('button', {
      name,
      exact: true,
    });
    await expect(button).toBeEnabled();
  };
  const perform = () => button.click();
  const kinds: Record<string, string> = {
    Взять: 'pick_up',
    Отпереть: 'unlock',
    Открыть: 'open',
    'Закрыть дверь': 'close',
    Перейти: 'transition',
    Толкнуть: 'push',
  };
  if (kinds[name])
    await reconfirmKnownStale(
      page,
      campaignId,
      { type: 'action', action: { kind: kinds[name], targetId: id } },
      perform,
      prepare,
    );
  else {
    await prepare();
    await perform();
  }
}
