import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function preferences(page: Page, locale: string, theme: string) {
  const hidden = !(await page.locator('.locale-select').isVisible());
  if (hidden) await page.locator('.mobile-menu').click();
  await page.locator('.locale-select').selectOption(locale);
  if ((await page.locator('html').getAttribute('data-theme')) !== theme)
    await page.locator('.theme-button').click();
  if (hidden) await page.locator('.mobile-close').click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

// Shared buttons stay disabled until their mount effect completes. Focus alone does not
// wait for actionability, so verify the actual keyboard target before pressing Enter.
async function activateWithKeyboard(page: Page, control: Locator) {
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
}

test('inner story workspace preserves complete drafts while selecting locations and scenes', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const suffix = randomUUID().slice(0, 8);
  expect(
    (
      await page.request.post('/api/v1/auth/register', {
        data: {
          email: `inner-${suffix}@example.test`,
          handle: `inner_${suffix}`,
          name: 'Synthetic inner studio author',
          password: `Inner-${randomUUID()}!`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.patch('/api/v1/account/settings', {
        data: { language: 'en', theme: 'dark' },
      })
    ).ok(),
  ).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  const locations = [
    { id: randomUUID(), name: 'Synthetic hall', description: 'A quiet hall.' },
    { id: randomUUID(), name: 'Synthetic garden', description: 'A walled garden.' },
  ];
  const scenes = locations.map((location, i) => ({
    id: randomUUID(),
    name: `Synthetic scene ${i + 1}`,
    locationId: location.id,
    description: 'Synthetic opening situation.',
  }));
  const created = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Synthetic inner workspace',
      synopsis: 'A local interface test.',
      visibility: 'private',
      cover: 'observatory',
      content: {
        world: 'Synthetic world',
        rules: 'Synthetic rules',
        locations,
        scenes,
        startSceneId: scenes[0].id,
        npcIds: [],
        boundaries: ['Synthetic custom warning'],
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const story = await created.json();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(`/studio/adventures/${story.id}`);
  const nav = page.getByRole('navigation', { name: 'Adventure creation steps' });
  await nav.getByRole('button').nth(2).click();
  const locationEditor = page.locator('[data-studio-collection="locations"]');
  await locationEditor.getByRole('button', { name: locations[1].name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Location name', exact: true })).toHaveValue(
    locations[1].name,
  );
  await page
    .getByRole('textbox', { name: 'Location name', exact: true })
    .fill('Synthetic garden revised');
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await locationEditor.getByRole('button', { name: locations[0].name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Location name', exact: true })).toHaveValue(
    locations[0].name,
  );
  await nav.getByRole('button').nth(4).click();
  const sceneEditor = page.locator('[data-studio-collection="scenes"]');
  await sceneEditor.getByRole('button', { name: scenes[1].name, exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Scene name', exact: true })
    .fill('Synthetic scene revised');
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  await sceneEditor.getByRole('button', { name: scenes[0].name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Scene name', exact: true })).toHaveValue(
    scenes[0].name,
  );
  const persisted = await (await page.request.get(`/api/v1/studio/adventures/${story.id}`)).json();
  expect(persisted.content.locations).toEqual([
    locations[0],
    { ...locations[1], name: 'Synthetic garden revised' },
  ]);
  expect(persisted.content.scenes).toEqual([
    scenes[0],
    { ...scenes[1], name: 'Synthetic scene revised' },
  ]);
  expect(persisted.content.startSceneId).toBe(scenes[0].id);
  expect(persisted.content.boundaries).toEqual(['Synthetic custom warning']);
  expect(persisted.status).toBe('draft');
  expect(persisted.visibility).toBe('private');

  // A hidden invalid item must remain discoverable and block the complete draft save.
  await nav.getByRole('button').nth(2).click();
  const locationName = page.getByRole('textbox', { name: 'Location name', exact: true });
  await locationName.fill('');
  await locationEditor
    .getByRole('button', { name: 'Synthetic garden revised', exact: true })
    .click();
  await expect(locationEditor.locator('button[aria-invalid="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-autosave-status="invalid"]').first()).toBeVisible();
  await expect(page.getByText('[Translation missing]', { exact: true })).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/v1/studio/adventures/${story.id}`)).json()).content
      .locations[0].name,
  ).toBe(locations[0].name);
  await locationEditor.locator('button[aria-invalid="true"]').click();
  await expect(locationName).toHaveValue('');
  await locationName.fill(locations[0].name);
  await expect(locationName).toBeFocused();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();

  // Server failure/retry and CAS conflict never replace the local item input.
  const endpoint = `**/api/v1/studio/adventures/${story.id}`;
  let failure: 'error' | 'conflict' | null = 'error';
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PATCH' && failure) {
      const code = failure === 'conflict' ? 'STALE_STATE' : 'INTERNAL_ERROR';
      failure = null;
      await route.fulfill({ status: code === 'STALE_STATE' ? 409 : 500, json: { code } });
    } else await route.continue();
  });
  await locationName.fill('Synthetic retry hall');
  await expect(page.locator('[data-autosave-status="error"]').first()).toBeVisible();
  await expect(locationName).toHaveValue('Synthetic retry hall');
  await page.locator('[data-autosave-status="error"]').first().getByRole('button').click();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  failure = 'conflict';
  await locationName.fill('Synthetic unsaved conflict');
  await expect(page.locator('[data-autosave-status="conflict"]').first()).toBeVisible();
  await locationEditor
    .getByRole('button', { name: 'Synthetic garden revised', exact: true })
    .click();
  await locationEditor
    .getByRole('button', { name: 'Synthetic unsaved conflict', exact: true })
    .click();
  await expect(locationName).toHaveValue('Synthetic unsaved conflict');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-autosave-status="conflict"]').first().getByRole('button').click();
  await expect(locationName).toHaveValue('Synthetic unsaved conflict');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-autosave-status="conflict"]').first().getByRole('button').click();
  await expect(locationName).toHaveValue('Synthetic retry hall');
  await page.unroute(endpoint);

  // Keyboard addition/removal selects the new item and restores focus after deletion.
  await activateWithKeyboard(
    page,
    locationEditor.getByRole('button', { name: 'Add location', exact: true }),
  );
  await expect(locationName).toHaveValue('Location 3');
  const deleteLocation = locationEditor.getByRole('button', {
    name: 'Delete location Location 3',
    exact: true,
  });
  await activateWithKeyboard(page, deleteLocation);
  await expect(deleteLocation).toHaveCount(0);
  await expect(
    locationEditor.getByRole('button', { name: 'Synthetic retry hall', exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();

  for (const locale of ['ru', 'uk', 'en']) {
    for (const viewport of [
      { width: 1536, height: 1024, theme: 'dark' },
      { width: 390, height: 844, theme: 'light' },
    ]) {
      await page.setViewportSize(viewport);
      await preferences(page, locale, viewport.theme);
      const steps = page.locator('nav').filter({ has: page.locator('[aria-current="step"]') });
      for (const step of [2, 4, 5, 7]) {
        await steps.getByRole('button').nth(step).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
        });
        const name = `studio-inner-${step}-${locale}-${viewport.width}-${viewport.theme}`;
        const path = info.outputPath(`${name}.png`);
        await expect(page.getByText('[Translation missing]', { exact: true })).toHaveCount(0);
        await page.screenshot({ path, fullPage: true, animations: 'disabled' });
        await info.attach(name, { path, contentType: 'image/png' });
      }
    }
  }
  // Removing the final scene returns focus to Add and preserves the empty collection.
  await page.setViewportSize({ width: 1536, height: 1024 });
  await preferences(page, 'en', 'dark');
  await nav.getByRole('button').nth(4).click();
  const deleteFirstScene = sceneEditor.getByRole('button', {
    name: 'Delete scene Synthetic scene 1',
    exact: true,
  });
  await activateWithKeyboard(page, deleteFirstScene);
  await expect(deleteFirstScene).toHaveCount(0);
  await expect(
    sceneEditor.getByRole('button', { name: 'Synthetic scene revised', exact: true }),
  ).toBeFocused();
  const deleteLastScene = sceneEditor.getByRole('button', {
    name: 'Delete scene Synthetic scene revised',
    exact: true,
  });
  await activateWithKeyboard(page, deleteLastScene);
  await expect(deleteLastScene).toHaveCount(0);
  await expect(sceneEditor.getByRole('button', { name: 'Add scene', exact: true })).toBeFocused();
  await expect(page.locator('[data-autosave-status="saved"]').first()).toBeVisible();
  const empty = await (await page.request.get(`/api/v1/studio/adventures/${story.id}`)).json();
  expect(empty.content.scenes).toEqual([]);
  expect(empty.content.startSceneId).toBe('');
  expect(empty.content.locations).toHaveLength(2);
});
