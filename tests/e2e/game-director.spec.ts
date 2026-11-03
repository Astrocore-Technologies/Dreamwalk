import { campaignDetails } from './support/campaign-details';
import {
  approachTarget,
  mapAction,
  legacyRealtimeLaunch,
  readProjection,
} from './support/map-actions';
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
    entities: { id: string; kind: string; x: number; y: number }[];
  };
}
async function travel(page: Page, id: string, destination: string) {
  const before = await snapshot(page, id);
  const exit = before.map.exits.find((value) => value.destinationMapId === destination)!;
  expect(exit).toBeTruthy();
  await approachTarget(page, id, exit.id, true);
  await expect
    .poll(
      async () => {
        const p = await snapshot(page, id),
          actor = p.entities.find((value) => value.id === p.actorId)!;
        // Approach stops beside the exit; the authoritative transition permits distance <= 1.
        return (
          p.map.id === before.map.id && Math.abs(actor.x - exit.x) + Math.abs(actor.y - exit.y) <= 1
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await mapAction(page, id, exit.id, 'Перейти', true);
  await expect(page.getByTestId('game-position')).toHaveAttribute('data-map-id', destination);
}
async function prepare(page: Page, text: string) {
  const director = page.getByTestId('unified-story');
  await director.getByLabel('Твой ход', { exact: true }).fill(text);
  await director.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(director.getByTestId('story-quote')).toBeVisible();
  return director;
}
async function confirm(page: Page, revision: number) {
  await page
    .getByTestId('unified-story')
    .getByRole('button', { name: 'Подтвердить ход', exact: true })
    .click();
  await expect(page.getByTestId('unified-story')).toHaveAttribute(
    'data-canon-revision',
    String(revision),
    { timeout: 30000 },
  );
  await expect(page.getByTestId('story-feed').locator('[data-story-kind="narration"]')).toHaveCount(
    revision,
  );
}
test('two realtime players coauthor committed evolving scenes, travel and retain shared canon on reload', async ({
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
    await legacyRealtimeLaunch(owner);
    await owner.goto('/adventures/old-observatory');
    await owner.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
    await expect(owner).toHaveURL(/\/game\/[a-f0-9-]+$/);
    const id = new URL(owner.url()).pathname.split('/').at(-1)!;
    await expect(owner.getByText('Подключено', { exact: true })).toBeVisible();
    await campaignDetails(owner);
    await owner.getByLabel('Пригласить по имени пользователя').fill(guestHandle);
    await owner.getByRole('button', { name: 'Пригласить игрока', exact: true }).click();
    await expect(owner.getByText('Игрок приглашён', { exact: true })).toBeVisible();
    await guest.goto('/game');
    await guest
      .getByRole('button', { name: 'Принять приглашение в кампанию', exact: true })
      .click();
    await expect(guest).toHaveURL(new RegExp(`/game/${id}$`));
    await expect(guest.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(owner.locator(`[data-member-handle="${guestHandle}"]`)).toHaveAttribute(
      'data-member-status',
      'accepted',
      { timeout: 15000 },
    );
    await expect(
      owner.locator(`[data-member-handle="${guestHandle}"]`).getByText('Принято', { exact: true }),
    ).toBeVisible();
    await campaignDetails(owner, false);
    await expect(owner.getByTestId('game-advanced')).toHaveCount(0);
    const original = await snapshot(owner, id);
    const originalMap = original.map.id;
    const originalExits = original.map.exits.map((exit) => exit.id);
    await prepare(owner, 'Я ищу новый путь расследования за стенами обсерватории.');
    await expect(
      guest.getByTestId('story-feed').locator('[data-story-kind="narration"]'),
    ).toHaveCount(0);
    await confirm(owner, 1);
    await expect(guest.getByTestId('unified-story')).toHaveAttribute('data-canon-revision', '1');
    const expanded = await snapshot(owner, id);
    const first = {
      sceneId: expanded.map.exits.find((exit) => !originalExits.includes(exit.id))!
        .destinationMapId,
      npcId: '',
    };
    expect(first.sceneId).toBeTruthy();
    expect((await snapshot(owner, id)).map.id).toBe(originalMap); // No client-side teleport.
    await travel(owner, id, first.sceneId);
    first.npcId = (await snapshot(owner, id)).entities.find((entity) => entity.kind === 'npc')!.id;
    expect((await readProjection(owner, id)).entities.some((e) => e.id === first.npcId)).toBe(true);
    expect((await readProjection(guest, id)).entities.some((e) => e.id === first.npcId)).toBe(
      false,
    );
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
    await expect(owner.getByTestId('scene-media')).toHaveCount(0);
    // The removed gameplay control does not remove media APIs or explicit consent.
    const mediaPath = `/api/v1/game/campaigns/${id}`;
    const prepResponse = await owner.request.post(`${mediaPath}/media-preparation`, {
      data: { kind: 'background' },
    });
    expect(prepResponse.ok()).toBeTruthy();
    const background = await prepResponse.json();
    expect(
      (
        await owner.request.post(`${mediaPath}/media-attach`, {
          data: {
            operationId: randomUUID(),
            expectedCanonRevision: background.canonRevision,
            expectedMapId: background.expectedMapId,
            kind: 'background',
            revisionId: revision,
          },
        })
      ).ok(),
    ).toBeTruthy();
    await expect(owner.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1', {
      timeout: 15000,
    });
    const portraitPreparation = await owner.request.post(`${mediaPath}/media-preparation`, {
      data: { kind: 'portrait', entityId: first.npcId },
    });
    expect(portraitPreparation.ok()).toBeTruthy();
    const prep = await portraitPreparation.json();
    const quoteResponse = await owner.request.post('/api/v1/image-generation/quotes', {
      data: {
        adventureId: prep.adventureId,
        prompt: prep.prompt,
        title: prep.grounding.subject.label.slice(0, 120),
        framingVersion: prep.spec.framingVersion,
        imageFraming: prep.spec.imageFraming,
        kind: prep.spec.kind,
        camera: prep.spec.camera,
        tags: prep.spec.tags,
        background: prep.spec.background,
        referenceRevisionIds: prep.spec.referenceRevisionIds,
        rights: {
          basis: 'generated',
          licenseLabel: 'Mock sample for test only',
          attribution: '',
          allowAuthorReuse: false,
          attested: true,
        },
        mode: 'mock',
        declineReuse: true,
        campaignContext: {
          campaignId: id,
          expectedCanonRevision: prep.canonRevision,
          groundingHash: prep.groundingHash,
          kind: 'portrait',
          entityId: first.npcId,
        },
      },
    });
    expect(quoteResponse.ok()).toBeTruthy();
    const { quote } = await quoteResponse.json();
    expect(quote.mode).toBe('mock');
    expect(quote.upperMicros).toBe(0);
    const jobResponse = await owner.request.post('/api/v1/image-generation/jobs', {
      data: { quoteId: quote.id, operationId: randomUUID(), consent: true },
    });
    expect(jobResponse.ok()).toBeTruthy();
    const jobId = (await jobResponse.json()).id;
    let portraitId = '';
    await expect
      .poll(
        async () => {
          const result = await owner.request.get(`/api/v1/image-generation/jobs/${jobId}`);
          expect(result.ok()).toBeTruthy();
          const job = await result.json();
          portraitId = job.revisionId || '';
          return job.status;
        },
        { timeout: 30000 },
      )
      .toBe('admitted');
    expect(
      (
        await owner.request.post(`${mediaPath}/media-attach`, {
          data: {
            operationId: randomUUID(),
            expectedCanonRevision: prep.canonRevision,
            expectedMapId: prep.expectedMapId,
            kind: 'portrait',
            entityId: first.npcId,
            revisionId: portraitId,
          },
        })
      ).ok(),
    ).toBeTruthy();
    await mapAction(owner, id, first.npcId, 'Осмотреть');
    const appliedPortrait = owner
      .getByTestId('npc-public-inspection')
      .locator(`img[src*="${portraitId}"][src*="campaignId"]`);
    await expect(appliedPortrait).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() =>
        appliedPortrait.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await owner.locator('main').scrollIntoViewIfNeeded();
    await owner.evaluate(() => scrollTo(0, 0));
    await owner.screenshot({ path: test.info().outputPath('director-generated-scene.png') });
    const waitingText = 'Я предлагаю проверить следы в нашей исходной комнате.';
    await prepare(guest, waitingText);
    const firstSceneExits = (await snapshot(owner, id)).map.exits.map((exit) => exit.id);
    await prepare(owner, 'В новом помещении я продолжаю расследование и ищу следующий проход.');
    await confirm(owner, 2);
    await expect(guest.getByTestId('unified-story')).toHaveAttribute('data-canon-revision', '2');
    await expect(guest.getByTestId('story-quote')).toHaveCount(0); // Shared canon invalidates old quote.
    await expect(guest.getByLabel('Твой ход', { exact: true })).toHaveValue(waitingText);
    const second = {
      sceneId: (await snapshot(owner, id)).map.exits.find(
        (exit) => !firstSceneExits.includes(exit.id),
      )!.destinationMapId,
    };
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
    await expect(owner.getByTestId('unified-story')).toHaveAttribute('data-canon-revision', '3');
    await Promise.all([owner.reload(), guest.reload()]);
    for (const page of [owner, guest])
      await expect(
        page.getByTestId('story-feed').locator('[data-story-kind="narration"]'),
      ).toHaveCount(3);
    await expect(owner.getByTestId('game-position')).toHaveAttribute('data-map-id', first.sceneId);
    await expect(owner.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1', {
      timeout: 15000,
    });
    await owner.getByTestId('unified-story').scrollIntoViewIfNeeded();
    await owner.screenshot({ path: test.info().outputPath('director-shared-history.png') });
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.locator('header').getByRole('combobox').selectOption('uk');
    await expect(guest.getByRole('region', { name: 'Історія', exact: true })).toBeVisible();
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
