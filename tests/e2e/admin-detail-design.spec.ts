import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { adventureSchema, settingsSchema } from '@dreamwalk/contracts';
import { readFile } from 'node:fs/promises';

// Synthetic route fixtures only. No real contacts, private source content or moderation.
async function fixture(page: Page, locale = 'ru', theme = 'dark') {
  const user = {
    id: 'visual-reviewer',
    name: 'Reviewer',
    handle: 'reviewer',
    email: 'reviewer@example.test',
    role: 'admin',
    onboarded: true,
    emailVerified: true,
    avatarAssetId: null,
    createdAt: '2026-01-02T10:00:00Z',
    settings: settingsSchema.parse({ language: locale, theme }),
  };
  const stories = ['pending_review', 'published', 'draft'].map((status, i) => ({
    ...adventureSchema.parse({
      title: `Synthetic review ${i + 1}`,
      status,
      visibility: 'public',
      sourceLanguage: 'en',
      synopsis: 'Synthetic synopsis for layout and interaction verification.',
      tags: ['Synthetic'],
      content: {
        world: 'Synthetic world notes.',
        rules: 'Synthetic rules.',
        locations: [{ id: 'room', name: 'Test room', description: 'A synthetic room.' }],
      },
    }),
    id: `visual-story-${i}`,
    ownerId: 'visual-author',
    version: i + 1,
    author: { name: 'Test Author', handle: 'test_author' },
    coverAssetId: i === 0 ? 'visual-cover' : i === 2 ? 'unavailable-cover' : null,
    updatedAt: '2026-01-03T12:00:00Z',
    createdAt: '2026-01-02T10:00:00Z',
  }));
  const requests: { path: string; body: unknown }[] = [];
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== 'GET') {
      requests.push({ path: url.pathname, body: req.postDataJSON() });
      if (url.pathname.endsWith('/moderate'))
        return route.fulfill({ status: 409, json: { code: 'STALE_REVIEW' } });
      return route.fulfill({ status: 400, json: { code: 'VALIDATION_FAILED' } });
    }
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (url.pathname.endsWith('/admin/users')) {
      const users = [
        user,
        {
          ...user,
          id: 'visual-writer',
          name: 'Test Writer',
          handle: 'writer',
          email: 'writer@example.test',
          role: 'user',
          avatarAssetId: 'unavailable-avatar',
        },
      ];
      return route.fulfill({
        json: users.filter((u) =>
          `${u.name} ${u.handle} ${u.email}`
            .toLowerCase()
            .includes((url.searchParams.get('q') || '').toLowerCase()),
        ),
      });
    }
    if (url.pathname.endsWith('/admin/adventures'))
      return route.fulfill({
        json: stories.filter(
          (a) => !url.searchParams.get('status') || a.status === url.searchParams.get('status'),
        ),
      });
    if (url.pathname.endsWith('/playable-review'))
      return route.fulfill({
        json: {
          versionId: 'synthetic-version-1',
          sourceRevision: 1,
          preparationRequired: true,
          compiled: null,
          sourceSummary: { title: 'Synthetic source version', locations: [], npcs: [] },
        },
      });
    if (url.pathname.endsWith('/assets/visual-cover/file'))
      return route.fulfill({
        contentType: 'image/webp',
        body: await readFile('apps/web/public/images/forest.webp'),
      });
    if (url.pathname.endsWith('/admin/npcs')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return requests;
}

async function capture(page: Page, info: TestInfo, name: string, resetDialog = true) {
  if (resetDialog)
    await page.getByRole('dialog').evaluateAll((dialogs) =>
      dialogs.forEach((dialog) => {
        dialog.scrollTop = 0;
      }),
    );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((img) => img.loading !== 'lazy')
        .map((img) => img.decode().catch(() => undefined)),
    );
  });
  await info.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

