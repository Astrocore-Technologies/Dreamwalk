import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { withShellPreferences } from './support/shell-preferences';

async function request(page: Page, path: string, data?: unknown, method = 'POST') {
  const response =
    data === undefined
      ? await page.request.get(`/api/v1${path}`)
      : await page.request.fetch(`/api/v1${path}`, { method, data });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}
async function fixture(page: Page) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  await request(page, '/auth/register', {
    email: `lore-${suffix}@example.test`,
    handle: `lore_${suffix}`,
    name: 'Synthetic lore author',
    password: `Test-${randomUUID()}!`,
  });
  await request(page, '/account/settings', { language: 'en', theme: 'dark' }, 'PATCH');
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  return request(page, '/studio/adventures', {
    title: 'Synthetic character composition',
    visibility: 'private',
    content: {
      locations: [{ id: 'hall', name: 'Synthetic hall', description: 'Synthetic setting' }],
    },
  });
}

test('story NPC and lore composition retains private drafts, selection, validation, deletion focus and previews', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const story = await fixture(page);
  const root = `/studio/adventures/${story.id}`;
  const first = await request(page, `${root}/npcs`, {
    requestId: randomUUID(),
    expectedStoryRevision: story.editRevision,
    npc: {
      name: 'Synthetic keeper',
      description: 'Public keeper description',
      secrets: 'Private keeper secret',
      role: 'Keeper',
    },
  });
  const second = await request(page, `${root}/npcs`, {
    requestId: randomUUID(),
    expectedStoryRevision: first.storyEditRevision,
    npc: {
      name: 'Synthetic scout',
      description: 'Public scout description',
      secrets: 'Private scout secret',
      role: 'Scout',
    },
  });
  const current = await request(page, root);
  const lorebook = [
    {
      id: 'keeper-fact',
      title: 'Keeper fact',
      text: 'Private keeper knowledge',
      disclosure: 'never',
      knowerNpcIds: [first.npc.id],
      locationId: 'hall',
      topics: ['key'],
      publicQuestion: 'Where is the key?',
    },
    {
      id: 'scout-fact',
      title: 'Scout fact',
      text: 'Private scout knowledge',
      disclosure: 'asked',
      knowerNpcIds: [second.npc.id],
    },
  ];
  await request(
    page,
    root,
    { expectedEditRevision: current.editRevision, content: { ...current.content, lorebook } },
    'PATCH',
  );
  let dispatches = 0;
  await page.route(
    /\/api\/v1\/(?:npc-ai|story-builds|image-generation)\/.*(?:dispatch|jobs|quote|generate)/,
    async (route) => {
      dispatches++;
      await route.abort();
    },
  );
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(root);
  const nav = page.getByRole('navigation', { name: 'Adventure creation steps' });
  await nav.getByRole('button').nth(3).click();
  const npcPanel = page.getByTestId('story-npc-editor').locator('..');
  const publicPreview = page.getByTestId('story-npc-preview');
  await expect(publicPreview).toContainText('Public keeper description');
  await expect(publicPreview).not.toContainText('Private keeper secret');
  await npcPanel.getByRole('button', { name: 'Synthetic scout', exact: true }).click();
  await expect(publicPreview).toContainText('Public scout description');
  await expect(publicPreview).not.toContainText('Private scout secret');
  await npcPanel
    .locator('.row')
    .filter({ has: page.getByRole('button', { name: 'Synthetic scout', exact: true }) })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const npcName = npcPanel.getByRole('textbox', { name: 'NPC name', exact: true });
  await npcName.fill('');
  await npcPanel.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(npcName).toBeFocused();
  await npcName.fill('Synthetic scout revised');
  const npcSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && response.url().endsWith(`/npcs/${second.npc.id}`),
  );
  await npcPanel.getByRole('button', { name: 'Save character', exact: true }).click();
  expect((await npcSaved).ok()).toBeTruthy();
  await expect(npcPanel.getByRole('status')).toContainText('Character saved');
  await npcPanel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(publicPreview).toContainText('Synthetic scout revised');
  expect(
    (await request(page, `${root}/npcs`)).npcs.find(
      (npc: { id: string }) => npc.id === second.npc.id,
    ).secrets,
  ).toBe('Private scout secret');

  const lore = page.getByTestId('story-lorebook-editor');
  const collection = lore.locator('[data-studio-collection="lore"]');
  await collection.getByRole('button', { name: 'Scout fact', exact: true }).click();
  const secondTitle = lore.getByRole('textbox', { name: 'Entry title 2', exact: true });
  await secondTitle.fill('Scout fact revised');
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await collection.getByRole('button', { name: 'Keeper fact', exact: true }).click();
  const firstTitle = lore.getByRole('textbox', { name: 'Entry title 1', exact: true });
  await firstTitle.fill('');
  await collection.getByRole('button', { name: 'Scout fact revised', exact: true }).click();
  await expect(collection.locator('button[aria-invalid="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-autosave-status="invalid"]').first()).toBeVisible();
  expect((await request(page, root)).content.lorebook[0].title).toBe('Keeper fact');
  await collection.locator('button[aria-invalid="true"]').click();
  await expect(firstTitle).toHaveValue('');
  await firstTitle.fill('Keeper fact');
  await expect(firstTitle).toBeFocused();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();

  // Save failure keeps the selected entry and all private fields; manual retry uses CAS.
  let failSave = true;
  await page.route(`**/api/v1${root}`, async (route) => {
    if (route.request().method() === 'PATCH' && failSave) {
      failSave = false;
      await route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } });
    } else await route.continue();
  });
  await firstTitle.fill('Keeper fact revised');
  await expect(page.locator('[data-autosave-status="error"]').first()).toBeVisible();
  await expect(firstTitle).toHaveValue('Keeper fact revised');
  await page.locator('[data-autosave-status="error"]').first().getByRole('button').click();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await page.unroute(`**/api/v1${root}`);

  await lore
    .getByRole('combobox', { name: 'Character to preview', exact: true })
    .selectOption(first.npc.id);
  await lore.getByRole('combobox', { name: 'Related location', exact: true }).selectOption('hall');
  await lore.getByRole('textbox', { name: 'Conversation topic', exact: true }).fill('key');
  await lore.getByRole('button', { name: 'Preview knowledge selection', exact: true }).click();
  const result = lore.getByTestId('lore-preview-result');
  await expect(result).toContainText('Private keeper knowledge');
  await expect(result).not.toContainText('Private scout knowledge');
  await lore.getByRole('textbox', { name: 'Conversation topic', exact: true }).fill('new topic');
  await expect(lore.getByRole('status')).toContainText('The draft changed');
  await expect(result).toHaveCount(0);

  // Collection selection never removes mounted inputs or resets draft values.
  await collection.getByRole('button', { name: 'Add lore entry', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(lore.getByRole('textbox', { name: 'Entry title 3', exact: true })).toHaveValue('');
  await lore.getByRole('button', { name: 'Remove Entry title 3', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    collection.getByRole('button', { name: 'Keeper fact revised', exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  const persisted = await request(page, root);
  expect(persisted.content.lorebook).toEqual([
    { ...lorebook[0], title: 'Keeper fact revised' },
    { ...lorebook[1], title: 'Scout fact revised' },
  ]);
  expect(persisted.visibility).toBe('private');
  expect(persisted.status).toBe('draft');
  await page.reload();
  await nav.getByRole('button').nth(3).click();
  await expect(firstTitle).toHaveValue('Keeper fact revised');

  for (const locale of ['ru', 'uk', 'en']) {
    for (const viewport of [
      { width: 1536, height: 1024, theme: 'dark' },
      { width: 390, height: 844, theme: 'light' },
    ]) {
      await page.setViewportSize(viewport);
      await withShellPreferences(page, async () => {
        await page.locator('.locale-select').selectOption(locale);
        if ((await page.locator('html').getAttribute('data-theme')) !== viewport.theme)
          await page.locator('.theme-button').click();
      });
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
      });
      const path = info.outputPath(`story-npc-lore-${locale}-${viewport.width}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await info.attach(`story-npc-lore-${locale}-${viewport.width}`, {
        path,
        contentType: 'image/png',
      });
    }
  }
  // Removing the final record returns keyboard focus to Add and persists an empty lorebook.
  await lore.getByRole('button', { name: 'Remove Entry title 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    collection.getByRole('button', { name: 'Scout fact revised', exact: true }),
  ).toBeFocused();
  await lore.getByRole('button', { name: 'Remove Entry title 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    collection.getByRole('button', { name: 'Add lore entry', exact: true }),
  ).toBeFocused();
  await expect(lore.getByText('No entries', { exact: true })).toBeVisible();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  expect((await request(page, root)).content.lorebook).toEqual([]);
  expect(dispatches).toBe(0);
});

test('story character loading, read failure, retry and empty states remain distinct', async ({
  page,
}) => {
  const story = await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route(`**/api/v1/studio/adventures/${story.id}/npcs`, async (route) => {
    await pending;
    if (fail) await route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } });
    else await route.continue();
  });
  await page.goto(`/studio/adventures/${story.id}`);
  await page
    .getByRole('navigation', { name: 'Adventure creation steps' })
    .getByRole('button')
    .nth(3)
    .click();
  const panel = page.getByTestId('story-npc-editor').locator('..');
  await expect(panel.getByRole('status', { name: 'Loading' })).toBeVisible();
  await expect(
    panel.getByText('Create a character or copy a template.', { exact: true }),
  ).toHaveCount(0);
  release();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(
    panel.getByText('Create a character or copy a template.', { exact: true }),
  ).toHaveCount(0);
  fail = false;
  await panel.getByRole('alert').getByRole('button').click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(
    panel.getByText('Create a character or copy a template.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('story-npc-preview')).toHaveCount(0);
  await expect(
    page
      .getByTestId('story-lorebook-editor')
      .getByRole('button', { name: 'Add lore entry', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: 'Create NPC here', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'NPC name', exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    panel.getByText('Create a character or copy a template.', { exact: true }),
  ).toBeVisible();
});
