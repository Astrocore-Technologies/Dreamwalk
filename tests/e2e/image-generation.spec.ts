import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import { authoringRequest, savePrivateFixture } from './support/private-authoring';

// Removed manual-map mock-generation controls are now API contract coverage.
// The current asset-library page verifies admitted material in the browser; no live provider calls.
test('mock image API requires explicit quote consent and never auto-binds or regenerates; library UI persists result', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  await authoringRequest(page, '/auth/register', {
    email: `image-${suffix}@example.test`,
    handle: `image_${suffix}`,
    name: 'Image QA',
    password: `Image-${randomUUID()}!`,
  });
  await page.goto('/studio/adventures/new');
  await page.getByLabel('Название приключения').fill(`Image QA ${suffix}`);
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/adventures\/[0-9a-f-]+$/);
  const storyId = page.url().split('/').at(-1)!;
  await savePrivateFixture(page, storyId, createAuthoredDraft('courtyard'));
  const configuration = await authoringRequest(page, '/image-generation/config');
  expect(configuration.mockAvailable).toBe(true);
  expect(configuration.externalEnabled).toBe(false);
  const input = {
    adventureId: storyId,
    mode: 'mock',
    title: `Mock artwork ${suffix}`,
    prompt: 'A drawn 2D courtyard. This is an offline fixture test.',
    kind: 'background',
    camera: 'top-down',
    tags: [],
    background: 'opaque',
    referenceRevisionIds: [],
    rights: {
      basis: 'generated',
      licenseLabel: 'Original project fixture',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
  };
  const quote = await authoringRequest(page, '/image-generation/quotes', input);
  expect(quote.decision).toBe('quote');
  const jobs = async () => authoringRequest(page, `/image-generation/jobs?adventureId=${storyId}`);
  expect((await jobs()).jobs).toHaveLength(0);
  const denied = await page.request.post('/api/v1/image-generation/jobs', {
    data: { quoteId: quote.quote.id, operationId: randomUUID(), consent: false },
  });
  expect(denied.status()).toBe(400);
  expect((await jobs()).jobs).toHaveLength(0);
  // Changing the request requires a different quote and a fresh, separately supplied consent.
  const changed = await authoringRequest(page, '/image-generation/quotes', {
    ...input,
    prompt: 'Updated synthetic courtyard description.',
  });
  expect(changed.quote.id).not.toBe(quote.quote.id);
  const operation = { quoteId: changed.quote.id, operationId: randomUUID(), consent: true };
  const job = await authoringRequest(page, '/image-generation/jobs', operation);
  expect((await authoringRequest(page, '/image-generation/jobs', operation)).id).toBe(job.id);
  await expect
    .poll(async () => (await authoringRequest(page, `/image-generation/jobs/${job.id}`)).status, {
      timeout: 20000,
    })
    .toBe('admitted');
  expect((await jobs()).jobs).toHaveLength(1);
  expect(
    (await authoringRequest(page, `/asset-library/stories/${storyId}/draft`)).bindings,
  ).toHaveLength(0);
  const reuse = await authoringRequest(page, '/image-generation/quotes', {
    ...input,
    prompt: 'Updated synthetic courtyard description.',
  });
  expect(reuse.decision).toBe('reuse');
  expect(reuse.providerCalls).toBe(0);
  expect(reuse.matches.length).toBeGreaterThan(0);
  const separate = await authoringRequest(page, '/image-generation/quotes', {
    ...input,
    prompt: 'Updated synthetic courtyard description.',
    declineReuse: true,
  });
  expect(separate.decision).toBe('quote');
  expect(separate.quote.id).not.toBe(changed.quote.id);
  expect((await jobs()).jobs).toHaveLength(1);
  await page.goto('/studio/assets');
  await expect(
    page.locator('[data-art-revision]').getByRole('heading', { name: input.title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('[data-art-revision]').getByRole('heading', { name: input.title, exact: true }),
  ).toBeVisible();
  expect((await jobs()).jobs).toHaveLength(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
