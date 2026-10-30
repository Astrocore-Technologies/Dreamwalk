import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function register(page: Page) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const credentials = {
    email: `browser-${suffix}@example.test`,
    handle: `browser_${suffix}`,
    password: `Browser-${randomUUID()}!`,
  };
  await page.goto('/auth/sign-up');
  await page.getByLabel('Как тебя называть?').fill('Исследователь QA');
  await page.getByLabel('Адрес профиля').fill(credentials.handle);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Пароль').fill(credentials.password);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Имя', { exact: true }).fill('Исследователь QA');
  await page.getByRole('button', { name: 'Открыть Dreamwalk' }).click();
  await expect(page).toHaveURL(/\/home$/);
  return credentials;
}

test('player: register, save account settings, reload, and cancel deletion', async ({ page }) => {
  await register(page);
  await page.goto('/account/profile');
  await page.getByLabel('Имя', { exact: true }).fill('Новое имя путешественника');
  await page.getByLabel('О себе').fill('Люблю тайны и тихие приключения.');
  await page.getByRole('button', { name: 'Сохранить профиль' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Профиль сохранён' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Новое имя путешественника');
  await page.goto('/account/settings');
  await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption('light');
  await page.getByLabel('Часовой пояс').fill('Europe/Paris');
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Настройки сохранены' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Тема', exact: true })).toHaveValue('light');
  await expect(page.getByLabel('Часовой пояс')).toHaveValue('Europe/Paris');
  await page.goto('/account/privacy');
  await page.getByRole('button', { name: /Удалить аккаунт/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeVisible();
  await page.goto('/wallet');
  await expect(page.getByText(/демо/i).first()).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByText('Этот раздел только для команды')).toBeVisible();
});

test('author: NPC and complete adventure draft survive reload and submit confirmation', async ({
  page,
}) => {
  await register(page);
  const suffix = randomUUID().slice(0, 8);
  await page.goto('/studio/npcs/new');
  await page.getByLabel('Имя NPC', { exact: true }).fill(`Смотритель ${suffix}`);
  await page.getByLabel('Роль в мире').fill('Хранитель звёздной карты');
  await page.getByLabel('Характер', { exact: true }).fill('Спокойный и любопытный');
  await page.getByLabel('Секреты и скрытые знания').fill('Спрятал карту в архиве');
  await page.getByRole('button', { name: 'Сохранить NPC' }).click();
  await expect(page).toHaveURL(/\/studio\/npcs\/[a-f0-9-]+$/);
  await page.reload();
  await expect(page.getByLabel('Имя NPC', { exact: true })).toHaveValue(`Смотритель ${suffix}`);
  await page.goto('/studio/adventures/new');
  await page.getByLabel('Название приключения').fill(`Звёздная карта ${suffix}`);
  await page
    .getByLabel('Синопсис')
    .fill(
      'Письмо смотрителя приглашает исследовать забытую обсерваторию и найти потерянную карту.',
    );
  await page.getByRole('button', { name: /Мир и правила$/ }).click();
  await page
    .getByLabel('Мир и атмосфера')
    .fill('Город на побережье, где звёзды отражаются в старых каналах.');
  await page.getByLabel('Правила мира').fill('Любопытство и внимание важнее силы.');
  await page.getByRole('button', { name: /Локации$/ }).click();
  await page.getByRole('button', { name: /Добавить локацию/ }).click();
  await page.getByLabel('Название локации').first().fill('Двор обсерватории');
  await page.getByLabel('Описание локации').first().fill('Каменные ступени ведут к башне.');
  await page.getByRole('button', { name: /Стартовая сцена$/ }).click();
  await page.getByRole('button', { name: /Добавить сцену/ }).click();
  await page.getByLabel('Название сцены').first().fill('Прибытие');
  await page.getByLabel('Локация сцены').first().selectOption({ label: 'Двор обсерватории' });
  await page.getByLabel('Начальная ситуация').first().fill('У ворот ждёт смотритель с письмом.');
  await page
    .getByRole('combobox', { name: 'Стартовая сцена', exact: true })
    .selectOption({ label: 'Прибытие' });
  await page.getByRole('button', { name: /Просмотр$/ }).click();
  // Narrative-only, not-yet-created drafts cannot launch a playable campaign.
  await expect(
    page.getByText('Сначала сохрани историю, затем добавь игровую карту.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Сохранить и проверить в игре', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /Публикация$/ }).click();
  await page
    .getByRole('combobox', { name: 'Режим публикации', exact: true })
    .selectOption('public');
  await page.getByRole('button', { name: 'Отправить на модерацию' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Отправить на модерацию' }).click();
  await page.getByRole('button', { name: 'Сохранить и отправить' }).click();
  await expect(page).toHaveURL(/\/studio\/adventures\/[a-f0-9-]+$/);
  await page.reload();
  await page.getByRole('button', { name: /Публикация$/ }).click();
  await expect(page.getByRole('button', { name: 'Ожидает проверки' })).toBeDisabled();
});

test('public navigation works on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    '/',
    '/explore',
    '/about',
    '/terms',
    '/privacy',
    '/content-policy',
    '/support',
  ]) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow, `${route} must not overflow at 390px`).toBe(false);
    await expect(page.getByText(/Application error|Internal Server Error/)).toHaveCount(0);
  }
  await page.screenshot({ path: 'test-results/mobile-support.png', fullPage: true });
});

