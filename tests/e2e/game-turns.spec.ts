import { savePrivateFixture, publishPrivateFixture } from './support/private-authoring';
import { mapAction } from './support/map-actions';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { GameProjection } from '@dreamwalk/contracts';

async function request(page: Page, path: string, data?: unknown, method = 'POST') {
  const response =
    data === undefined
      ? await page.request.get(`/api/v1${path}`)
      : await page.request.fetch(`/api/v1${path}`, { method, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}
async function account(page: Page) {
  const handle = `turn_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await request(page, '/auth/register', {
    handle,
    email: `${handle}@example.test`,
    name: 'Turn QA',
    password: `Turn-${randomUUID()}!`,
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  return handle;
}
async function snapshot(page: Page, id: string): Promise<GameProjection> {
  return (await request(page, `/game/campaigns/${id}/snapshot`)).projection;
}
async function clickCell(page: Page, x: number, y: number, button: 'left' | 'right' = 'left') {
  const host = page.locator('[data-camera-x]').first(),
    canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();
  const offsetX = Number(await host.getAttribute('data-camera-x')),
    offsetY = Number(await host.getAttribute('data-camera-y')),
    scale = Number(await host.getAttribute('data-camera-scale'));
  await canvas.click({
    button,
    position: { x: offsetX + (x + 0.5) * 48 * scale, y: offsetY + (y + 0.5) * 48 * scale },
  });
}
async function say(page: Page, text: string) {
  const composer = page.getByTestId('unified-story');
  await composer.getByLabel('Твой ход', { exact: true }).fill(text);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/turns$/.test(new URL(response.url()).pathname),
  );
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  const response = await submitted;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().targetNpcId).toBeUndefined();
  await expect(composer.getByTestId('story-quote')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: 'Подтвердить ход', exact: true })).toHaveCount(
    0,
  );
  const receipt = await response.json();
  await expect(composer.getByLabel('Твой ход', { exact: true })).toHaveValue('');
  return receipt.id as string;
}

test('sequential turns retain two area posts, freeze NPCs, and reply only after all player turns', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const contexts = await Promise.all([
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
  ]);
  const owner = await contexts[0].newPage(),
    guest = await contexts[1].newPage();
  try {
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await account(owner);
    const guestHandle = await account(guest);
    const sourceA = await request(owner, '/npcs', {
      name: 'Mira',
      description: 'A patient alchemist in a green coat.',
      appearance: 'Copper hair and a green coat.',
      personality: 'Patient and curious.',
      secrets: 'TURN_PRIVATE_NPC_SECRET',
    });
    const sourceB = await request(owner, '/npcs', {
      name: 'Borin',
      description: 'A reserved traveling scholar.',
      appearance: 'Dark coat and a leather satchel.',
      personality: 'Reserved but helpful.',
      secrets: 'TURN_OTHER_PRIVATE_SECRET',
    });
    const story = await request(owner, '/studio/adventures', {
      title: 'Sequential conversation QA',
      content: {
        world: 'A city of rain and glass.',
        rules: 'Words are intentions until the server confirms an effect.',
        locations: [],
        npcIds: [sourceA.id, sourceB.id],
        scenes: [],
        startSceneId: '',
        boundaries: [],
      },
    });
    const personality = {
      role: 'helper',
      values: ['kindness', 'honesty'],
      taboos: ['steal', 'harm', 'disclose_private'],
      speechStyle: 'warm',
    };
    const draft = {
      schemaVersion: 1,
      title: 'Sequential room',
      npcBehavior: 'reactive-v1',
      startMapId: 'room',
      turnRules: {
        id: 'dreamwalk-base',
        version: 1,
        movement: 6,
        main: 1,
        additional: 1,
        reaction: 1,
        vitality: 6,
        hitDamage: 1,
        pushDistance: 1,
        maxReactionDepth: 1,
        maxWorldActions: 16,
        maxNpcActions: 1,
        maxQueuedSpeech: 8,
      },
      narrativeConstraints: {
        allowNewScenes: true,
        allowNewNpcs: true,
        maxScenes: 16,
        maxSupportingNpcs: 16,
        maxTurns: 256,
        protectedFacts: [],
        forbiddenRoles: [],
      },
      maps: [
        {
          id: 'room',
          label: 'Rain room',
          width: 24,
          height: 24,
          blocked: [],
          spawns: [
            { x: 2, y: 3 },
            { x: 2, y: 4 },
          ],
          exits: [],
        },
      ],
      objects: [],
      npcs: [
        {
          id: 'mira',
          sourceNpcId: sourceA.id,
          label: 'Mira',
          mapId: 'room',
          x: 4,
          y: 3,
          visual: 'traveler',
          goal: 'help',
          patrolTarget: { x: 5, y: 3 },
          personality,
        },
        {
          id: 'borin',
          sourceNpcId: sourceB.id,
          label: 'Borin',
          mapId: 'room',
          x: 3,
          y: 2,
          visual: 'keeper',
          goal: 'help',
          patrolTarget: { x: 5, y: 5 },
          personality,
        },
      ],
      roundPolicy: { maxRounds: 5, planningMs: 30000 },
    };
    await savePrivateFixture(owner, story.id, draft);
    const version = await publishPrivateFixture(owner, story.id);
    const campaign = await request(owner, '/game/campaigns', {
      playableVersionId: version.playableVersionId,
    });
    const id = campaign.campaignId;
    const invitation = await request(owner, `/studio/adventures/${story.id}/invitations`, {
      handle: guestHandle,
    });
    await request(guest, `/invitations/${invitation.id}/respond`, { decision: 'accept' });
    await request(owner, `/game/campaigns/${id}/invitations`, { username: guestHandle });
    await request(guest, `/game/campaigns/${id}/accept`, {});
    await Promise.all([owner.goto(`/game/${id}`), guest.goto(`/game/${id}`)]);
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    const panel = owner.getByRole('region', { name: 'Ход приключения', exact: true });
    await expect(panel.getByRole('heading', { name: 'Твой ход', exact: true })).toBeVisible();
    await clickCell(owner, 3, 3);
    await expect(owner.getByTestId('game-position')).toHaveAttribute('data-x', '3');
    const moved = await snapshot(owner, id);
    expect(moved.turn?.resources.movement).toBe(5);
    await expect
      .poll(async () =>
        Number(
          await owner.locator('[data-camera-scale]').first().getAttribute('data-camera-scale'),
        ),
      )
      .toBeGreaterThan(0);
    await mapAction(owner, id, 'mira', 'Осмотреть');
    await expect(owner.getByTestId('npc-public-inspection')).toContainText('patient alchemist');
    await expect(owner.getByText('TURN_PRIVATE_NPC_SECRET', { exact: true })).toHaveCount(0);
    const spokenTurns = [
      await say(owner, 'Мира, что ты заметила в комнате?'),
      await say(owner, 'Борин, а ты что думаешь?'),
    ];
    await expect(
      owner.getByTestId('story-feed').locator('[data-story-kind="npc_reply"]'),
    ).toHaveCount(0);
    const before = await snapshot(owner, id);
    expect(before.turn?.pendingNpcReplies).toHaveLength(2);
    // Both posts reach every nearby listener without selecting a recipient.
    expect(
      before.turn?.pendingNpcReplies.map((entry) => [entry.npcId, entry.count]).sort(),
    ).toEqual([
      ['borin', 2],
      ['mira', 2],
    ]);
    await owner.reload();
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    const restored = await snapshot(owner, id);
    expect(restored.turn?.resources.movement).toBe(5);
    expect(restored.turn?.pendingNpcReplies).toHaveLength(2);
    for (const npc of ['mira', 'borin'])
      expect(restored.entities.find((e) => e.id === npc)).toMatchObject({
        ...before.entities.find((e) => e.id === npc)!,
      });
    await owner.getByRole('button', { name: 'Завершить ход', exact: true }).click();
    await expect(
      guest
        .getByRole('region', { name: 'Ход приключения', exact: true })
        .getByRole('heading', { name: 'Твой ход', exact: true }),
    ).toBeVisible();
    await expect(
      owner.getByTestId('story-feed').locator('[data-story-kind="npc_reply"]'),
    ).toHaveCount(0);
    await guest.getByRole('button', { name: 'Завершить ход', exact: true }).click();
    await expect(
      owner.getByTestId('story-feed').locator('[data-story-kind="npc_reply"]'),
    ).toHaveCount(4, { timeout: 30000 });
    const replies = async () => {
      const feed = await request(owner, `/game/campaigns/${id}/turns/feed`);
      return (
        feed.entries as { id: string; kind: string; turnId?: string; authorId?: string }[]
      ).filter((entry) => entry.kind === 'npc_reply' && spokenTurns.includes(entry.turnId || ''));
    };
    const delivered = await replies();
    expect(new Set(delivered.map((entry) => entry.id)).size).toBe(4);
    for (const turnId of spokenTurns)
      expect(
        delivered
          .filter((entry) => entry.turnId === turnId)
          .map((entry) => entry.authorId)
          .sort(),
      ).toEqual(['borin', 'mira']);
    // Restoring the campaign must not replay a reply or lose either bystander's response.
    await owner.reload();
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(
      owner.getByTestId('story-feed').locator('[data-story-kind="npc_reply"]'),
    ).toHaveCount(4);
    expect((await replies()).map((entry) => entry.id).sort()).toEqual(
      delivered.map((entry) => entry.id).sort(),
    );
    await expect(
      owner
        .getByRole('region', { name: 'Ход приключения', exact: true })
        .getByRole('heading', { name: 'Твой ход', exact: true }),
    ).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await owner.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await owner.screenshot({ path: test.info().outputPath('turns-desktop.png'), fullPage: false });
    await clickCell(owner, 3, 4);
    await expect(owner.getByTestId('game-position')).toHaveAttribute('data-y', '4');
    const guestBefore = await snapshot(guest, id),
      guestActor = guestBefore.actorId;
    await mapAction(owner, id, guestActor, 'Толкнуть');
    await expect(guest.getByRole('button', { name: 'Защититься', exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Защититься', exact: true }).scrollIntoViewIfNeeded();
    await guest.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await guest.screenshot({ path: test.info().outputPath('turns-reaction.png'), fullPage: false });
    await guest.getByRole('button', { name: 'Защититься', exact: true }).click();
    await expect.poll(async () => (await snapshot(owner, id)).turn?.phase).toBe('player');
    expect((await snapshot(owner, id)).turn?.resources.main).toBe(0);
    const defended = await snapshot(guest, id);
    expect(defended.turn?.resources.reaction).toBe(0);
    const beforePosition = guestBefore.entities.find((e) => e.id === guestActor)!;
    expect(defended.entities.find((e) => e.id === guestActor)).toMatchObject({
      x: beforePosition.x,
      y: beforePosition.y,
    });
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest
      .getByRole('region', { name: 'Ход приключения', exact: true })
      .scrollIntoViewIfNeeded();
    await guest.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await guest.screenshot({ path: test.info().outputPath('turns-mobile.png'), fullPage: false });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
