import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test('Studio mock image flow requires separate quote consent and never auto-binds or regenerates', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `image-${suffix}@example.test`,
      handle: `image_${suffix}`,
      name: 'Image QA',
      password: `Image-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/studio/adventures/new');
  await page.getByLabel('Название приключения').fill(`Image QA ${suffix}`);
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/adventures\/[0-9a-f-]+$/);
  const storyId = page.url().split('/').at(-1)!;
  await page.getByRole('button', { name: /Локации$/ }).click();
  const editor = page.getByRole('region', { name: 'Игровая карта', exact: true });
  await editor.getByRole('button', { name: 'Шаблон: внутренний двор', exact: true }).click();
  const art = page.getByRole('region', { name: 'Графика приключения', exact: true });
  const slots = art.getByLabel('Место в сцене', { exact: true });
  await expect(slots).toBeVisible();
  const slot = await slots
    .locator('option')
    .evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .find((value) => value.startsWith('map:')),
    );
  await slots.selectOption(slot!);
  await art.getByRole('button', { name: 'Подготовка изображения', exact: true }).click();
  const generation = page.getByRole('region', { name: 'Подготовка изображения', exact: true });
  await expect(generation).toContainText('готовый образец, не новая AI-иллюстрация');
  await expect(generation).toContainText('Внешняя генерация недоступна');
  await generation.getByLabel('Название материала', { exact: true }).fill(`Mock artwork ${suffix}`);
  await generation
    .getByLabel('Описание рисунка', { exact: true })
    .fill('A drawn 2D courtyard. This is an offline fixture test.');
  await generation
    .getByLabel('Название лицензии или условий', { exact: true })
    .fill('Original project fixture');
  await generation
    .getByLabel('Подтверждаю права на запрос и выбранные собственные референсы.', { exact: true })
    .check();
  let jobPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/image-generation/jobs')) jobPosts++;
  });
  const quoted = page.waitForResponse(
    (r) => r.url().endsWith('/image-generation/quotes') && r.request().method() === 'POST',
  );
  await generation
    .getByRole('button', { name: 'Проверить библиотеку и подготовить цену', exact: true })
    .click();
  expect((await quoted).ok()).toBeTruthy();
  await expect(
    generation.getByRole('button', { name: 'Запустить один тест', exact: true }),
  ).toBeDisabled();
  expect(jobPosts).toBe(0);
  await generation
    .getByLabel(
      'Подтверждаю один тестовый запуск по этой цене. Повторная генерация не выполняется автоматически.',
      { exact: true },
    )
    .check();
  await generation
    .getByLabel('Описание рисунка', { exact: true })
    .fill('Updated description invalidates prior consent.');
  await expect(
    generation.getByRole('button', { name: 'Запустить один тест', exact: true }),
  ).toHaveCount(0);
  await generation
    .getByRole('button', { name: 'Проверить библиотеку и подготовить цену', exact: true })
    .click();
  await generation
    .getByLabel(
      'Подтверждаю один тестовый запуск по этой цене. Повторная генерация не выполняется автоматически.',
      { exact: true },
    )
    .check();
  await generation.getByRole('button', { name: 'Запустить один тест', exact: true }).click();
  const admitted = generation.locator('[data-image-job-status="admitted"]');
  await expect(admitted).toBeVisible({ timeout: 20000 });
  expect(jobPosts).toBe(1);
  const beforeBinding = await page.request.get(`/api/v1/asset-library/stories/${storyId}/draft`);
  expect((await beforeBinding.json()).bindings).toHaveLength(0);
  await generation
    .getByRole('button', { name: 'Проверить библиотеку и подготовить цену', exact: true })
    .click();
  await expect(generation).toContainText('Найдены совместимые материалы');
  expect(jobPosts).toBe(1);
  await expect(
    generation.getByRole('button', {
      name: 'Не использовать найденные варианты; подготовить отдельный тест',
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Локации$/ }).click();
  await slots.selectOption(slot!);
  await art.getByRole('button', { name: 'Подготовка изображения', exact: true }).click();
  await expect(generation.locator('[data-image-job-status="admitted"]')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
