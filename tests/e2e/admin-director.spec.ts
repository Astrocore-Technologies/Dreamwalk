import { test, expect, type Page } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';
import {
  DIRECTOR_STYLE_PRESETS,
  type DirectorCatalog,
  type DirectorProfile,
} from '../../packages/contracts/src/director-style';

const initialCatalog = (): DirectorCatalog => ({
  revision: 1,
  defaultProfileId: 'coauthor',
  profiles: [
    {
      id: 'coauthor',
      name: 'Coauthor fixture',
      description: 'An open-ended, balanced story.',
      enabled: true,
      ...DIRECTOR_STYLE_PRESETS.coauthor,
    },
    {
      id: 'storyteller',
      name: 'Storyteller fixture',
      description: 'Patient atmospheric storytelling.',
      enabled: true,
      ...DIRECTOR_STYLE_PRESETS.storyteller,
    },
    {
      id: 'archived',
      name: 'Archived fixture',
      description: 'Retained for existing campaigns.',
      enabled: false,
      ...DIRECTOR_STYLE_PRESETS.director,
    },
  ],
});
const labels = {
  en: {
    title: 'AI directors',
    choose: 'Director to edit',
    name: 'Director name',
    description: 'Description for players',
    enabled: 'Available to players',
    default: 'Default',
    add: 'Add director',
    type: 'Director type',
    behavior: 'AI director behavior',
    pacing: 'Story pacing',
    save: 'Save directors',
    reload: 'Reload settings',
  },
  ru: {
    title: 'ИИ-ведущие',
    choose: 'Ведущий для настройки',
    name: 'Название ведущего',
    description: 'Описание для игроков',
    enabled: 'Доступен игрокам',
    default: 'По умолчанию',
    add: 'Добавить ведущего',
    type: 'Тип ведущего',
    behavior: 'Поведение ИИ-ведущего',
    pacing: 'Темп истории',
    save: 'Сохранить ведущих',
    reload: 'Обновить настройки',
  },
  uk: {
    title: 'ШІ-ведучі',
    choose: 'Ведучий для налаштування',
    name: 'Назва ведучого',
    description: 'Опис для гравців',
    enabled: 'Доступний гравцям',
    default: 'За замовчуванням',
    add: 'Додати ведучого',
    type: 'Тип ведучого',
    behavior: 'Поведінка ШІ-ведучого',
    pacing: 'Темп історії',
    save: 'Зберегти ведучих',
    reload: 'Оновити налаштування',
  },
} as const;
async function adminFixture(page: Page, locale: keyof typeof labels, role = 'admin') {
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
  );
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'qa-admin',
          name: 'QA',
          handle: 'qa_admin',
          role,
          settings: settingsSchema.parse({ language: locale }),
          onboarded: true,
        },
      },
    }),
  );
  await page.route('**/api/v1/admin/models', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/admin/runtimes', (route) => route.fulfill({ json: [] }));
}

