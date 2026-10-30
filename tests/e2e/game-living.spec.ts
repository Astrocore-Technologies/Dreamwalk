import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function approachHelper(page: Page) {
  const helper = page.locator('[data-entity-id="helper"]');
  await expect(helper).toBeVisible();
  await helper.getByRole('button', { name: 'Подойти', exact: true }).click();
  const position = page.getByTestId('game-position');
  await expect
    .poll(
      async () =>
        Math.abs(
          Number(await position.getAttribute('data-x')) -
            Number(await helper.getAttribute('data-x')),
        ) +
        Math.abs(
          Number(await position.getAttribute('data-y')) -
            Number(await helper.getAttribute('data-y')),
        ),
    )
    .toBeLessThanOrEqual(1);
}

test('living author version saves personality and reacts without manual NPC request', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const guest = await guestContext.newPage();
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
    await page.getByRole('button', { name: /Локации$/ }).click();
    const editor = page.getByRole('region', { name: 'Игровая карта', exact: true });
    await editor
      .getByRole('button', { name: 'Шаблон: смотритель и помощник', exact: true })
      .click();
    await editor.getByLabel('Объект на карте', { exact: true }).selectOption('npc:keeper');
    await editor.getByLabel('Публичная манера речи', { exact: true }).selectOption('warm');
    await editor.getByLabel('Держать обещания', { exact: true }).check();
    await editor
      .getByRole('group', { name: 'Важные связи', exact: true })
      .getByLabel('Помощник', { exact: true })
      .check();
    await editor.getByRole('button', { name: 'Добавить пример решения', exact: true }).click();
    await editor.getByLabel('Ситуация 1', { exact: true }).fill('Someone asks for help.');
    await editor.getByLabel('Решение 1', { exact: true }).fill('Check what I can safely offer.');
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/playable-draft') &&
        r.request().method() === 'PUT' &&
        r
          .request()
          .postDataJSON()
          ?.draft?.npcs?.some(
            (npc: { personality?: { biography?: string } }) =>
              npc.personality?.biography === 'Protect the courtyard, not a secret live memory.',
          ),
    );
    await editor
      .getByLabel('Биография и мотивы', { exact: true })
      .fill('Protect the courtyard, not a secret live memory.');
    expect((await saved).ok()).toBeTruthy();
    await expect(editor.locator('[data-autosave-status="saved"]')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: /Локации$/ }).click();
    await editor.getByLabel('Объект на карте', { exact: true }).selectOption('npc:keeper');
    await expect(editor.getByLabel('Биография и мотивы', { exact: true })).toHaveValue(
      'Protect the courtyard, not a secret live memory.',
    );
    await expect(editor.getByLabel('Публичная манера речи', { exact: true })).toHaveValue('warm');
    await expect(editor.getByLabel('Держать обещания', { exact: true })).toBeChecked();
    await expect(editor.getByLabel('Решение 1', { exact: true })).toHaveValue(
      'Check what I can safely offer.',
    );
    await editor
      .getByRole('button', { name: 'Сохранить и проверить восприятие', exact: true })
      .click();
    await expect(editor.getByText(/Проверена версия черновика/)).toBeVisible();
    await editor.getByRole('button', { name: 'Сохранить и проверить в игре', exact: true }).click();
    await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
    await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
    const campaignId = new URL(page.url()).pathname.split('/').at(-1)!;
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
    await page.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await page.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(page.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/game');
    await guest.getByRole('button', { name: 'Принять приглашение в кампанию' }).click();
    await expect(guest).toHaveURL(new RegExp(`/game/${campaignId}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    const helper = page.locator('[data-entity-id="helper"]');
    // The helper becomes visible after approaching the keeper in the initial scene.
    await page
      .locator('[data-entity-id="keeper"]')
      .getByRole('button', { name: 'Подойти', exact: true })
      .click();
    await expect(helper).toBeVisible();
    // Both independent actors deliberately stand near the same live NPC. The
    // authored preset pins the helper's patrol target to its spawn, not a test teleport.
    await approachHelper(guest);
    await approachHelper(page);
    await helper.getByRole('button', { name: 'Попросить помощи', exact: true }).click();
    await expect(page.locator('[data-npc-obligation="fulfilled"]')).toBeVisible();
    await expect(page.locator('[data-inventory-id="token"]')).toBeVisible();
    await expect(guest.locator('[data-inventory-id="token"]')).toHaveCount(0);
    await expect(guest.locator('[data-npc-obligation]')).toHaveCount(0);
    await expect(guest.locator('[data-npc-notice="fulfilled"]')).toBeVisible();
    const speech = page.getByRole('region', { name: 'Разговор с NPC', exact: true });
    await approachHelper(page);
    await speech.getByLabel('Собеседник', { exact: true }).selectOption('helper');
    await speech.getByLabel('Канал разговора', { exact: true }).selectOption('whisper');
    await speech.getByLabel('Реплика', { exact: true }).fill('Thank you, helper.');
    await speech.getByRole('button', { name: 'Произнести', exact: true }).click();
    await expect(speech.locator('[data-npc-utterance="acknowledged"]')).toBeVisible();
    await expect(guest.getByText(/Thank you, helper/)).toHaveCount(0);
    await Promise.all([page.reload(), guest.reload()]);
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(guest.getByText(/Thank you, helper/)).toHaveCount(0);
    await expect(page.locator('[data-inventory-id="token"]')).toBeVisible();
    await expect(guest.locator('[data-inventory-id="token"]')).toHaveCount(0);
    await expect(guest.locator('[data-npc-obligation]')).toHaveCount(0);
    await expect(guest.locator('[data-npc-notice="fulfilled"]')).toBeVisible();
    await expect(page.locator('[data-npc-obligation="fulfilled"]')).toBeVisible();
    await expect(speech.getByText(/Thank you, helper/)).toBeVisible();
    const budget = page.getByRole('region', { name: 'Проверка AI-операции', exact: true });
    await expect(budget.getByText('Тестовый планировщик доступен', { exact: true })).toBeVisible();
    const quoteResponse = page.waitForResponse(
      (r) => r.url().endsWith('/ai/quote') && r.request().method() === 'POST',
    );
    await budget.getByRole('button', { name: 'Узнать стоимость', exact: true }).click();
    expect((await quoteResponse).ok()).toBeTruthy();
    await expect(budget.getByText('Стоимость: 0 искр', { exact: true })).toBeVisible();
    const queued = page.waitForResponse(
      (r) => r.url().endsWith('/ai/jobs') && r.request().method() === 'POST',
    );
    await budget
      .getByRole('button', { name: 'Подтвердить тестовую операцию', exact: true })
      .click();
    expect((await queued).ok()).toBeTruthy();
    await budget.getByLabel('Тип AI-операции', { exact: true }).selectOption('speech');
    await budget.getByLabel('Спросить об объекте', { exact: true }).selectOption('helper');
    const topicalQuote = page.waitForResponse(
      (r) => r.url().endsWith('/ai/quote') && r.request().postDataJSON()?.topicId === 'helper',
    );
    await budget.getByRole('button', { name: 'Узнать стоимость', exact: true }).click();
    expect((await topicalQuote).ok()).toBeTruthy();
    await budget.getByLabel('Спросить об объекте', { exact: true }).selectOption('');
    await expect(
      budget.getByRole('button', { name: 'Подтвердить тестовую операцию', exact: true }),
    ).toHaveCount(0);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await guestContext.close();
  }
});
