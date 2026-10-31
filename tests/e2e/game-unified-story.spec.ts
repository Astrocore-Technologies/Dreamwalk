import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
async function register(page: Page) {
  const handle = `unified_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const result = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'Story player',
      password: `Safe-${randomUUID()}!`,
    },
  });
  expect(result.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  return handle;
}
async function state(page: Page, id: string) {
  const result = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
  expect(result.ok()).toBeTruthy();
  return (await result.json()).projection;
}
async function tileClick(page: Page, x: number, y: number) {
  const host = page.locator('[data-camera-scale]');
  const canvas = host.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const scale = Number(await host.getAttribute('data-camera-scale'));
  const offsetX = Number(await host.getAttribute('data-camera-x'));
  const offsetY = Number(await host.getAttribute('data-camera-y'));
  // These are actual renderer transforms, not a synthetic hit target.
  await canvas.click({
    position: { x: offsetX + (x + 0.5) * 48 * scale, y: offsetY + (y + 0.5) * 48 * scale },
  });
}
test('one mixed-turn composer keeps audience, order and scene input coherent', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const contexts = await Promise.all([
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
  ]);
  const [owner, guest] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [owner, guest]) {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
  }
  try {
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await register(owner);
    const guestHandle = await register(guest);
    await owner.goto('/adventures/old-observatory');
    await owner.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const id = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await guest.goto('/game');
    await guest
      .getByRole('button', { name: 'Принять приглашение в кампанию', exact: true })
      .click();
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    const story = owner.getByTestId('unified-story');
    const keeper = owner.locator('[data-entity-id="keeper"]');
    await keeper.getByRole('button', { name: 'Подойти', exact: true }).click();
    await expect
      .poll(async () => {
        const p = await state(owner, id);
        const a = p.entities.find((e: { id: string }) => e.id === p.actorId);
        const n = p.entities.find((e: { id: string }) => e.id === 'keeper');
        return Math.abs(a.x - n.x) + Math.abs(a.y - n.y);
      })
      .toBeLessThanOrEqual(1);
    const before = await state(owner, id);
    const actor = before.entities.find((e: { id: string }) => e.id === before.actorId);
    const npc = before.entities.find((e: { id: string }) => e.id === 'keeper');
    await tileClick(owner, npc.x, npc.y);
    await expect(
      story.getByRole('button', { name: 'Убрать собеседника', exact: true }),
    ).toBeVisible();
    const after = await state(owner, id);
    expect(after.entities.find((e: { id: string }) => e.id === after.actorId)).toMatchObject({
      x: actor.x,
      y: actor.y,
    });
    // Typing WASD / arrows edits text or caret, not world movement.
    await story.getByLabel('Твой ход', { exact: true }).fill('wasd');
    await story.getByLabel('Твой ход', { exact: true }).press('ArrowLeft');
    const typed = await state(owner, id);
    expect(typed.entities.find((e: { id: string }) => e.id === typed.actorId)).toMatchObject({
      x: actor.x,
      y: actor.y,
    });
    await story.getByRole('button', { name: 'Шёпот', exact: true }).click();
    const text = '*wait* PRIVATE_MIXED_TURN_826 \\*literal\\*';
    await story.getByLabel('Твой ход', { exact: true }).fill(text);
    await story.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(story.getByTestId('story-quote')).toContainText('Ждать');
    await expect(guest.getByTestId('story-feed')).not.toContainText('PRIVATE_MIXED_TURN_826');
    const submissions: string[] = [];
    owner.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/turns'))
        submissions.push(request.postData() || '');
    });
    await story.getByRole('button', { name: 'Подтвердить ход', exact: true }).dblclick();
    await expect(story.getByLabel('Твой ход', { exact: true })).toHaveValue('', { timeout: 30000 });
    expect(submissions).toHaveLength(1);
    await expect(story.getByTestId('story-feed')).toContainText('PRIVATE_MIXED_TURN_826');
    await expect(guest.getByTestId('story-feed')).not.toContainText('PRIVATE_MIXED_TURN_826');
    const entries = await story
      .getByTestId('story-feed')
      .locator('[data-story-entry]')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          id: n.getAttribute('data-story-entry'),
          turn: n.getAttribute('data-story-turn'),
          kind: n.getAttribute('data-story-kind'),
        })),
      );
    const mixed = entries.filter((e) => e.turn === entries.find((e) => e.kind === 'attempt')?.turn);
    expect(mixed.map((e) => e.kind)).toEqual(['attempt', 'outcome', 'speech', 'npc_reply']);
    const literalSpeech = story.locator(
      `[data-story-turn="${mixed[0].turn}"][data-story-kind="speech"] p`,
    );
    await expect(literalSpeech).toHaveText('PRIVATE_MIXED_TURN_826 *literal*');
    await expect(literalSpeech.locator('em')).toHaveCount(0);
    await Promise.all([owner.reload(), guest.reload()]);
    await expect(story.getByTestId('story-feed')).toContainText('PRIVATE_MIXED_TURN_826');
    await expect(guest.getByTestId('story-feed')).not.toContainText('PRIVATE_MIXED_TURN_826');
    const restored = await story
      .getByTestId('story-feed')
      .locator('[data-story-entry]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-story-entry')));
    expect(restored.filter((id) => mixed.some((e) => e.id === id))).toEqual(mixed.map((e) => e.id));
    // Floor click issues real path movement; no directional keyboard or d-pad is required.
    const current = await state(owner, id);
    const currentActor = current.entities.find((e: { id: string }) => e.id === current.actorId);
    const floor = [
      { x: currentActor.x + 1, y: currentActor.y },
      { x: currentActor.x - 1, y: currentActor.y },
      { x: currentActor.x, y: currentActor.y + 1 },
      { x: currentActor.x, y: currentActor.y - 1 },
    ].find(
      (point) =>
        point.x > 0 &&
        point.y > 0 &&
        point.x < current.map.width - 1 &&
        point.y < current.map.height - 1 &&
        !current.map.blocked.some(
          (p: { x: number; y: number }) => p.x === point.x && p.y === point.y,
        ) &&
        !current.entities.some((e: { x: number; y: number }) => e.x === point.x && e.y === point.y),
    );
    expect(floor).toBeTruthy();
    await tileClick(owner, floor!.x, floor!.y);
    await expect
      .poll(async () => {
        const p = await state(owner, id);
        const a = p.entities.find((e: { id: string }) => e.id === p.actorId);
        return [a.x, a.y];
      })
      .toEqual([floor!.x, floor!.y]);
    await owner.evaluate(() => scrollTo(0, 0));
    await owner.screenshot({ path: test.info().outputPath('unified-story-desktop.png') });
    await owner.setViewportSize({ width: 390, height: 844 });
    await story.scrollIntoViewIfNeeded();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await owner.screenshot({ path: test.info().outputPath('unified-story-mobile.png') });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
