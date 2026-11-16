import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** First-player journey on the unpaid fixture provider: register, open a story, start it,
 * play five consecutive turns and find the whole conversation intact after a reload.
 * No paid provider is involved, so this documents the product contract for CI. */
test('a new player registers, starts the fixture story and plays five turns', async ({ page }) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const handle = `golden_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'Golden path',
      password: `Safe-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));

  await page.goto('/adventures/old-observatory');
  await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
  await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();

  const story = page.getByTestId('unified-story');
  const composer = story.getByLabel('Твой ход', { exact: true });
  const feed = story.getByTestId('story-feed');
  const campaignId = new URL(page.url()).pathname.split('/').at(-1)!;
  const revision = async () =>
    (await (await page.request.get(`/api/v1/game/campaigns/${campaignId}/snapshot`)).json())
      .projection.revision as number;
  const messages = [
    'Здравствуйте! Я пришёл осмотреть обсерваторию.',
    '*оглядываюсь по сторонам*',
    'Что вы можете рассказать о звёздах?',
    'Я хотел бы подняться наверх.',
    'Спасибо за помощь, я ещё вернусь.',
  ];
  for (const [index, text] of messages.entries()) {
    await expect(composer).toBeEnabled({ timeout: 60000 });
    const before = await revision();
    await composer.fill(text);
    await story.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expect(feed).toContainText(text.replaceAll('*', '').slice(0, 20));
    await page.getByRole('button', { name: 'Завершить ход', exact: true }).click();
    // The round is closed once the world has answered and the composer is free again.
    await expect(composer).toBeEnabled({ timeout: 60000 });
    await expect(composer).toHaveValue('');
    await expect
      .poll(async () => (await revision()) > before, { message: `turn ${index + 1} must advance` })
      .toBe(true);
  }
  // Within five turns the keeper has to have answered in the story, not only moved.
  await expect(feed.locator('[data-story-kind="npc_reply"]').first()).toBeAttached({
    timeout: 30000,
  });
  // The failure banners a first player must never see on the happy path.
  await expect(page.locator('[role="alert"]:not(:empty)')).toHaveCount(0);
  const before = await feed.locator('[data-story-entry]').count();
  await page.reload();
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(feed.locator('[data-story-entry]')).toHaveCount(before);
});
