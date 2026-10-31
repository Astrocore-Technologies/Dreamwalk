import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
async function account(page: Page) {
  const handle = `director_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const result = await page.request.post('/api/v1/auth/register', {
    data: {
      email: `${handle}@example.test`,
      handle,
      name: 'Story QA',
      password: `Story-${randomUUID()}!`,
    },
  });
  expect(result.status()).toBe(201);
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  return handle;
}
async function snapshot(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).projection as {
    actorId: string;
    map: { id: string; exits: { id: string; x: number; y: number; destinationMapId: string }[] };
    entities: { id: string; x: number; y: number }[];
  };
}
async function travel(page: Page, id: string, destination: string) {
  const before = await snapshot(page, id);
  const exit = before.map.exits.find((value) => value.destinationMapId === destination)!;
  expect(exit).toBeTruthy();
  const card = page.locator(`[data-exit-id="${exit.id}"]`);
  await card.getByRole('button', { name: 'Подойти', exact: true }).click();
  await expect
    .poll(
      async () => {
        const p = await snapshot(page, id),
          actor = p.entities.find((value) => value.id === p.actorId)!;
        return [actor.x, actor.y];
      },
      { timeout: 30000 },
    )
    .toEqual([exit.x, exit.y]);
  await card.getByRole('button', { name: 'Перейти', exact: true }).click();
  await expect(page.getByTestId('game-position')).toHaveAttribute('data-map-id', destination);
}
async function prepare(page: Page, text: string) {
  const director = page.getByTestId('narrative-director');
  await director.getByLabel('Твой ход в истории', { exact: true }).fill(text);
  await director.getByRole('button', { name: 'Подготовить ход', exact: true }).click();
  await expect(director.getByTestId('narrative-quote')).toBeVisible();
  return director;
}
async function confirm(page: Page, revision: number) {
  await page
    .getByTestId('narrative-director')
    .getByRole('button', { name: 'Подтвердить ход и стоимость', exact: true })
    .click();
  await expect(
    page.locator(`[data-narrative-turn][data-canon-revision="${revision}"]`),
  ).toHaveCount(1, { timeout: 30000 });
}
test('two players coauthor committed evolving scenes, travel and retain shared canon on reload', async ({
  browser,
}) => {
  test.setTimeout(300000);
  const contexts = await Promise.all([
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
    browser.newContext({ baseURL: test.info().project.use.baseURL }),
  ]);
  const [owner, guest] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [owner, guest]) {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
  }
  try {
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await account(owner);
    const guestHandle = await account(guest);
    await owner.goto('/adventures/old-observatory');
    await owner.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const id = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(owner.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/game');
    await guest
      .getByRole('button', { name: 'Принять приглашение в кампанию', exact: true })
      .click();
    await expect(guest).toHaveURL(new RegExp(`/game/${id}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(owner.getByTestId('game-advanced')).not.toHaveAttribute('open', '');
    const originalMap = (await snapshot(owner, id)).map.id;
    await prepare(owner, 'Я ищу новый путь расследования за стенами обсерватории.');
    await expect(
      guest.getByTestId('narrative-journal').locator('[data-narrative-turn]'),
    ).toHaveCount(0);
    await confirm(owner, 1);
    await expect(guest.locator('[data-narrative-turn][data-canon-revision="1"]')).toHaveCount(1);
    const journal = await owner.request.get(`/api/v1/game/campaigns/${id}/narrative`);
    const first = (await journal.json()).turns.find(
      (turn: { status: string }) => turn.status === 'committed',
    ) as { sceneId: string; npcId: string };
    expect(first.sceneId).toBeTruthy();
    expect((await snapshot(owner, id)).map.id).toBe(originalMap); // No client-side teleport.
    await travel(owner, id, first.sceneId);
    await expect(owner.locator(`[data-entity-id="${first.npcId}"]`)).toHaveCount(1);
    await expect(guest.locator(`[data-entity-id="${first.npcId}"]`)).toHaveCount(0);
    // Real original raster upload, library reuse and explicit campaign binding. No screenshot mock.
    const uploaded = await owner.request.post('/api/v1/assets', {
      multipart: {
        file: {
          name: 'observatory.webp',
          mimeType: 'image/webp',
          buffer: await readFile('apps/web/public/images/observatory.webp'),
        },
      },
    });
    expect(uploaded.ok()).toBeTruthy();
    const registered = await owner.request.post('/api/v1/asset-library/revisions', {
      data: {
        operationId: randomUUID(),
        uploadId: (await uploaded.json()).id,
        metadata: {
          title: 'Original scene QA',
          kind: 'background',
          style: 'drawn2D',
          camera: 'top-down',
          tags: [],
          variant: 'default',
          provenance: { source: 'upload' },
          rights: {
            basis: 'generated',
            licenseLabel: 'Original Dreamwalk fixture — assets/demo/README.md',
            attribution: 'Dreamwalk original fixture',
            allowAuthorReuse: false,
            attested: true,
          },
        },
      },
    });
    expect(registered.ok()).toBeTruthy();
    const revision = (await registered.json()).id as string;
    const media = owner.getByTestId('scene-media');
    await media.locator(':scope > summary').click();
    await media.getByRole('button', { name: 'Подобрать готовое оформление', exact: true }).click();
    await media
      .locator(`[data-media-revision="${revision}"]`)
      .getByRole('button', { name: 'Применить к этой кампании', exact: true })
      .click();
    await expect(owner.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1', {
      timeout: 15000,
    });
    // Grounded mock portrait uses a separate attested quote + consent, then a separate attachment.
    await media.getByLabel('Тип оформления', { exact: true }).selectOption('portrait');
    await media.getByRole('button', { name: 'Подобрать готовое оформление', exact: true }).click();
    const generation = media.getByTestId('grounded-image');
    await generation.locator(':scope > summary').click();
    await generation
      .getByLabel('Название лицензии или условий', { exact: true })
      .fill('Mock sample for test only');
    await generation
      .getByLabel('Подтверждаю права на запрос и выбранные собственные референсы.', { exact: true })
      .check();
    await generation
      .getByRole('button', { name: 'Проверить библиотеку и подготовить цену', exact: true })
      .click();
    await expect(generation.getByTestId('grounded-image-quote')).toBeVisible();
    await generation
      .getByLabel(
        'Подтверждаю один тестовый запуск по этой цене. Повторная генерация не выполняется автоматически.',
        { exact: true },
      )
      .check();
    await generation.getByRole('button', { name: 'Запустить один тест', exact: true }).click();
    await expect(
      generation.getByText('Сохранено как неизменяемая ревизия', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const portrait = media.locator('[data-media-revision]');
    await expect(portrait).toHaveCount(1);
    const portraitId = await portrait.getAttribute('data-media-revision');
    await portrait.getByRole('button', { name: 'Применить к этой кампании', exact: true }).click();
    await expect(owner.locator(`img[src*="${portraitId}"][src*="campaignId"]`)).toBeVisible({
      timeout: 15000,
    });
    await owner.locator('main').scrollIntoViewIfNeeded();
    await owner.evaluate(() => scrollTo(0, 0));
    await owner.screenshot({ path: test.info().outputPath('director-generated-scene.png') });
    const waitingText = 'Я предлагаю проверить следы в нашей исходной комнате.';
    await prepare(guest, waitingText);
    await prepare(owner, 'В новом помещении я продолжаю расследование и ищу следующий проход.');
    await confirm(owner, 2);
    await expect(guest.locator('[data-narrative-turn][data-canon-revision="2"]')).toHaveCount(1);
    await expect(guest.getByTestId('narrative-quote')).toHaveCount(0); // Shared canon invalidates old quote.
    await expect(guest.getByLabel('Твой ход в истории', { exact: true })).toHaveValue(waitingText);
    const nextJournal = await owner.request.get(`/api/v1/game/campaigns/${id}/narrative`);
    const second = (await nextJournal.json()).turns.find(
      (turn: { canonRevision?: number }) => turn.canonRevision === 2,
    ) as { sceneId: string };
    expect(second.sceneId).not.toBe(first.sceneId);
    expect(
      (await snapshot(owner, id)).map.exits.some(
        (exit) => exit.destinationMapId === second.sceneId,
      ),
    ).toBe(true);
    await travel(owner, id, originalMap);
    await travel(owner, id, first.sceneId);
    await expect(owner.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1', {
      timeout: 15000,
    });
    await prepare(guest, waitingText);
    await confirm(guest, 3);
    await expect(owner.locator('[data-narrative-turn][data-canon-revision="3"]')).toHaveCount(1);
    await Promise.all([owner.reload(), guest.reload()]);
    for (const page of [owner, guest])
      await expect(
        page.getByTestId('narrative-journal').locator('[data-narrative-turn]'),
      ).toHaveCount(3);
    await expect(owner.getByTestId('game-position')).toHaveAttribute('data-map-id', first.sceneId);
    await expect(owner.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1', {
      timeout: 15000,
    });
    await owner.getByTestId('narrative-director').scrollIntoViewIfNeeded();
    await owner.screenshot({ path: test.info().outputPath('director-shared-history.png') });
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.locator('header').getByRole('combobox').selectOption('uk');
    await expect(
      guest.getByRole('heading', { name: 'Продовжити історію', exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