for (const locale of ['ru', 'en', 'uk']) {
  test(`admin tables and two-column review retain real controls (${locale})`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const requests = await fixture(page, locale);
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.goto('/admin/users');
      await expect(page.locator('tbody tr')).toHaveCount(2);
      await expect(page.locator('tbody tr').first().getByRole('button')).toBeDisabled();
      await expect(page.locator('tbody tr').last().locator('img')).toHaveCount(0);
      await page.locator('tbody tr').last().getByRole('button').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('tbody tr').last().getByRole('button')).toBeFocused();
      await page.locator('section form input').fill('nobody-matches');
      await page.locator('section form input').press('Enter');
      await expect(page.locator('tbody tr')).toHaveCount(0);
      await page.locator('section form input').fill('');
      await page.locator('section form input').press('Enter');
      await expect(page.locator('tbody tr')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await capture(page, info, `admin-users-${locale}-${width}-dark`);
      await page.goto('/admin/adventures');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      const cover = page.locator('tbody img');
      await expect
        .poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      await page.locator('section select').selectOption('');
      await expect(page.locator('tbody tr')).toHaveCount(3);
      await expect(page.locator('tbody tr').nth(1).locator('img')).toHaveCount(0);
      await expect(page.locator('tbody tr').nth(2).locator('img')).toHaveCount(0);
      await capture(page, info, `admin-content-${locale}-${width}-dark`);
      await page.locator('tbody tr').first().getByRole('button').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('form select')).toHaveValue('approve');
      await expect(dialog.locator('form select option')).toHaveCount(3);
      await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
      await expect(dialog.getByRole('checkbox')).toBeVisible();
      const article = await dialog.locator('article').boundingBox();
      const form = await dialog.locator('form').boundingBox();
      if (width === 1536) expect(form!.x).toBeGreaterThan(article!.x + article!.width);
      else expect(form!.y).toBeGreaterThan(article!.y + article!.height);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await capture(page, info, `admin-review-${locale}-${width}-dark`);
      await dialog.getByRole('checkbox').check();
      await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
      await dialog.locator('button[type="button"]').last().click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('tbody tr').first().getByRole('button')).toBeFocused();
      await page.locator('tbody tr').first().getByRole('button').click();
      await expect(page.getByRole('dialog').getByRole('checkbox')).not.toBeChecked();
      await page.keyboard.press('Escape');
      await expect(page.locator('tbody tr').first().getByRole('button')).toBeFocused();
      await page.locator('tbody tr').nth(1).getByRole('button').click();
      await expect(dialog.locator('select')).toHaveValue('quarantine');
      await expect(dialog.locator('option[value="approve"]')).toHaveJSProperty('disabled', true);
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.locator('tbody tr').nth(2).getByRole('button').click();
      await expect(dialog.locator('select')).toHaveValue('reject');
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(requests).toEqual([]);
  });
}

test('review retains stale-version guard and remains readable in light mode', async ({
  page,
}, info) => {
  const requests = await fixture(page, 'en', 'light');
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/admin/adventures');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('tbody tr').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').check();
  await dialog.locator('textarea').fill('Synthetic review only.');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
  await expect(dialog).toContainText('changed');
  expect(requests).toEqual([
    {
      path: '/api/v1/admin/adventures/visual-story-0/moderate',
      body: {
        decision: 'approve',
        reason: 'Synthetic review only.',
        reviewedPlayableVersionId: 'synthetic-version-1',
      },
    },
  ]);
  await capture(page, info, 'admin-review-en-1536-light-stale');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await capture(page, info, 'admin-review-en-390-light-stale');
});

