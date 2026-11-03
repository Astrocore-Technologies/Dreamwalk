import { test, expect } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';
import {
  DEFAULT_DIRECTOR_STYLE,
  type DirectorStyleSettings,
} from '../../packages/contracts/src/director-style';

// UI fixture only; real role checks, CAS, persistence and quoted turns are covered by integration-director-style.
for (const locale of ['en', 'ru', 'uk'] as const) {
  test(`director preset and advanced settings persist with conflict recovery (${locale})`, async ({
    page,
  }, testInfo) => {
    const user = {
      id: 'qa-admin',
      name: 'QA',
      handle: 'qa_admin',
      role: 'admin',
      settings: settingsSchema.parse({ language: locale }),
      onboarded: true,
    };
    let saved: DirectorStyleSettings = { ...DEFAULT_DIRECTOR_STYLE };
    let saves = 0,
      conflict = false;
    const labels = {
      en: {
        title: 'AI director',
        type: 'Director type',
        customize: 'Customize delivery',
        pacing: 'Story pacing',
        save: 'Save style',
        reload: 'Reload settings',
        stale: 'Another administrator updated the director style.',
      },
      ru: {
        title: 'ИИ-ведущий',
        type: 'Тип ведущего',
        customize: 'Настроить подачу',
        pacing: 'Темп истории',
        save: 'Сохранить стиль',
        reload: 'Обновить настройки',
        stale: 'Другой администратор изменил стиль ведущего.',
      },
      uk: {
        title: 'ШІ-ведучий',
        type: 'Тип ведучого',
        customize: 'Налаштувати подачу',
        pacing: 'Темп історії',
        save: 'Зберегти стиль',
        reload: 'Оновити налаштування',
        stale: 'Інший адміністратор змінив стиль ведучого.',
      },
    }[locale];
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
    );
    await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user } }));
    await page.route('**/api/v1/admin/models', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/admin/runtimes', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/admin/director-style', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        expect(Object.keys(body).sort()).toEqual([
          'expectedRevision',
          'initiative',
          'pacing',
          'style',
        ]);
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { code: 'DIRECTOR_STYLE_STALE', message: 'DIRECTOR_STYLE_STALE' },
          });
        expect(body.expectedRevision).toBe(saved.revision);
        saved = {
          style: body.style,
          pacing: body.pacing,
          initiative: body.initiative,
          revision: saved.revision + 1,
        };
        saves++;
      }
      return route.fulfill({ json: saved });
    });
    await page.goto('/admin/models');
    await expect(page.getByRole('heading', { name: labels.title, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: labels.type, exact: true })).toHaveValue(
      'coauthor',
    );
    await expect(
      page.getByRole('combobox', { name: labels.pacing, exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
    await page.getByRole('combobox', { name: labels.type, exact: true }).selectOption('director');
    await page.getByRole('button', { name: labels.save, exact: true }).click();
    await expect.poll(() => saves).toBe(1);
    expect(saved).toEqual({
      revision: 2,
      style: 'cinematic',
      pacing: 'brisk',
      initiative: 'proactive',
    });
    await page.reload();
    await expect(page.getByRole('combobox', { name: labels.type, exact: true })).toHaveValue(
      'director',
    );
    await page.getByText(labels.customize, { exact: true }).click();
    await page
      .getByRole('combobox', { name: labels.pacing, exact: true })
      .selectOption('deliberate');
    await expect(page.getByRole('combobox', { name: labels.type, exact: true })).toHaveValue(
      'custom',
    );
    conflict = true;
    saved = { ...DEFAULT_DIRECTOR_STYLE, revision: 3 };
    await page.getByRole('button', { name: labels.save, exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: labels.stale })).toBeVisible();
    await page.getByRole('button', { name: labels.reload, exact: true }).click();
    await expect(page.getByRole('combobox', { name: labels.type, exact: true })).toHaveValue(
      'coauthor',
    );
    await expect(page.getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
    if (locale === 'en') {
      await page.screenshot({
        path: testInfo.outputPath('director-settings-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByText(labels.customize, { exact: true }).click();
      await page.screenshot({
        path: testInfo.outputPath('director-settings-mobile.png'),
        fullPage: true,
      });
    }
  });
}
test('ordinary players never mount the director admin controls', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } }),
  );
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'qa-player',
          name: 'QA',
          handle: 'qa_player',
          role: 'user',
          settings: settingsSchema.parse({ language: 'en' }),
          onboarded: true,
        },
      },
    }),
  );
  await page.route('**/api/v1/admin/director-style', (route) => {
    requests++;
    return route.fulfill({ json: DEFAULT_DIRECTOR_STYLE });
  });
  await page.goto('/admin/models');
  await expect(page.getByRole('heading', { name: 'AI director', exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});
