import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** A story made of a description and a first message offers its opening picture in the Studio. */
test('Studio offers the opening location picture for a description-only story', async ({
  page,
}) => {
  const handle = `opening_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'Opening art',
      password: `Safe-${randomUUID()}!`,
    },
  });
  expect(registered.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  const created = await page.request.post('/api/v1/studio/adventures', {
    data: {
      title: 'Туманный порт',
      synopsis: 'История из описания и первого сообщения.',
      content: {
        world: 'Старый порт, где туман не рассеивается.',
        firstMessage: 'Вы стоите на мокром причале.',
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const story = await created.json();
  await page.goto(`/studio/adventures/${story.id}`);
  await page.getByRole('button', { name: /Мир и история$/ }).click();
  const card = page.getByTestId('opening-art');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Картинка стартовой локации' })).toBeVisible();
});
