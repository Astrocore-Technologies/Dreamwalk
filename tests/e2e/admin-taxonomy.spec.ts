import { test, expect } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';

// Synthetic transport fixtures; server authorization/concurrency is covered by platform-taxonomy.
test('taxonomy picker edits one translated entry, preserves identity and recovers discarded additions', async ({
  page,
}) => {
  const user = {
    id: 'qa-admin',
    name: 'Legacy name',
    handle: 'qa_admin',
    role: 'admin',
    settings: settingsSchema.parse({}),
    onboarded: true,
  };
  let taxonomy = {
    genres: ['Фэнтези'],
    tags: [{ id: 'cozy', labels: { ru: 'Уют', en: 'Cozy', uk: 'Затишок' }, aliases: [] }],
    genreDefinitions: [
      { id: 'fantasy', value: 'Фэнтези', labels: { ru: 'Фэнтези', en: 'Fantasy', uk: 'Фентезі' } },
    ],
    revision: 0,
  };
  let saves = 0;
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user } }));
  await page.route('**/api/v1/taxonomy', (route) => route.fulfill({ json: taxonomy }));
  await page.route('**/api/v1/admin/taxonomy', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(taxonomy.revision);
      taxonomy = {
        genres: body.genres,
        tags: body.tags,
        genreDefinitions: body.genreDefinitions,
        revision: taxonomy.revision + 1,
      };
      saves++;
    }
    await route.fulfill({ json: taxonomy });
  });
  await page.goto('/admin/taxonomy');
  await expect(page.getByLabel('ID жанра')).toHaveCount(0);
  await page.getByRole('button', { name: 'Выбрать жанр', exact: true }).click();
  await page.getByLabel('Поиск', { exact: true }).fill('no-such-genre');
  await expect(page.getByRole('status').filter({ hasText: 'Ничего не найдено' })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Выбрать жанр', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Фэнтези', exact: true }).click();
  await expect(page.getByLabel('ID жанра')).toHaveValue('fantasy');
  await expect(page.getByLabel('ID жанра')).not.toBeEditable();
  await page.getByLabel('Английский', { exact: true }).fill('Dream fantasy');
  await page.getByRole('button', { name: 'Сохранить справочник', exact: true }).click();
  await expect.poll(() => saves).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Выбрать жанр', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Фэнтези', exact: true }).click();
  await expect(page.getByLabel('Английский', { exact: true })).toHaveValue('Dream fantasy');
  await page.getByRole('button', { name: 'Добавить тег', exact: true }).click();
  await page.getByLabel('ID тега').fill('cozy');
  await expect(page.getByLabel('ID тега')).toBeEditable();
  await page.getByRole('button', { name: 'Убрать новую запись', exact: true }).click();
  await expect(page.getByLabel('ID тега')).toHaveCount(0);
  await page.getByRole('button', { name: 'Добавить жанр', exact: true }).click();
  await expect(page.getByLabel('ID жанра')).toHaveValue('');
  await page.getByRole('button', { name: 'Убрать новую запись', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(page.getByLabel('ID жанра')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(taxonomy.genres).toEqual(['Фэнтези']);
  expect(taxonomy.genreDefinitions[0].value).toBe('Фэнтези');
});