// Browser protocol fixtures only. API integration tests own authorization and persistence proofs.
for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`director catalog creates, edits, archives and recovers stale behavior edits (${locale})`, async ({
    page,
  }, testInfo) => {
    await adminFixture(page, locale);
    const text = labels[locale];
    let saved = initialCatalog();
    let saves = 0;
    let conflict = false;
    await page.route('**/api/v1/admin/directors', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        expect(Object.keys(body).sort()).toEqual([
          'defaultProfileId',
          'expectedRevision',
          'profiles',
        ]);
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { code: 'DIRECTOR_STYLE_STALE', message: 'DIRECTOR_STYLE_STALE' },
          });
        expect(body.expectedRevision).toBe(saved.revision);
        // Existing identities are retained when archived, including disabled profiles.
        for (const profile of saved.profiles)
          expect(
            body.profiles.some((candidate: DirectorProfile) => candidate.id === profile.id),
          ).toBe(true);
        expect(
          body.profiles.find((profile: DirectorProfile) => profile.id === body.defaultProfileId)
            ?.enabled,
        ).toBe(true);
        saved = {
          revision: saved.revision + 1,
          defaultProfileId: body.defaultProfileId,
          profiles: body.profiles,
        };
        saves++;
      }
      return route.fulfill({ json: saved });
    });
    await page.goto('/admin/models');
    await expect(page.getByRole('heading', { name: text.title, exact: true })).toBeVisible();
    const choose = page.getByRole('combobox', { name: text.choose, exact: true });
    // Field includes its help text inside the label, so the accessible name includes the hint.
    const behavior = page
      .getByTestId('director-catalog')
      .getByRole('textbox', { name: text.behavior, exact: false });
    await expect(behavior).toHaveCount(1);
    const save = page.getByRole('button', { name: text.save, exact: true });
    await expect(choose.locator('option')).toHaveCount(3);
    await expect(choose).toHaveValue('coauthor');
    await expect(page.getByRole('combobox', { name: text.type, exact: true })).toHaveCount(0);
    await expect(page.getByTestId('director-catalog').getByRole('combobox')).toHaveCount(1);
    await expect(behavior).toHaveValue('');
    await expect(behavior).toHaveAttribute('maxlength', '4000');
    await expect(page.getByLabel(text.enabled, { exact: true })).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(page.getByRole('combobox', { name: text.pacing, exact: true })).not.toBeVisible();

    await choose.selectOption('storyteller');
    await page.getByLabel(text.name, { exact: true }).fill('Cinematic fixture');
    await page.getByLabel(text.description).fill('Fast-paced cinematic hooks.');
    await behavior.fill('  Write concise, vivid narration. Support the player’s ideas.  ');
    await choose.selectOption('coauthor');
    await expect(behavior).toHaveValue('');
    await choose.selectOption('storyteller');
    await expect(behavior).toHaveValue(
      '  Write concise, vivid narration. Support the player’s ideas.  ',
    );
    await save.click();
    await expect.poll(() => saves).toBe(1);
    expect(saved.profiles.find((profile) => profile.id === 'storyteller')).toEqual({
      id: 'storyteller',
      name: 'Cinematic fixture',
      description: 'Fast-paced cinematic hooks.',
      behaviorInstructions: 'Write concise, vivid narration. Support the player’s ideas.',
      enabled: true,
      ...DIRECTOR_STYLE_PRESETS.storyteller,
    });
    await expect(choose).toHaveValue('coauthor');
    await expect(save).toBeDisabled();

    await page.getByRole('button', { name: text.add, exact: true }).click();
    await page.getByLabel(text.name, { exact: true }).fill('New patient director');
    await page.getByLabel(text.description).fill('A patient adventure guide.');
    await behavior.fill('Let the exchange breathe. Ask thoughtful questions.');
    await page.getByLabel(text.default, { exact: true }).check();
    await save.click();
    await expect.poll(() => saves).toBe(2);
    const created = saved.profiles.find((profile) => profile.name === 'New patient director')!;
    expect(created.id).toBeTruthy();
    expect(saved.defaultProfileId).toBe(created.id);
    expect(created).toMatchObject({
      enabled: true,
      behaviorInstructions: 'Let the exchange breathe. Ask thoughtful questions.',
      ...DIRECTOR_STYLE_PRESETS.coauthor,
    });
    expect(saved.profiles).toHaveLength(4);

    await page.reload();
    await expect(choose).toHaveValue(created.id);
    await expect(page.getByLabel(text.default, { exact: true })).toBeChecked();
    await expect(behavior).toHaveValue(created.behaviorInstructions!);
    await choose.selectOption('coauthor');
    await page.getByLabel(text.enabled, { exact: true }).uncheck();
    await save.click();
    await expect.poll(() => saves).toBe(3);
    expect(saved.profiles).toHaveLength(4);
    expect(saved.profiles.find((profile) => profile.id === 'coauthor')?.enabled).toBe(false);
    expect(saved.profiles.find((profile) => profile.id === 'archived')?.enabled).toBe(false);
    await expect(choose).toHaveValue(created.id);
    await expect(save).toBeDisabled();

    await choose.selectOption('storyteller');
    await behavior.fill('A stale edit must never overwrite the newer guidance.');
    conflict = true;
    saved = { ...saved, revision: saved.revision + 1 };
    await save.click();
    await expect(page.getByTestId('director-catalog').getByRole('alert')).toBeVisible();
    expect(saves).toBe(3);
    await page.getByRole('button', { name: text.reload, exact: true }).click();
    await expect(choose).toHaveValue(created.id);
    await expect(behavior).toHaveValue(created.behaviorInstructions!);
    await expect(save).toBeDisabled();
    await expect(page.getByTestId('director-catalog').getByRole('alert')).toHaveCount(0);
    if (locale === 'en') {
      await page.screenshot({
        path: testInfo.outputPath('director-catalog-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(behavior).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('director-catalog-mobile.png'),
        fullPage: true,
      });
    }
  });
}

