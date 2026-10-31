import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
async function register(page: Page) {
  const handle = `hero_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const result = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'Hero QA',
      password: `Hero-${randomUUID()}!`,
    },
  });
  expect(result.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  return handle;
}
test('owned heroes launch and independently join, with pinned private snapshots after edits', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const a = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const b = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const owner = await a.newPage(),
    guest = await b.newPage();
  try {
    await register(owner);
    const guestHandle = await register(guest);
    await owner.goto('/my-characters');
    await owner.getByRole('button', { name: 'Создать героя', exact: true }).click();
    await owner.getByLabel('Имя героя', { exact: true }).fill('Лира');
    await owner.getByLabel('Предыстория', { exact: true }).fill('История Лиры');
    await owner.getByLabel('Личные заметки', { exact: true }).fill('Личный секрет Лиры');
    await owner.getByRole('button', { name: 'Сохранить героя', exact: true }).click();
    await owner.getByRole('link', { name: 'Играть этим героем', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\?heroId=/);
    const originalId = new URL(owner.url()).searchParams.get('heroId')!;
    await expect(owner.getByLabel('Герой для этого прохождения')).toHaveValue(originalId);
    await owner.getByRole('button', { name: 'Новая кампания', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const campaignId = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(
      owner.getByTestId('campaign-hero').getByRole('heading', { name: 'Лира', exact: true }),
    ).toBeVisible();
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(owner.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    const heroResponse = await guest.request.post('/api/v1/heroes', {
      data: {
        name: 'Орест',
        backstory: 'История Ореста',
        notes: 'Личный секрет Ореста',
        traits: ['Добрый'],
      },
    });
    expect(heroResponse.ok()).toBeTruthy();
    const guestHero = await heroResponse.json();
    await guest.goto('/game');
    await guest.getByLabel('Герой для этого прохождения').selectOption(guestHero.id);
    await guest
      .getByRole('button', { name: 'Принять приглашение в кампанию', exact: true })
      .click();
    await expect(guest).toHaveURL(new RegExp(`/game/${campaignId}$`));
    await expect(
      guest.getByTestId('campaign-hero').getByRole('heading', { name: 'Орест', exact: true }),
    ).toBeVisible();
    await expect(guest.getByText('Личный секрет Лиры', { exact: true })).toHaveCount(0);
    await expect(owner.getByText('Личный секрет Ореста', { exact: true })).toHaveCount(0);
    expect(
      (
        await owner.request.patch(`/api/v1/heroes/${originalId}`, {
          data: {
            name: 'Изменённая Лира',
            backstory: 'Новая история',
            notes: '',
            traits: [],
            portraitAssetId: null,
          },
        })
      ).ok(),
    ).toBeTruthy();
    await Promise.all([owner.reload(), guest.reload()]);
    await expect(
      owner.getByTestId('campaign-hero').getByRole('heading', { name: 'Лира', exact: true }),
    ).toBeVisible();
    await owner.getByTestId('campaign-hero').locator('summary').click();
    await expect(
      owner.getByTestId('campaign-hero').getByText('Личный секрет Лиры', { exact: true }),
    ).toBeVisible();
    await expect(guest.getByText('Личный секрет Лиры', { exact: true })).toHaveCount(0);
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(
      await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await guest.locator('header').getByRole('combobox').selectOption('uk');
    await expect(
      guest
        .getByTestId('campaign-hero')
        .getByText('Твій герой в цьому збереженні', { exact: true }),
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