test('interface locale switches and survives account login', async ({ page }) => {
  const credentials = await register(page);
  await page.goto('/account/settings');
  // The shell exists before auth has resolved. Wait for the protected settings form
  // so switching language exercises account persistence, not guest-only storage.
  await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/account/settings') &&
        response.request().method() === 'PATCH' &&
        response.ok(),
    ),
    page.locator('header').getByRole('combobox').selectOption('en'),
  ]);
  await expect(page.getByRole('heading', { name: 'Make yourself at home' })).toBeVisible();
  await page.reload();
  await expect(page.locator('header').getByRole('combobox')).toHaveValue('en');
  await expect(page.getByRole('button', { name: 'Save preferences' })).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/account/settings') &&
        response.request().method() === 'PATCH' &&
        response.ok(),
    ),
    page.locator('header').getByRole('combobox').selectOption('uk'),
  ]);
  await expect(page.getByRole('heading', { name: 'Налаштувати під себе' })).toBeVisible();
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Пароль').fill(credentials.password);
  await page.getByRole('button', { name: 'Увійти', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('header').getByRole('combobox')).toHaveValue('uk');
  await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
});

test('private adventure invitation accepts and revokes without publishing', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  try {
    await register(ownerPage);
    const guest = await register(guestPage);
    const title = `Частная история ${randomUUID().slice(0, 8)}`;
    await ownerPage.goto('/studio/adventures/new');
    await ownerPage.getByLabel('Название приключения').fill(title);
    await ownerPage
      .getByLabel('Синопсис')
      .fill('Этот мир доступен только лично приглашённым участникам.');
    await ownerPage.getByRole('button', { name: /Публикация$/ }).click();
    await expect(
      ownerPage.getByRole('combobox', { name: 'Режим публикации', exact: true }),
    ).toHaveValue('private');
    await ownerPage.getByRole('button', { name: 'Сохранить приватное приключение' }).click();
    await expect(ownerPage).toHaveURL(/\/studio\/adventures\/[a-f0-9-]+$/);
    await ownerPage.getByRole('button', { name: /Публикация$/ }).click();
    await ownerPage.getByLabel('Пригласить по handle').fill(guest.handle);
    await ownerPage.getByRole('button', { name: 'Пригласить', exact: true }).click();
    await expect(
      ownerPage.getByRole('status').filter({ hasText: 'Приглашение отправлено' }),
    ).toBeVisible();
    await guestPage.goto('/library');
    await guestPage.getByRole('button', { name: /^Приглашения/ }).click();
    await expect(guestPage.getByText(title, { exact: true })).toBeVisible();
    await guestPage.getByRole('button', { name: 'Принять приглашение' }).click();
    await guestPage.reload();
    await guestPage.getByRole('button', { name: /^Приглашённые миры/ }).click();
    await expect(guestPage.getByText(title, { exact: true })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Отозвать', exact: true }).click();
    await ownerPage
      .getByRole('dialog')
      .getByRole('button', { name: 'Отозвать', exact: true })
      .click();
    await expect(
      ownerPage.getByRole('status').filter({ hasText: 'Приглашение отозвано' }),
    ).toBeVisible();
    await guestPage.reload();
    await guestPage.getByRole('button', { name: /^Приглашённые миры/ }).click();
    await expect(guestPage.getByText(title, { exact: true })).toHaveCount(0);
    await guestPage.goto('/explore');
    await expect(guestPage.getByText(title, { exact: true })).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