test('director catalog prevents adding beyond 24 profiles', async ({ page }) => {
  await adminFixture(page, 'en');
  const saved = initialCatalog();
  saved.profiles = Array.from({ length: 24 }, (_, index) => ({
    ...saved.profiles[0],
    id: index === 0 ? 'coauthor' : `fixture-${index}`,
    name: `Director ${index + 1}`,
  }));
  await page.route('**/api/v1/admin/directors', (route) => route.fulfill({ json: saved }));
  await page.goto('/admin/models');
  await expect(
    page.getByRole('combobox', { name: labels.en.choose }).locator('option'),
  ).toHaveCount(24);
  await expect(page.getByRole('button', { name: labels.en.add, exact: true })).toBeDisabled();
});

test('ordinary players never mount director catalog administration', async ({ page }) => {
  await adminFixture(page, 'en', 'user');
  let requests = 0;
  await page.route('**/api/v1/admin/directors', (route) => {
    requests++;
    return route.fulfill({ json: initialCatalog() });
  });
  await page.goto('/admin/models');
  await expect(
    page.getByRole('heading', { name: 'This section is for the team', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: labels.en.title, exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});

test('pending director saves disable repeated edits and clearing behavior restores legacy delivery', async ({
  page,
}) => {
  await adminFixture(page, 'en');
  let saved = initialCatalog();
  saved.profiles[0].behaviorInstructions = 'Keep this existing instruction until saved.';
  let saves = 0;
  let release: (() => void) | undefined;
  await page.route('**/api/v1/admin/directors', async (route) => {
    if (route.request().method() === 'PATCH') {
      saves++;
      const body = route.request().postDataJSON();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      saved = {
        revision: saved.revision + 1,
        defaultProfileId: body.defaultProfileId,
        profiles: body.profiles,
      };
    }
    return route.fulfill({ json: saved });
  });
  await page.goto('/admin/models');
  const behavior = page
    .getByTestId('director-catalog')
    .getByRole('textbox', { name: labels.en.behavior, exact: false });
  await expect(behavior).toHaveCount(1);
  await expect(behavior).toHaveValue(saved.profiles[0].behaviorInstructions!);
  await behavior.fill('');
  const save = page.getByRole('button', { name: labels.en.save, exact: true });
  await save.click();
  await expect.poll(() => saves).toBe(1);
  await expect(behavior).toBeDisabled();
  await expect(page.getByRole('combobox', { name: labels.en.choose, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: labels.en.add, exact: true })).toBeDisabled();
  await expect(save).toBeDisabled();
  release!();
  await expect(behavior).toBeEnabled();
  expect(saved.profiles[0]).toMatchObject({
    behaviorInstructions: '',
    ...DIRECTOR_STYLE_PRESETS.coauthor,
  });
  await page.reload();
  await expect(behavior).toHaveValue('');
  await expect(save).toBeDisabled();
  expect(saves).toBe(1);
});
