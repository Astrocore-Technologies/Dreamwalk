import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import {
  authoringRequest,
  savePrivateFixture,
  launchPrivateFixture,
} from './support/private-authoring';

test.afterEach(async ({ page }, info) => {
  if (info.status === 'passed') {
    await info.attach('character-ui-success', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
});

async function register(page: Page) {
  const handle = `character_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  expect(
    (
      await page.request.post('/api/v1/auth/register', {
        data: {
          handle,
          email: `${handle}@example.test`,
          name: 'Character QA',
          password: `Test-${randomUUID()}!`,
        },
      })
    ).status(),
  ).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
}

test('scoped character profile and lore save, discard and preview preserve author intent without a model call', async ({
  page,
}) => {
  test.setTimeout(90000);
  await register(page);
  const story = await authoringRequest(page, '/studio/adventures', {
    title: 'Характеры и знания',
    content: {
      locations: [{ id: 'workshop', name: 'Мастерская', description: 'Private fixture' }],
    },
  });
  const root = `/studio/adventures/${story.id}`;
  const models = await authoringRequest(page, '/models');
  expect(models.length).toBeGreaterThan(0);
  const profile = {
    version: 1,
    initialGoal: 'patrol',
    personality: {
      role: 'guard',
      values: ['duty'],
      taboos: ['steal', 'disclose_private'],
      speechStyle: '',
      characterization: {
        version: 1,
        motives: [{ kind: 'protect', priority: 3 }],
        reactions: [],
        publicVoice: { cadence: 'brief', register: 'plain', humor: 'none' },
        dialogueExamples: [],
      },
    },
  };
  const first = await authoringRequest(page, `${root}/npcs`, {
    requestId: randomUUID(),
    expectedStoryRevision: story.editRevision,
    npc: { name: 'Северин', characterProfile: profile, modelProfileId: models[0].id },
  });
  const second = await authoringRequest(page, `${root}/npcs`, {
    requestId: randomUUID(),
    expectedStoryRevision: first.storyEditRevision,
    npc: { name: 'Мира' },
  });
  let dispatches = 0;
  await page.route(
    /\/api\/v1\/(?:npc-ai|story-builds|image-generation)\/.*(?:dispatch|jobs|quote|generate)/,
    async (route) => {
      dispatches++;
      await route.abort();
    },
  );
  await page.goto(`/studio/adventures/${story.id}`);
  await page.getByRole('button', { name: /NPC$/ }).click();
  // Scope via the stable heading's parent Panel, not an option-dependent label.
  const panel = page.getByTestId('story-npc-editor').locator('..');
  await panel
    .locator('.row')
    .filter({ hasText: 'Северин' })
    .getByRole('button', { name: 'Редактировать', exact: true })
    .click();
  await expect(panel.getByTestId('npc-character-profile')).toHaveCount(0);
  await expect(panel.getByLabel('Стиль поведения', { exact: true })).toHaveCount(0);
  await panel.getByLabel('Первая реплика', { exact: true }).fill('Назови своё дело.');
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && response.url().endsWith(`/npcs/${first.npc.id}`),
  );
  await panel.getByRole('button', { name: 'Сохранить персонажа', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(panel.getByRole('status')).toContainText('Персонаж сохранён');
  const stored = (await authoringRequest(page, `${root}/npcs`)).npcs.find(
    (npc: { id: string }) => npc.id === first.npc.id,
  );
  expect(stored.characterProfile.personality.characterization.motives).toEqual([
    { kind: 'protect', priority: 3 },
  ]);
  expect(stored.characterProfile.personality.characterization.publicVoice.cadence).toBe('brief');
  expect(stored.characterProfile).toEqual(first.npc.characterProfile);
  expect(stored.modelProfileId).toBe(first.npc.modelProfileId);
  await panel.getByLabel('Первая реплика', { exact: true }).fill('Не сохранять.');
  await panel.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const discard = page.getByRole('dialog', { name: 'Закрыть без сохранения?' });
  await discard
    .getByRole('button', { name: 'Закрыть', exact: true })
    .filter({ hasNotText: '×' })
    .last()
    .click();
  await expect(discard).toHaveCount(0);
  await panel
    .locator('.row')
    .filter({ hasText: 'Северин' })
    .getByRole('button', { name: 'Редактировать', exact: true })
    .click();
  await expect(panel.getByLabel('Первая реплика', { exact: true })).toHaveValue(
    'Назови своё дело.',
  );
  await panel.getByRole('button', { name: 'Закрыть', exact: true }).click();

  const lore = page.getByTestId('story-lorebook-editor');
  await lore.getByRole('button', { name: 'Добавить запись лора', exact: true }).click();
  await lore.getByLabel('Название записи 1', { exact: true }).fill('Тайник Северина');
  await lore.getByLabel('Содержание знания 1', { exact: true }).fill('Ключ лежит под верстаком.');
  await lore
    .getByRole('combobox', { name: 'Персонаж для проверки', exact: true })
    .selectOption(second.npc.id);
  await lore.getByRole('button', { name: 'Проверить отбор знаний', exact: true }).click();
  const preview = lore.getByTestId('lore-preview-result');
  await expect(preview).toContainText('Персонаж не знает запись');
  await expect(preview).not.toContainText('Ключ лежит под верстаком.');
  await lore
    .getByRole('combobox', { name: 'Персонаж для проверки', exact: true })
    .selectOption(first.npc.id);
  await expect(lore.getByRole('status')).toContainText('Черновик изменился');
  await lore.getByRole('button', { name: 'Проверить отбор знаний', exact: true }).click();
  await expect(preview).toContainText('Ключ лежит под верстаком.');
  const persisted = await authoringRequest(page, root);
  expect(persisted.content.lorebook[0].knowerNpcIds).toEqual([first.npc.id]);
  await page.reload();
  await page.getByRole('button', { name: /NPC$/ }).click();
  await expect(
    page.getByTestId('story-lorebook-editor').getByLabel('Содержание знания 1', { exact: true }),
  ).toHaveValue('Ключ лежит под верстаком.');
  expect(dispatches).toBe(0);
});

test('narrative presentation saves once, survives reload and explicitly resolves stale preferences without game mutation', async ({
  page,
}) => {
  test.setTimeout(90000);
  await register(page);
  const story = await authoringRequest(page, '/studio/adventures', {
    title: 'Подача повествования',
  });
  await savePrivateFixture(page, story.id, createAuthoredDraft('courtyard'));
  const id = await launchPrivateFixture(page, story.id, true);
  await expect(page.locator('[data-connected]')).toHaveAttribute('data-connected', 'true');
  const path = `/game/campaigns/${id}/narrative-preferences`;
  const before = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  const panel = page.getByTestId('narrative-preferences');
  await panel.locator('summary').click();
  await expect(
    panel.getByRole('combobox', { name: 'Подробность описаний', exact: true }),
  ).toHaveValue('balanced');
  await panel
    .getByRole('combobox', { name: 'Подробность описаний', exact: true })
    .selectOption('concise');
  await panel
    .getByRole('combobox', { name: 'Как обращаться к вашему герою', exact: true })
    .selectOption('she');
  const saveBodies: unknown[] = [];
  await page.route(`**/api/v1${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saveBodies.push(route.request().postDataJSON());
    if (saveBodies.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBeTruthy();
      return route.abort('connectionclosed'); // The server committed; the browser did not receive its receipt.
    }
    return route.continue();
  });
  await panel.getByRole('button', { name: 'Сохранить подачу', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect((await authoringRequest(page, path)).revision).toBe(1);
  await expect(panel.getByRole('status')).toContainText('настройки могли сохраниться');
  await expect(
    panel.getByRole('button', { name: 'Отменить изменения', exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('combobox', { name: 'Подробность описаний', exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('combobox', { name: 'Как обращаться к вашему герою', exact: true }),
  ).toHaveValue('she');
  await panel.getByRole('button', { name: 'Сохранить подачу', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  expect(saveBodies).toHaveLength(2);
  expect(saveBodies[1]).toEqual(saveBodies[0]);

  const first = await authoringRequest(page, path);
  expect(first.revision).toBe(1);
  expect(first.settings.formOfAddress).toBe('she');
  const after = await authoringRequest(page, `/game/campaigns/${id}/snapshot`);
  expect(after.projection.revision).toBe(before.projection.revision);
  await page.reload();
  await expect(page.locator('[data-connected]')).toHaveAttribute('data-connected', 'true');
  await panel.locator('summary').click();
  await expect(
    panel.getByRole('combobox', { name: 'Как обращаться к вашему герою', exact: true }),
  ).toHaveValue('she');
  await authoringRequest(page, path, {
    operationId: randomUUID(),
    expectedRevision: first.revision,
    settings: { ...first.settings, dialogueFormat: 'quoted' },
  });
  await panel
    .getByRole('combobox', { name: 'Подробность описаний', exact: true })
    .selectOption('descriptive');
  await panel.getByRole('button', { name: 'Сохранить подачу', exact: true }).click();
  await expect(
    panel.getByText(
      'Настройки изменились в другой вкладке. Сверьте серверную версию перед сохранением.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Сохранить подачу', exact: true })).toBeDisabled();
  await panel
    .getByRole('button', { name: 'Загрузить серверную версию и отменить мои правки', exact: true })
    .click();
  await expect(
    panel.getByRole('combobox', { name: 'Оформление прямой речи', exact: true }),
  ).toHaveValue('quoted');
  await expect(
    panel.getByRole('combobox', { name: 'Подробность описаний', exact: true }),
  ).toHaveValue('concise');
});
