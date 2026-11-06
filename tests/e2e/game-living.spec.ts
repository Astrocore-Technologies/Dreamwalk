import { campaignDetails } from './support/campaign-details';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import {
  savePrivateFixture,
  launchPrivateFixture,
  authoringRequest,
} from './support/private-authoring';
import {
  approachTarget,
  reconfirmKnownStale,
  mapAction,
  readProjection,
  inventory,
  closeInventory,
} from './support/map-actions';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function approachHelper(page: Page) {
  await approachTarget(page, new URL(page.url()).pathname.split('/').at(-1)!, 'helper');
}

test('API-authored realtime fixture retains personality, obligations and private story UI transport', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(15000);
  guest.setDefaultNavigationTimeout(30000);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const register = await page.request.post('/api/v1/auth/register', {
      data: {
        email: `living-${suffix}@example.test`,
        handle: `living_${suffix}`,
        name: 'Living QA',
        password: `Living-${randomUUID()}!`,
      },
    });
    expect(register.status()).toBe(201);
    const guestHandle = `living_guest_${suffix}`;
    const guestRegistration = await guest.request.post('/api/v1/auth/register', {
      data: {
        email: `living-guest-${suffix}@example.test`,
        handle: guestHandle,
        name: 'Guest QA',
        password: `Guest-${randomUUID()}!`,
      },
    });
    expect(guestRegistration.status()).toBe(201);
    await page.goto('/studio/adventures/new');
    await page.getByLabel('Название приключения').fill(`Living courtyard ${suffix}`);
    await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/adventures\/[a-f0-9-]+$/);
    const adventureId = new URL(page.url()).pathname.split('/').at(-1)!;
    // Former personality/map controls are an explicit API fixture; live gameplay remains browser coverage.
    const draft = createAuthoredDraft('courtyard');
    draft.npcs[0] = {
      ...draft.npcs[0],
      goal: 'patrol',
      patrolTarget: { x: 6, y: 4 },
      personality: {
        role: 'guard',
        values: ['duty', 'caution'],
        taboos: ['steal', 'disclose_private'],
        speechStyle: '',
        publicSpeechStyle: 'warm',
        habits: ['keep_promises'],
        links: [{ npcId: 'helper', relation: 'ally' }],
        biography: 'Protect the courtyard, not a secret live memory.',
        decisionExamples: [
          { situation: 'Someone asks for help.', response: 'Check what I can safely offer.' },
        ],
      },
    };
    draft.npcs.push({
      id: 'helper',
      label: 'Помощник',
      mapId: draft.startMapId,
      x: 7,
      y: 6,
      visual: 'traveler',
      goal: 'help',
      patrolTarget: { x: 7, y: 6 },
      personality: {
        role: 'helper',
        values: ['kindness', 'honesty'],
        taboos: ['steal', 'harm', 'disclose_private'],
        speechStyle: '',
      },
      initialFacts: [
        {
          id: 'fixture-fountain',
          title: 'PRIVATE_AUTHOR_FACT_TITLE',
          text: 'The fountain was built by an astronomer.',
          disclosure: 'asked',
          publicQuestion: 'Who built the fountain?',
        },
      ],
      initialGoals: [
        {
          id: 'fixture-patrol',
          kind: 'patrol',
          priority: 1,
          motivation: 'routine',
          when: [],
          success: [],
          cancelWhen: [],
          holdTicks: 20,
        },
      ],
      promiseTemplates: [
        {
          id: 'fixture-token-promise',
          itemId: 'token',
          offerOn: 'addressed',
          conditions: [],
          dueTicks: 200,
          requiresAcceptance: true,
        },
      ],
    });
    Object.assign(
      draft.objects.find((item) => item.id === 'token')!,
      { ownerNpcId: 'helper', x: 7, y: 6 },
    );
    const saved = await savePrivateFixture(page, adventureId, draft);
    await page.reload();
    const persisted = await authoringRequest(
      page,
      `/studio/adventures/${adventureId}/playable-draft`,
    );
    expect(persisted.draft.npcs[0].personality).toEqual(saved.draft.npcs[0].personality);
    expect(persisted.draft.npcs[1].initialFacts).toEqual(saved.draft.npcs[1].initialFacts);
    expect(persisted.draft.npcs[1].promiseTemplates[0].requiresAcceptance).toBe(true);
    const preview = await authoringRequest(page, `/studio/adventures/${adventureId}/npc-preview`, {
      expectedRevision: saved.revision,
      npcId: 'helper',
    });
    expect(preview.sourceRevision).toBe(saved.revision);
    const campaignId = await launchPrivateFixture(page, adventureId, false);
    await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
    const invitation = await page.request.post(
      `/api/v1/studio/adventures/${adventureId}/invitations`,
      { data: { handle: guestHandle } },
    );
    expect(invitation.ok()).toBeTruthy();
    const invitationId = (await invitation.json()).id;
    expect(
      (
        await guest.request.post(`/api/v1/invitations/${invitationId}/respond`, {
          data: { decision: 'accept' },
        })
      ).ok(),
    ).toBeTruthy();
    await campaignDetails(page);
    await page.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await page.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(page.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/library?tab=history');
    await guest.getByRole('button', { name: 'Принять приглашение в кампанию' }).click();
    await expect(guest).toHaveURL(new RegExp(`/game/${campaignId}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await campaignDetails(page, false);
    await approachTarget(page, campaignId, 'keeper');
    expect((await readProjection(page, campaignId)).entities.some((e) => e.id === 'helper')).toBe(
      true,
    );
    // Both independent actors deliberately stand near the same live NPC. The
    // authored preset pins the helper's patrol target to its spawn, not a test teleport.
    await approachHelper(guest);
    await approachHelper(page);
    // Legacy help action no longer has a dedicated visible button. Keep its
    // command/privacy contract and the current obligation UI as split coverage.
    const help = await page.request.post(`/api/v1/game/campaigns/${campaignId}/commands`, {
      data: {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'action',
        action: { kind: 'talk', targetId: 'helper' },
      },
    });
    expect(help.ok()).toBeTruthy();
    expect((await help.json()).status).toBe('committed');
    await campaignDetails(page);
    await expect(page.locator('[data-npc-obligation="proposed"]')).toBeVisible();
    await reconfirmKnownStale(
      page,
      campaignId,
      { type: 'npc.promise', npcId: 'helper', decision: 'accept' },
      async () => {
        const accept = page.getByRole('button', { name: 'Принять обещание', exact: true });
        await expect(accept).toBeEnabled();
        await accept.click();
      },
    );
    await expect(page.locator('[data-npc-obligation="fulfilled"]')).toBeVisible();
    await campaignDetails(page, false);
    await expect((await inventory(page)).locator('[data-inventory-id="token"]')).toBeVisible();
    await closeInventory(page);
    expect((await readProjection(guest, campaignId)).inventory.some((e) => e.id === 'token')).toBe(
      false,
    );
    await expect((await inventory(guest)).locator('[data-inventory-id="token"]')).toHaveCount(0);
    await closeInventory(guest);
    await expect(guest.locator('[data-npc-obligation]')).toHaveCount(0);
    await expect(guest.locator('[data-story-code="fulfilled"]')).toBeVisible();
    // Whisper is spatial now, not a two-party private channel. Keep this transport
    // privacy fixture outside both the player's and helper's one-cell hearing area.
    // A bystander next to the helper could hear its reply without having heard the
    // original whisper, which correctly makes that reply context fail closed.
    const guestMap = guest.locator('[data-camera-scale]');
    await guestMap.locator('canvas').scrollIntoViewIfNeeded();
    const cameraX = Number(await guestMap.getAttribute('data-camera-x'));
    const cameraY = Number(await guestMap.getAttribute('data-camera-y'));
    const cameraScale = Number(await guestMap.getAttribute('data-camera-scale'));
    await guestMap.locator('canvas').click({
      position: { x: cameraX + 3.5 * 48 * cameraScale, y: cameraY + 3.5 * 48 * cameraScale },
    });
    await expect
      .poll(async () => {
        const projection = await readProjection(guest, campaignId);
        const actor = projection.entities.find((entity) => entity.id === projection.actorId)!;
        return [actor.x, actor.y];
      })
      .toEqual([3, 3]);
    const speech = page.getByTestId('unified-story');
    await approachHelper(page);
    const privacyProjection = await readProjection(page, campaignId);
    const speaker = privacyProjection.entities.find(
      (entity) => entity.id === privacyProjection.actorId,
    )!;
    const helper = privacyProjection.entities.find((entity) => entity.id === 'helper')!;
    for (const origin of [speaker, helper])
      expect(Math.abs(origin.x - 3) + Math.abs(origin.y - 3)).toBeGreaterThan(1);
    await mapAction(page, campaignId, 'helper', 'Сказать');
    await expect(page.getByText('PRIVATE_AUTHOR_FACT_TITLE', { exact: true })).toHaveCount(0);
    await speech.getByRole('button', { name: 'Шёпот', exact: true }).click();
    async function say(text: string) {
      await speech.getByLabel('Твой ход', { exact: true }).fill(text);
      const quoting = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/v1/game/campaigns/${campaignId}/turns/quote`,
      );
      await speech.getByRole('button', { name: 'Отправить', exact: true }).click();
      const quoteResponse = await quoting;
      const quote = await quoteResponse.json();
      expect(quoteResponse.ok(), JSON.stringify(quote)).toBeTruthy();
      expect(quote.status, JSON.stringify(quote)).toBe('quoted');
      expect(quoteResponse.request().postDataJSON()).toMatchObject({
        targetNpcId: 'helper',
        channel: 'whisper',
      });
      await expect(speech.getByTestId('story-quote')).toBeVisible();
      const response = page.waitForResponse(
        (r) => /\/turns$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
      );
      await speech.getByRole('button', { name: 'Подтвердить ход', exact: true }).click();
      const receipt = await (await response).json();
      await expect(speech.getByLabel('Твой ход', { exact: true })).toHaveValue('', {
        timeout: 30000,
      });
      return receipt.id as string;
    }
    const firstSpokenTurn = await say('Thank you, helper.');
    await expect(
      speech.locator(`[data-story-turn="${firstSpokenTurn}"][data-story-kind="npc_reply"]`),
    ).toBeVisible();
    await expect(guest.getByText(/Thank you, helper/)).toHaveCount(0);
    await say('Who built the fountain?');
    await expect(speech).toContainText('The fountain was built by an astronomer.');
    await expect(guest.getByTestId('story-feed')).not.toContainText(
      'The fountain was built by an astronomer.',
    );

    await Promise.all([page.reload(), guest.reload()]);
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await campaignDetails(page, false);
    await expect(guest.getByText(/Thank you, helper/)).toHaveCount(0);
    await expect((await inventory(page)).locator('[data-inventory-id="token"]')).toBeVisible();
    await closeInventory(page);
    expect((await readProjection(guest, campaignId)).inventory.some((e) => e.id === 'token')).toBe(
      false,
    );
    await expect((await inventory(guest)).locator('[data-inventory-id="token"]')).toHaveCount(0);
    await closeInventory(guest);
    await expect(guest.locator('[data-npc-obligation]')).toHaveCount(0);
    await expect(guest.locator('[data-story-code="fulfilled"]')).toBeVisible();
    await campaignDetails(page);
    await expect(page.locator('[data-npc-obligation="fulfilled"]')).toBeVisible();
    await campaignDetails(page, false);
    await expect(speech.getByText(/Thank you, helper/)).toBeVisible();
    // OOC controls were intentionally removed. Its retained transport must still
    // remain separate from authoritative story canon and visible story output.
    await expect(speech.getByRole('tab', { name: 'Вне игры', exact: true })).toHaveCount(0);
    const chat = await page.request.post(`/api/v1/game/campaigns/${campaignId}/chat`, {
      data: { operationId: randomUUID(), text: 'OOC_ONLY_PLAN_742' },
    });
    expect(chat.ok()).toBeTruthy();
    const guestChat = await guest.request.get(`/api/v1/game/campaigns/${campaignId}/chat`);
    expect(guestChat.ok()).toBeTruthy();
    expect(JSON.stringify(await guestChat.json())).toContain('OOC_ONLY_PLAN_742');
    await expect(page.getByTestId('story-feed')).not.toContainText('OOC_ONLY_PLAN_742');
    await expect(guest.getByTestId('story-feed')).not.toContainText('OOC_ONLY_PLAN_742');
    // Reload cleared recipient/channel. A typed attempt is previewed inline and never executed merely by typing.
    await speech.getByLabel('Твой ход', { exact: true }).fill('*wait*');
    await speech.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(speech.getByTestId('story-quote')).toContainText('Ждать');
    const confirmed = page.waitForResponse(
      (r) => /\/turns$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    );
    await speech.getByRole('button', { name: 'Подтвердить ход', exact: true }).click();
    expect((await confirmed).ok()).toBeTruthy();
    await expect(speech.getByLabel('Твой ход', { exact: true })).toHaveValue('', {
      timeout: 30000,
    });
    // Legacy session AI/budget controls are no longer part of the player sidebar.
    for (const client of [page, guest]) {
      await expect(client.getByTestId('game-advanced')).toHaveCount(0);
      await expect(
        client.getByRole('region', { name: 'Бюджет организатора', exact: true }),
      ).toHaveCount(0);
      await expect(
        client.getByRole('region', { name: 'Проверка AI-операции', exact: true }),
      ).toHaveCount(0);
      await expect(
        client.getByText('Это временные игровые изображения. Целевой стиль — рисованный 2D.'),
      ).toHaveCount(0);
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await guestContext.close();
  }
});
