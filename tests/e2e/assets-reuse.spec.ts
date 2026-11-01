import {
  savePrivateFixture,
  launchPrivateFixture,
  authoringRequest,
} from './support/private-authoring';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
async function registerArt(page: Page, title: string, revision = false) {
  const form = page.getByRole('form', {
    name: revision ? 'Создать новую ревизию' : 'Добавить в библиотеку',
    exact: true,
  });
  const upload = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/assets') && r.request().method() === 'POST',
  );
  await form
    .locator('input[type="file"]')
    .setInputFiles(path.resolve('apps/web/public/images/observatory.webp'));
  expect((await upload).ok()).toBeTruthy();
  await form.getByLabel('Название материала', { exact: true }).fill(title);
  await form.getByLabel('Основание прав', { exact: true }).selectOption('generated');
  await form
    .getByLabel('Название лицензии или условий', { exact: true })
    .fill('Original Dreamwalk fixture — assets/demo/README.md');
  await form
    .getByLabel('Разрешить выдавать отдельные разрешения другим авторам', { exact: true })
    .check();
  await expect(form.locator('input[type="file"]')).toBeEnabled();
  await form
    .getByLabel('Подтверждаю, что имею права на это использование.', { exact: true })
    .check();
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/asset-library/revisions') && r.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Добавить в библиотеку', exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  return result.json() as Promise<{ id: string; familyId: string }>;
}
test('original raster reuse grant UI, API binding fixture and pinned actual playable canvas', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
    title = `QA art ${suffix}`;
  const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const guest = await guestContext.newPage();
  try {
    for (const [client, handle] of [
      [page, `art_${suffix}`],
      [guest, `art_guest_${suffix}`],
    ] as const) {
      const response = await client.request.post('/api/v1/auth/register', {
        data: {
          email: `${handle}@example.test`,
          handle,
          name: 'Art QA',
          password: `Art-${randomUUID()}!`,
        },
      });
      expect(response.status()).toBe(201);
    }
    await page.goto('/studio/assets');
    await page.getByRole('button', { name: 'Добавить в библиотеку', exact: true }).click();
    const original = await registerArt(page, title);
    await guest.goto('/studio/assets');
    await expect(guest.locator(`[data-art-revision="${original.id}"]`)).toHaveCount(0);
    await page
      .locator(`[data-art-revision="${original.id}"]`)
      .getByRole('button', { name: 'Подробнее', exact: true })
      .click();
    const grants = page.getByRole('region', {
      name: 'Разрешения на повторное использование',
      exact: true,
    });
    await grants.getByLabel('Имя пользователя автора', { exact: true }).fill(`art_guest_${suffix}`);
    await grants.getByRole('checkbox').first().check();
    const granted = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/revisions/${original.id}/grants`) && r.request().method() === 'POST',
    );
    await grants.getByRole('button', { name: 'Выдать разрешение', exact: true }).click();
    expect((await granted).ok()).toBeTruthy();
    await guest.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(guest.locator(`[data-art-revision="${original.id}"]`)).toBeVisible();
    await page.goto('/studio/adventures/new');
    await page.getByLabel('Название приключения').fill(`Art story ${suffix}`);
    await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/adventures\/[0-9a-f-]+$/);
    const storyUrl = page.url();
    const storyId = new URL(storyUrl).pathname.split('/').at(-1)!;
    const fixture = await savePrivateFixture(page, storyId, createAuthoredDraft('courtyard'));
    // The removed manual-map art editor is API fixture coverage; grant/revision/canvas stay browser-driven.
    const slot = `map:${fixture.draft.startMapId}:background`;
    const priorArt = await authoringRequest(page, `/asset-library/stories/${storyId}/draft`);
    await authoringRequest(
      page,
      `/asset-library/stories/${storyId}/draft`,
      {
        operationId: randomUUID(),
        expectedRevision: priorArt.revision,
        bindings: [{ slot, revisionId: original.id }],
      },
      'PUT',
    );
    await page.reload();
    expect(
      (await authoringRequest(page, `/asset-library/stories/${storyId}/draft`)).bindings,
    ).toContainEqual({ slot, revisionId: original.id });
    await launchPrivateFixture(page, storyId, false);
    const campaignUrl = page.url(),
      campaignId = campaignUrl.split('/').at(-1)!;
    await expect(page.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1');
    // Actual canvas evidence only: no account fields, cookies or synthetic mock screenshot.
    await page
      .locator('canvas')
      .first()
      .screenshot({ path: test.info().outputPath('custom-art-scene.png') });
    const manifest = await page.request.get(
      `/api/v1/asset-library/campaigns/${campaignId}/manifest`,
    );
    expect(
      (await manifest.json()).bindings.some(
        (b: { revisionId: string }) => b.revisionId === original.id,
      ),
    ).toBeTruthy();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.goto('/studio/assets');
    await page
      .locator(`[data-art-revision="${original.id}"]`)
      .getByRole('button', { name: 'Создать новую ревизию', exact: true })
      .click();
    const second = await registerArt(page, `${title} revision 2`, true);
    expect(second.id).not.toBe(original.id);
    expect(second.familyId).toBe(original.familyId);
    await page.goto(campaignUrl);
    await expect(page.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1');
    const pinned = await page.request.get(`/api/v1/asset-library/campaigns/${campaignId}/manifest`);
    const pinnedBody = await pinned.json();
    expect(
      pinnedBody.bindings.some((b: { revisionId: string }) => b.revisionId === original.id),
    ).toBeTruthy();
    expect(
      pinnedBody.bindings.some((b: { revisionId: string }) => b.revisionId === second.id),
    ).toBeFalsy();
    await page.goto(storyUrl);
    expect(
      (await authoringRequest(page, `/asset-library/stories/${storyId}/draft`)).bindings.some(
        (binding: { revisionId: string }) => binding.revisionId === original.id,
      ),
    ).toBe(true);
    await page.goto(campaignUrl);
    await expect(page.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '1');
    const management = await page.context().newPage();
    await management.goto('/studio/assets');
    await management
      .locator(`[data-art-revision="${original.id}"]`)
      .getByRole('button', { name: 'Подробнее', exact: true })
      .click();
    const withdrawal = management.getByRole('region', {
      name: 'Разрешения на повторное использование',
      exact: true,
    });
    await withdrawal.getByRole('checkbox').last().check();
    const withdrawn = management.waitForResponse(
      (r) =>
        r.url().endsWith(`/revisions/${original.id}/takedown`) && r.request().method() === 'POST',
    );
    await withdrawal.getByRole('button', { name: 'Снять материал с выдачи', exact: true }).click();
    expect((await withdrawn).ok()).toBeTruthy();
    await expect(page.locator('[data-art-loaded]')).toHaveAttribute('data-art-loaded', '0', {
      timeout: 10000,
    });
    await management.close();
  } finally {
    await guestContext.close();
  }
});