test('compiled map, NPC and pinned art controls stay independent of decision submission', async ({
  page,
}, info) => {
  const requests = await fixture(page, 'en');
  const versionId = '10000000-0000-4000-8000-000000000001';
  const revisionId = '10000000-0000-4000-8000-000000000002';
  const map = (id: string) => ({
    id,
    label: `Synthetic ${id}`,
    width: 3,
    height: 2,
    blocked: [],
    spawns: [{ x: 0, y: 0 }],
    exits: [],
  });
  await page.route('**/playable-review', (route) =>
    route.fulfill({
      json: {
        versionId,
        sourceRevision: 1,
        preparationRequired: false,
        compiled: {
          schemaVersion: 3,
          rulesetVersion: 'hybrid-v3',
          title: 'Synthetic compiled version',
          startMapId: 'room',
          maps: { room: map('room'), hall: map('hall') },
          entities: {
            keeper: {
              id: 'keeper',
              kind: 'npc',
              label: 'Synthetic keeper',
              mapId: 'room',
              x: 1,
              y: 0,
            },
          },
          npcPolicy: 'reactive-v1',
          npcProfiles: [
            {
              npcId: 'keeper',
              personality: null,
              initialGoal: 'Test',
              patrolTarget: { x: 1, y: 0 },
            },
          ],
          artBindings: [{ slot: 'map:room', revisionId }],
          roundPolicy: { maxRounds: 2, planningMs: 1000 },
          assetManifest: { id: 'synthetic-assets', sha256: 'a'.repeat(64) },
        },
      },
    }),
  );
  await page.route('**/manifest', (route) =>
    route.fulfill({
      json: {
        checksum: 'a'.repeat(64),
        bindings: [
          {
            slot: 'map:room',
            revision: {
              id: revisionId,
              revision: 1,
              width: 128,
              height: 128,
              sha256: 'b'.repeat(64),
              url: `/api/v1/asset-library/revisions/${revisionId}/file?playableVersionId=${versionId}`,
              metadata: {
                title: 'Synthetic pinned artwork',
                rights: {
                  attribution: 'Synthetic CI fixture',
                  licenseLabel: 'Bundled test fixture',
                },
              },
            },
          },
        ],
      },
    }),
  );
  let imageCalls = 0;
  let imageAllowed = false;
  await page.route(`**/asset-library/revisions/${revisionId}/file?*`, async (route) => {
    imageCalls++;
    if (!imageAllowed) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      contentType: 'image/webp',
      body: await readFile('apps/web/public/images/forest.webp'),
    });
  });
  let npcCalls = 0;
  await page.route('**/npc-preview', (route) => {
    npcCalls++;
    return route.fulfill({
      json: { versionId, brain: { living: { observations: [] } }, tick: 20 },
    });
  });
  const decisions: unknown[] = [];
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  await page.route('**/moderate', async (route) => {
    decisions.push(route.request().postDataJSON());
    await decisionGate;
    return route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/admin/adventures');
  const opener = page.locator('tbody tr').first().getByRole('button');
  await opener.click();
  const dialog = page.getByRole('dialog');
  const save = dialog.locator('button[type="submit"]');
  await dialog.locator('textarea').fill('Synthetic compiled review only.');
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: 'Reload submitted version', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Map to review', exact: true }).selectOption('hall');
  await dialog.getByRole('button', { name: 'Test this submission’s NPC', exact: true }).click();
  await expect.poll(() => npcCalls).toBe(1);
  await dialog.locator('input[type="number"]').fill('121');
  await expect(
    dialog.getByRole('button', { name: 'Test this submission’s NPC', exact: true }),
  ).toBeDisabled();
  const image = dialog.getByRole('img', { name: 'Synthetic pinned artwork' });
  await image.scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  expect(imageCalls).toBeGreaterThan(0);
  imageAllowed = true;
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await image.evaluate((img: HTMLImageElement) => img.decode());
  await expect(dialog.getByRole('checkbox')).toBeEnabled();
  await dialog.getByRole('checkbox').check();
  await expect(save).toBeEnabled();
  expect(decisions).toEqual([]);
  expect(requests).toEqual([]);
  await capture(page, info, 'admin-review-compiled-readiness-en-1536', false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByRole('checkbox').scrollIntoViewIfNeeded();
  await capture(page, info, 'admin-review-compiled-readiness-en-390', false);
  await save.click();
  await expect(save).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
  await save.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions).toEqual([
    {
      decision: 'approve',
      reason: 'Synthetic compiled review only.',
      reviewedPlayableVersionId: versionId,
    },
  ]);
  releaseDecision();
  await expect(dialog).toHaveCount(0);
});
