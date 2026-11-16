import { legacyRealtimeLaunch } from './support/map-actions';
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
  await legacyRealtimeLaunch(page);

  await page.goto('/adventures/old-observatory');
  await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
  await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();

  const story = page.getByTestId('unified-story');
  const composer = story.getByLabel('Твой ход', { exact: true });
  const feed = story.getByTestId('story-feed');
  const messages = [
    'Здравствуйте! Я пришёл осмотреть обсерваторию.',
    '*оглядываюсь по сторонам*',
    'Что вы можете рассказать о звёздах?',
    'Я хотел бы подняться наверх.',
    'Спасибо за помощь, я ещё вернусь.',
  ];
  const turnIds: string[] = [];
  for (const [index, text] of messages.entries()) {
    const submitted = page.waitForRequest(
      (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/turns'),
    );
    await composer.fill(text);
    await story.getByRole('button', { name: 'Отправить', exact: true }).click();
    await story.getByRole('button', { name: 'Подтвердить ход', exact: true }).click();
    turnIds.push(JSON.parse((await submitted).postData() || '{}').turnId);
    await expect(composer).toHaveValue('', { timeout: 45000 });
    const entries = await feed.locator('[data-story-entry]').count();
    expect(entries, `turn ${index + 1} must add story entries`).toBeGreaterThan(index);
  }
  expect(new Set(turnIds).size).toBe(messages.length);
  for (const id of turnIds)
    await expect(feed.locator(`[data-story-turn="${id}"]`).first()).toBeAttached();

  // The failure banners a first player must never see on the happy path.
  await expect(page.getByRole('alert')).toHaveCount(0);
  const before = await feed.locator('[data-story-entry]').count();
  await page.reload();
  await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(feed.locator('[data-story-entry]')).toHaveCount(before);
});
