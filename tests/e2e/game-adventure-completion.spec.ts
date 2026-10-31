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
async function position(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
  expect(response.ok()).toBeTruthy();
  const { projection } = await response.json();
  const actor = projection.entities.find((e: { id: string }) => e.id === projection.actorId);
  return [actor.x, actor.y];
}
async function capture(page: Page, filename: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('canvas')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  if (filename.includes('ending')) {
    const canvas = await page.locator('canvas').boundingBox();
    const objective = await page.getByTestId('campaign-objectives').boundingBox();
    expect(canvas).not.toBeNull();
    expect(objective).not.toBeNull();
    const x = Math.max(0, Math.min(canvas!.x, objective!.x) - 8);
    const y = Math.max(0, Math.min(canvas!.y, objective!.y) - 8);
    const right = Math.min(
      page.viewportSize()!.width,
      Math.max(canvas!.x + canvas!.width, objective!.x + objective!.width) + 8,
    );
    const bottom = Math.max(canvas!.y + canvas!.height, objective!.y + objective!.height) + 8;
    await page.screenshot({
      path: test.info().outputPath(filename),
      fullPage: true,
      clip: { x, y, width: right - x, height: bottom - y },
    });
  } else {
    await page.screenshot({ path: test.info().outputPath(filename), fullPage: false });
  }
}
test('four independent players start the public Observatory with owned heroes and retain a shared ending', async ({
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
    for (const [index, page] of pages.entries()) {
      await expect(page.locator('[data-objective-id="recover-journal"]')).toHaveAttribute(
        'data-objective-status',
        'active',
      );
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
    }
    await test.step(
      'Capture the initial rendered room',
      async () => {
        await expect(owner.locator('[data-scene-profile="observatory-interior-v1"]')).toBeVisible();
        await capture(owner, 'sample-adventure-room-desktop.png');
      },
      { timeout: 25000 },
    );
    await test.step(
      'Pick up the brass key through the UI',
      async () => {
        const key = owner.locator('[data-entity-id="key"]');
        await key.getByRole('button', { name: 'Подойти', exact: true }).click();
        await expect.poll(() => position(owner, id)).toEqual([4, 6]);
        await key.getByRole('button', { name: 'Подобрать', exact: true }).click();
        await expect(owner.locator('[data-inventory-id="key"]')).toHaveCount(1);
      },
      { timeout: 30000 },
    );
    await test.step(
      'Unlock and open the main door through the UI',
      async () => {
        const door = owner.locator('[data-entity-id="door"]');
        await door.getByRole('button', { name: 'Подойти', exact: true }).click();
        await expect.poll(() => position(owner, id)).toEqual([9, 5]);
        await door.getByRole('button', { name: 'Отпереть', exact: true }).click();
        await door.getByRole('button', { name: 'Открыть дверь', exact: true }).click();
        await expect(
          door.getByRole('button', { name: 'Закрыть дверь', exact: true }),
        ).toBeVisible();
      },
      { timeout: 30000 },
    );
    await test.step(
      'Move through the main roof exit',
      async () => {
        const exit = owner.locator('[data-exit-id="roof-exit"]');
        await exit.getByRole('button', { name: 'Подойти', exact: true }).click();
        await expect.poll(() => position(owner, id)).toEqual([12, 5]);
        await exit.getByRole('button', { name: 'Перейти', exact: true }).click();
        await expect(owner.locator('[data-scene-profile="observatory-roof-v1"]')).toBeVisible();
      },
      { timeout: 30000 },
    );
    await test.step(
      'Pick up the journal through the UI',
      async () => {
        const journal = owner.locator('[data-entity-id="journal"]');
        await journal.getByRole('button', { name: 'Подойти', exact: true }).click();
        await expect.poll(() => position(owner, id)).toEqual([6, 4]);
        await journal.getByRole('button', { name: 'Подобрать', exact: true }).click();
      },
      { timeout: 30000 },
    );
    for (const page of pages) {
      await expect(page.locator('[data-objective-id="recover-journal"]')).toHaveAttribute(
        'data-objective-status',
        'achieved',
      );
      await expect(page.getByTestId('objective-epilogue')).toBeVisible();
    }
    for (const guest of guests) {
      await expect(guest.locator('[data-scene-profile="observatory-interior-v1"]')).toBeVisible();
      await expect(guest.locator('[data-entity-id="journal"]')).toHaveCount(0);
    }
    await Promise.all(pages.map((p) => p.reload()));
    for (const page of pages)
      await expect(page.locator('[data-objective-id="recover-journal"]')).toHaveAttribute(
        'data-objective-status',
        'achieved',
      );
    await expect(owner.locator('[data-inventory-id="journal"]')).toHaveCount(1);
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
