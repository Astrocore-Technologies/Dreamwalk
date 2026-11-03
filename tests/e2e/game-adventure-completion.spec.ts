import {
  approachTarget,
  mapAction,
  mapMenu,
  inventory,
  closeInventory,
  legacyRealtimeLaunch,
  readProjection,
} from './support/map-actions';
import { profileOwnerReload } from './support/renderer-diagnostics';
import { exposeDiscoveryFixtures } from './support/discovery-fixtures';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function account(page: Page, index: number) {
  const handle = `story_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const response = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: `Explorer ${index}`,
      password: `Story-${randomUUID()}!`,
    },
  });
  expect(response.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  const hero = await page.request.post('/api/v1/heroes', {
    data: {
      name: `Исследователь ${index}`,
      backstory: 'Путешественник',
      notes: `PRIVATE_HERO_${index}`,
      traits: [],
    },
  });
  expect(hero.ok()).toBeTruthy();
  return { handle, heroId: (await hero.json()).id as string };
}
async function capture(page: Page, filename: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('canvas')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByTestId('campaign-objectives')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(filename), fullPage: false });
}
test('four players retain the legacy realtime Observatory ending with owned heroes', async ({
  browser,
}) => {
  // Four independent live WebGL pages also record trace snapshots. Measured CI:
  // setup/joins ~22s, four privacy disclosures ~84s, room capture ~9s,
  // key+door ~32s, before roof/journal, four reloads and two final captures.
  // Keep per-action 15s and per-route-step 30s limits; only the complete
  // four-player journey needs a larger cumulative budget than one-player tests.
  test.setTimeout(300000);
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () =>
      browser.newContext({
        baseURL: test.info().project.use.baseURL,
        viewport: { width: 1440, height: 1000 },
        reducedMotion: 'reduce',
      }),
    ),
  );
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [owner, ...guests] = pages;
  for (const page of pages) {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
  }
  let journeyCompleted = false;
  try {
    const accounts = await Promise.all(pages.map((p, i) => account(p, i + 1)));
    await legacyRealtimeLaunch(owner);
    await exposeDiscoveryFixtures(owner);
    await owner.goto('/home');
    const featured = owner.getByTestId('home-featured');
    await expect(featured).toBeVisible();
    for (
      let i = 0;
      i < 30 && (await featured.getAttribute('data-featured-slug')) !== 'old-observatory';
      i++
    )
      await owner.getByTestId('home-next').click();
    await expect(featured).toHaveAttribute('data-featured-slug', 'old-observatory');
    await owner.getByLabel('Герой для этого прохождения').selectOption(accounts[0].heroId);
    await owner.getByTestId('home-start-adventure').click();
    await expect(owner).toHaveURL(/\/adventures\/old-observatory/);
    await owner.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const id = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    for (let i = 0; i < guests.length; i++) {
      const guest = guests[i];
      const invitation = await owner.request.post(`/api/v1/game/campaigns/${id}/invitations`, {
        data: { username: accounts[i + 1].handle },
      });
      expect(invitation.ok()).toBeTruthy();
      await guest.goto('/game');
      await guest.getByLabel('Герой для этого прохождения').selectOption(accounts[i + 1].heroId);
      await guest
        .getByRole('button', { name: 'Принять приглашение в кампанию', exact: true })
        .click();
      await expect(guest).toHaveURL(new RegExp(`/game/${id}$`));
      await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    }
    // Independent clients inspect only their own local disclosure state. Keep each
    // page's full assertion/open/close order, without serializing unrelated clients.
    await Promise.all(
      pages.map(async (page, index) => {
        await expect
          .poll(
            async () =>
              (await readProjection(page, id)).objectives?.find(
                (objective) => objective.id === 'recover-journal',
              )?.status,
          )
          .toBe('active');
        await expect(page.getByTestId('campaign-objectives')).toHaveCount(0);
        await expect(page.getByTestId('objective-epilogue')).toHaveCount(0);
        for (let i = 1; i <= 4; i++) {
          if (i !== index + 1)
            await expect(page.getByText(`PRIVATE_HERO_${i}`, { exact: true })).toHaveCount(0);
        }
        const privateDetails = page.getByTestId('campaign-hero').locator('details');
        const ownNote = privateDetails.getByText(`PRIVATE_HERO_${index + 1}`, { exact: true });
        await expect(ownNote).toHaveCount(1);
        await expect(privateDetails).not.toHaveAttribute('open', '');
        await expect(ownNote).not.toBeVisible();
        await privateDetails.locator('summary').click();
        await expect(ownNote).toBeVisible();
        await privateDetails.locator('summary').click();
        await expect(ownNote).not.toBeVisible();
      }),
    );
    await test.step(
      'Capture the initial rendered room',
      async () => {
        await expect(owner.locator('[data-scene-profile="observatory-interior-v1"]')).toBeVisible();
        await capture(owner, 'sample-adventure-room-desktop.png');
      },
      { timeout: 25000 },
    );
    await test.step(
      'Approach the brass key through the UI',
      () => approachTarget(owner, id, 'key'),
      { timeout: 30000 },
    );
    await test.step(
      'Pick up the brass key through the UI',
      () => mapAction(owner, id, 'key', 'Взять'),
      { timeout: 30000 },
    );
    await test.step(
      'Verify the brass key in visible inventory',
      async () => {
        await expect((await inventory(owner)).locator('[data-inventory-id="key"]')).toHaveCount(1);
        await closeInventory(owner);
      },
      { timeout: 30000 },
    );
    await test.step(
      'Approach the main door through the UI',
      () => approachTarget(owner, id, 'door'),
      { timeout: 30000 },
    );
    await test.step(
      'Unlock the main door through the UI',
      async () => {
        await mapAction(owner, id, 'door', 'Отпереть');
        await expect
          .poll(
            async () =>
              (await readProjection(owner, id)).entities.find((e) => e.id === 'door')?.locked,
          )
          .toBe(false);
      },
      { timeout: 30000 },
    );
    await test.step(
      'Open the main door through the UI',
      async () => {
        await mapAction(owner, id, 'door', 'Открыть');
        await expect
          .poll(
            async () =>
              (await readProjection(owner, id)).entities.find((e) => e.id === 'door')?.open,
          )
          .toBe(true);
      },
      { timeout: 30000 },
    );
    await test.step(
      'Verify the opened door menu',
      async () => {
        await expect(
          (await mapMenu(owner, id, 'door')).getByRole('button', {
            name: 'Закрыть дверь',
            exact: true,
          }),
        ).toBeVisible();
        await owner
          .getByRole('dialog', { name: 'Действия', exact: true })
          .getByRole('button', { name: 'Закрыть', exact: true })
          .click();
      },
      { timeout: 30000 },
    );
    await test.step(
      'Approach the main roof exit',
      () => approachTarget(owner, id, 'roof-exit', true),
      { timeout: 30000 },
    );
    await test.step(
      'Move through the main roof exit',
      async () => {
        await mapAction(owner, id, 'roof-exit', 'Перейти', true);
        await expect(owner.locator('[data-scene-profile="observatory-roof-v1"]')).toBeVisible();
      },
      { timeout: 30000 },
    );
    await test.step(
      'Approach the journal through the UI',
      () => approachTarget(owner, id, 'journal'),
      { timeout: 30000 },
    );
    await test.step(
      'Pick up the journal through the UI',
      async () => {
        await mapAction(owner, id, 'journal', 'Взять');
      },
      { timeout: 30000 },
    );
    await Promise.all(
      pages.map(async (page) => {
        await expect
          .poll(
            async () =>
              (await readProjection(page, id)).objectives?.find(
                (objective) => objective.id === 'recover-journal',
              )?.status,
          )
          .toBe('achieved');
        await expect(page.getByTestId('campaign-objectives')).toHaveCount(0);
        await expect(page.getByTestId('objective-epilogue')).toHaveCount(0);
      }),
    );
    await Promise.all(
      guests.map(async (guest) => {
        await expect(guest.locator('[data-scene-profile="observatory-interior-v1"]')).toBeVisible();
        expect((await readProjection(guest, id)).entities.some((e) => e.id === 'journal')).toBe(
          false,
        );
      }),
    );
    // Persistence is per-client, not a simultaneous four-WebGL cold-start benchmark.
    // Keep all four contexts live, but let each real reload finish before starting
    // the next; no reload retry, renderer bypass or additional timeout budget.
    for (const [index, page] of pages.entries()) {
      // Inspect the restored map temporarily without changing this player's reading position.
      const viewport = await page.locator('[data-renderer-active]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: scrollX, y: scrollY, offscreen: rect.bottom <= 0 || rect.top >= innerHeight };
      });
      const finishProfile = index === 0 ? await profileOwnerReload(page, test.info()) : undefined;
      try {
        await page.reload();
        // Restored scroll may leave the map offscreen, where rendering is correctly paused.
        // Reveal it as a user would before asserting its actual restored scene.
        await page
          .getByRole('group', { name: 'Карта приключения', exact: true })
          .scrollIntoViewIfNeeded();
        // A restored HTTP projection can show the ending before Pixi/socket startup.
        // Use the existing 15s expectation bound for actual readiness on every client,
        // not force-clicking a toolbar while reconnect banners still move its layout.
        await expect
          .poll(() =>
            page.evaluate(
              (expectedScene) => {
                const host = document.querySelector<HTMLElement>('[data-camera-scale]');
                const canvas = host?.querySelector('canvas');
                const bounds = canvas?.getBoundingClientRect();
                const scale = Number(host?.dataset.cameraScale);
                return {
                  connected:
                    document.querySelector('[data-connected]')?.getAttribute('data-connected') ===
                    'true',
                  rendered:
                    !!canvas &&
                    canvas.width > 0 &&
                    canvas.height > 0 &&
                    !!bounds &&
                    bounds.width > 0 &&
                    bounds.height > 0 &&
                    Number.isFinite(scale) &&
                    scale > 0 &&
                    host?.dataset.sceneProfile === expectedScene,
                };
              },
              index === 0 ? 'observatory-roof-v1' : 'observatory-interior-v1',
            ),
          )
          .toEqual({ connected: true, rendered: true });
      } finally {
        await finishProfile?.();
      }
      await expect
        .poll(
          async () =>
            (await readProjection(page, id)).objectives?.find(
              (objective) => objective.id === 'recover-journal',
            )?.status,
        )
        .toBe('achieved');
      await expect(page.getByTestId('campaign-objectives')).toHaveCount(0);
      await page.evaluate(
        ({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'instant' }),
        viewport,
      );
      await expect
        .poll(() =>
          page.evaluate(
            ({ x, y }) => Math.max(Math.abs(scrollX - x), Math.abs(scrollY - y)),
            viewport,
          ),
        )
        .toBeLessThan(1);
      const restoredOffscreen = await page.locator('[data-renderer-active]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom <= 0 || rect.top >= innerHeight;
      });
      if (viewport.offscreen && restoredOffscreen)
        await expect(page.locator('[data-renderer-active]')).toHaveAttribute(
          'data-renderer-active',
          'false',
        );
    }
    await owner
      .getByRole('group', { name: 'Карта приключения', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(owner.locator('[data-renderer-active]')).toHaveAttribute(
      'data-renderer-active',
      'true',
    );
    await expect((await inventory(owner)).locator('[data-inventory-id="journal"]')).toHaveCount(1);
    await capture(owner, 'sample-adventure-ending-desktop.png');
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await capture(owner, 'sample-adventure-ending-mobile.png');
    journeyCompleted = true;
  } finally {
    if (journeyCompleted) {
      // Successful tests must finish every owned context/trace teardown before
      // Playwright reuses the worker browser for the next scenario.
      await Promise.all(contexts.map((context) => context.close()));
    } else {
      // A failed journey retains its original action error even if the browser
      // is already closing. Playwright discards that failed worker afterwards.
      const cleanup = Promise.allSettled(contexts.map((context) => context.close()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }
});
