import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readProjection } from './support/map-actions';

async function start(page: Page, turnBased: boolean, withPortrait = false) {
  const handle = `art_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const account = await page.request.post('/api/v1/auth/register', {
    data: {
      handle,
      name: 'Synthetic art QA',
      email: `${handle}@example.test`,
      password: `Art-${randomUUID()}!`,
    },
  });
  expect(account.ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  let heroId: string | undefined;
  if (withPortrait) {
    // A real raster upload, pinned as the hero portrait served by the actor endpoint.
    const upload = await page.request.post('/api/v1/assets', {
      multipart: {
        file: {
          name: 'portrait.webp',
          mimeType: 'image/webp',
          buffer: readFileSync(path.resolve('apps/web/public/images/observatory.webp')),
        },
      },
    });
    expect(upload.ok()).toBeTruthy();
    const hero = await page.request.post('/api/v1/heroes', {
      data: {
        name: 'Лира',
        backstory: 'Синтетическая история',
        notes: 'Синтетические заметки',
        traits: ['Добрый'],
        portraitAssetId: (await upload.json()).id,
      },
    });
    expect(hero.ok()).toBeTruthy();
    heroId = (await hero.json()).id as string;
  }
  const created = await page.request.post('/api/v1/game/campaigns', {
    data: { template: 'observatory-v1', turnBased, ...(heroId ? { heroId } : {}) },
  });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).campaignId as string;
  await page.goto(`/game/${id}`);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(page.locator('[data-camera-scale]')).toBeVisible();
  return id;
}

async function cellCentre(page: Page, x: number, y: number) {
  // Focusing the composer can scroll the page, so measure right before every click.
  await page.locator('[data-camera-scale]').scrollIntoViewIfNeeded();
  return page.locator('[data-camera-scale]').evaluate(
    (element, cell) => {
      const bounds = element.getBoundingClientRect();
      const data = (element as HTMLElement).dataset;
      const scale = Number(data.cameraScale);
      return {
        x: bounds.left + Number(data.cameraX) + (cell.x + 0.5) * 48 * scale,
        y: bounds.top + Number(data.cameraY) + (cell.y + 0.5) * 48 * scale,
      };
    },
    { x, y },
  );
}

for (const turnBased of [false, true]) {
  test(`tapping a character shows its art, selects nothing it should not, and never moves anyone (${turnBased ? 'turn' : 'legacy'} mode)`, async ({
    page,
  }) => {
    const id = await start(page, turnBased);
    const projection = await readProjection(page, id);
    const npc = projection.entities.find((entity) => entity.kind === 'npc')!;
    const me = projection.entities.find((entity) => entity.id === projection.actorId)!;
    const artWindow = page.getByTestId('actor-art-window');
    const card = page.getByTestId('npc-public-inspection');

    const tapNpc = async () => {
      const point = await cellCentre(page, npc.x!, npc.y!);
      await page.mouse.click(point.x, point.y);
    };
    await tapNpc();
    await expect(artWindow).toBeVisible();
    await expect(artWindow).toHaveAttribute('data-actor-kind', 'npc');
    // The story feed and composer stay available; the full card is opt-in.
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('unified-story').locator('textarea')).toBeVisible();

    // Escape and the close button dismiss it.
    await artWindow.press('Escape');
    await expect(artWindow).toHaveCount(0);

    // Tapping the map elsewhere dismisses it too.
    await tapNpc();
    await expect(artWindow).toBeVisible();
    const emptyPoint = await cellCentre(page, 12, 9);
    await page.mouse.click(emptyPoint.x, emptyPoint.y);
    await expect(artWindow).toHaveCount(0);

    // Talk reaches the composer; Inspect opens the full card and replaces the window.
    await tapNpc();
    await artWindow.getByRole('button', { name: 'Поговорить', exact: true }).click();
    await expect(page.getByTestId('unified-story').locator('textarea')).toBeFocused();
    await tapNpc();
    await artWindow.getByRole('button', { name: 'Осмотреть', exact: true }).click();
    await expect(card).toBeVisible();
    await expect(artWindow).toHaveCount(0);

    // Your own token opens the own-art variant and does not move you.
    await card.getByRole('button', { name: 'Закрыть осмотр', exact: true }).click();
    const mePoint = await cellCentre(page, me.x!, me.y!);
    await page.mouse.click(mePoint.x, mePoint.y);
    await expect(artWindow).toHaveAttribute('data-actor-kind', 'self');
    // Your own window never calls you "another player".
    await expect(artWindow.getByRole('heading')).not.toHaveText('Другой игрок');
    await expect(artWindow.getByRole('button', { name: 'Поговорить' })).toHaveCount(0);
    const after = (await readProjection(page, id)).entities.find((entity) => entity.id === me.id)!;
    expect([after.x, after.y]).toEqual([me.x, me.y]);
  });
}

test('a touch tap on a character opens the art window on a phone-sized screen', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
  });
  const page = await context.newPage();
  const id = await start(page, true);
  const npc = (await readProjection(page, id)).entities.find((entity) => entity.kind === 'npc')!;
  const point = await cellCentre(page, npc.x!, npc.y!);
  await page.touchscreen.tap(point.x, point.y);
  const artWindow = page.getByTestId('actor-art-window');
  await expect(artWindow).toBeVisible();
  // No horizontal overflow and the window stays inside the viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = (await artWindow.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await context.close();
});

test("a saved hero's portrait fills the map token and the art window", async ({ page }) => {
  const id = await start(page, true, true);
  // The renderer fetched the authorized portrait and built the face token from it.
  await expect(page.locator('[data-camera-scale]')).toHaveAttribute('data-actor-portraits', '1');
  const me = (await readProjection(page, id)).entities.find((entity) => entity.kind === 'player')!;
  const point = await cellCentre(page, me.x!, me.y!);
  await page.mouse.click(point.x, point.y);
  const artWindow = page.getByTestId('actor-art-window');
  await expect(artWindow).toHaveAttribute('data-actor-kind', 'self');
  await expect(artWindow.getByRole('heading')).toHaveText('Лира');
  const image = artWindow.locator('img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute('src', new RegExp(`/actors/${me.id}/portrait$`));
});
