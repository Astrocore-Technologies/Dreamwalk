import { test, expect, type Page } from '@playwright/test';
import { adventureSchema, settingsSchema } from '@dreamwalk/contracts';
import { adminStoryDeletionCopy } from '../../apps/web/components/studio/admin-story-deletion-copy';

// Intercepted synthetic requests only. No real story deletion or restoration.
async function fixture(page: Page, locale: 'ru' | 'en' | 'uk') {
  const story = {
    ...adventureSchema.parse({
      title: 'Synthetic deletion story',
      status: 'published',
      visibility: 'public',
    }),
    id: 'cd53158e-04c4-4cc1-ab7d-634195019651',
    ownerId: 'synthetic-owner',
    deletionRevision: '0123456789abcdef0123456789abcdef',
    version: 1,
    author: { name: 'Synthetic author' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const state = {
    deleted: false,
    restored: false,
    deletionId: '',
    failNext: false,
    hold: null as Promise<void> | null,
    requests: [] as { method: string; body: Record<string, string> }[],
  };
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/auth/me'))
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-admin',
            name: 'Synthetic admin',
            handle: 'admin',
            email: 'admin@example.invalid',
            role: 'admin',
            onboarded: true,
            emailVerified: true,
            settings: settingsSchema.parse({ language: locale, theme: 'dark' }),
          },
        },
      });
    if (request.method() === 'GET') {
      if (path.endsWith('/admin/adventures/deleted'))
        return route.fulfill({
          json: state.deleted
            ? [
                {
                  id: story.id,
                  title: story.title,
                  deletionId: state.deletionId,
                  deletedAt: story.updatedAt,
                },
              ]
            : [],
        });
      if (path.endsWith('/admin/adventures'))
        return route.fulfill({ json: state.deleted || state.restored ? [] : [story] });
      return route.fulfill({ json: [] });
    }
    if (request.method() === 'DELETE' || path.endsWith('/restore')) {
      const body = request.postDataJSON();
      state.requests.push({ method: request.method(), body });
      if (state.hold) await state.hold;
      if (state.failNext) {
        state.failNext = false;
        return route.abort('failed');
      }
      if (request.method() === 'DELETE') {
        state.deleted = true;
        state.deletionId = body.operationId;
      } else {
        expect(body.deletionId).toBe(state.deletionId);
        state.deleted = false;
        state.restored = true;
      }
      return route.fulfill({
        json: { ok: true, deleted: state.deleted, deletionId: state.deletionId },
      });
    }
    return route.fulfill({ status: 400, json: { code: 'VALIDATION_FAILED' } });
  });
  await page.goto('/admin/adventures');
  return { state, story, copy: adminStoryDeletionCopy[locale] };
}

for (const locale of ['ru', 'en', 'uk'] as const)
  test(`admin trash confirms, cancels and restores only a draft (${locale})`, async ({ page }) => {
    const { state, story, copy } = await fixture(page, locale);
    const remove = page.getByRole('button', {
      name: copy.removeLabel.replace('{title}', story.title),
      exact: true,
    });
    await expect(remove).toBeEnabled();
    await remove.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(copy.removeNotice);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
    expect(state.requests).toHaveLength(0);
    await remove.click();
    await dialog.getByRole('button', { name: copy.confirmRemove, exact: true }).click();
    await expect(remove).toHaveCount(0);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].body.expectedRevision).toBe(story.deletionRevision);
    await page.getByRole('button', { name: copy.trash, exact: true }).click();
    await expect(page.getByRole('cell', { name: story.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy.restore, exact: true }).click();
    await expect(dialog).toContainText(copy.restoreNotice);
    await dialog.getByRole('button', { name: copy.restore, exact: true }).click();
    await expect(page.getByText(copy.empty, { exact: true })).toBeVisible();
    expect(state.requests).toHaveLength(2);
    expect(state.restored).toBe(true);
  });

test('admin deletion blocks pending dismissal and repeats uncertain requests with one identity', async ({
  page,
}) => {
  const { state, story, copy } = await fixture(page, 'ru');
  state.failNext = true;
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page
    .getByRole('button', { name: copy.removeLabel.replace('{title}', story.title), exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: copy.confirmRemove, exact: true });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.requests.length).toBe(1);
  release();
  state.hold = null;
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].body).toEqual(state.requests[0].body);
});
