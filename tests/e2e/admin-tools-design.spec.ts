import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { settingsSchema } from '../../packages/contracts/src/index';
import { DIRECTOR_STYLE_PRESETS } from '../../packages/contracts/src/director-style';

// Every response is synthetic and intercepted. No real administrative operation or provider call.
async function fixture(page: Page, locale = 'ru', theme = 'dark') {
  const user = {
    id: 'tool-admin',
    name: 'Synthetic admin',
    handle: 'synthetic_admin',
    role: 'admin',
    onboarded: true,
    settings: settingsSchema.parse({ language: locale, theme }),
  };
  const taxonomy = {
    revision: 2,
    genres: ['Fantasy'],
    genreDefinitions: [
      { id: 'fantasy', value: 'Fantasy', labels: { ru: 'Фэнтези', en: 'Fantasy', uk: 'Фентезі' } },
    ],
    tags: [{ id: 'cozy', labels: { ru: 'Уют', en: 'Cozy', uk: 'Затишок' }, aliases: ['warm'] }],
  };
  const state = {
    empty: false,
    error: false,
    pending: false,
    requests: [] as { path: string; body: Record<string, unknown> }[],
    release: () => {},
  };
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') {
      state.requests.push({ path, body: req.postDataJSON() });
      if (state.pending)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      return route.fulfill({ status: 409, json: { code: 'CONFLICT' } });
    }
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/sparks/wallet'))
      return route.fulfill({
        json: {
          ownerId: user.id,
          enabled: true,
          balanceSubunits: '500000',
          heldSubunits: '0',
          availableSubunits: '500000',
          subunitsPerSpark: '10000',
          ledger: [],
        },
      });
    if (state.error && path.includes('/admin/'))
      return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } });
    if (path.endsWith('/taxonomy')) return route.fulfill({ json: taxonomy });
    if (path.endsWith('/admin/users')) return route.fulfill({ json: state.empty ? [] : [user] });
    if (path.endsWith('/admin/reports'))
      return route.fulfill({
        json: state.empty
          ? []
          : [
              {
                id: 'report-open',
                adventureId: 'synthetic-adventure-one',
                reason: 'Synthetic report: please review the content warning.',
                status: 'open',
                createdAt: '2026-01-02T10:00:00Z',
              },
              {
                id: 'report-closed',
                adventureId: 'synthetic-adventure-two',
                reason: 'Synthetic resolved report.',
                resolution: 'Synthetic decision, retained unchanged.',
                status: 'resolved',
                createdAt: '2026-01-01T10:00:00Z',
              },
            ],
      });
    if (path.endsWith('/admin/models'))
      return route.fulfill({
        json: state.empty
          ? []
          : [
              {
                id: 'profile-fixture',
                key: 'fixture',
                name: 'Synthetic storyteller',
                description:
                  'A synthetic behavioral profile for presentation testing. Not a provider configuration.',
                instructions: 'Synthetic source instructions.',
                enabled: true,
                version: 3,
              },
            ],
      });
    if (path.endsWith('/admin/runtimes'))
      return route.fulfill({
        json: state.empty
          ? []
          : [
              {
                id: 'runtime-fixture',
                name: 'Synthetic mock',
                provider: 'mock',
                model: 'mock-narrative',
                endpointId: 'mock',
                maxInputTokens: 16000,
                maxOutputTokens: 2000,
                timeoutMs: 30000,
                concurrency: 1,
                enabled: true,
              },
            ],
      });
    if (path.endsWith('/admin/directors'))
      return route.fulfill({
        json: {
          revision: 1,
          defaultProfileId: 'coauthor',
          profiles: [
            {
              id: 'coauthor',
              name: 'Synthetic director',
              description: 'Synthetic director fixture.',
              enabled: true,
              ...DIRECTOR_STYLE_PRESETS.coauthor,
            },
          ],
        },
      });
    if (path.endsWith('/admin/audit'))
      return route.fulfill({
        json: state.empty
          ? []
          : [
              {
                id: 'audit-fixture',
                actorId: user.id,
                actorName: user.name,
                action: 'model.update',
                targetType: 'model',
                targetId: 'profile-fixture',
                createdAt: '2026-01-02T10:00:00Z',
              },
              {
                id: 'audit-unknown',
                actorId: null,
                action: 'synthetic.unknown_event',
                targetId: 'synthetic-target',
                createdAt: '2026-01-01T10:00:00Z',
              },
            ],
      });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return state;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
for (const locale of ['ru', 'uk', 'en']) {
  for (const width of [1536, 390]) {
    for (const theme of ['dark', 'light']) {
      test(`remaining admin tools ${locale} ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(120_000);
        const state = await fixture(page, locale, theme);
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        for (const path of ['reports', 'taxonomy', 'models', 'credits', 'audit']) {
          await page.goto(`/admin/${path}`);
          const tool = page.locator(`[data-admin-tool="${path}"]`);
          await expect(tool).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          if (path === 'reports') {
            await expect(tool.getByRole('button')).toHaveCount(2);
            const trigger = tool.getByRole('button').first();
            await trigger.click();
            await expect(page.getByRole('dialog')).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await expect(tool.getByRole('button').last()).toBeDisabled();
          }
          if (path === 'taxonomy') {
            await expect(tool.locator('tbody tr')).toHaveCount(2);
            const picker = tool.locator('fieldset').first().getByRole('button').first();
            await picker.click();
            await page.keyboard.press('Escape');
            await expect(picker).toBeFocused();
          }
          if (path === 'models')
            await expect(tool.getByText('Synthetic storyteller', { exact: true })).toBeVisible();
          if (path === 'credits') {
            await expect(tool.locator('[data-admin-currency="sparks"] select option')).toHaveCount(
              2,
            );
            const dreams = tool.locator('[data-admin-currency="dreams"]');
            await expect(dreams.locator('select option')).toHaveCount(2);
            await expect(dreams.getByRole('heading')).toHaveText(
              { ru: 'Выдача грёз', uk: 'Видача мрій', en: 'Grant Dreams' }[locale],
            );
          }
          if (path === 'audit') {
            await expect(tool.locator('tbody tr')).toHaveCount(2);
            await tool.locator('input').fill('synthetic.unknown_event');
            await expect(tool.locator('tbody tr')).toHaveCount(1);
            await tool.locator('input').fill('no-match');
            await expect(tool.locator('tbody tr')).toHaveCount(0);
            await tool.locator('input').fill('');
          }
          await capture(page, info, `${path}-${locale}-${width}-${theme}`);
        }
        expect(state.requests).toEqual([]);
      });
    }
  }
}

test('admin tool dialogs preserve data on cancel and block dismissal while saving', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/admin/models');
  const models = page.locator('[data-admin-tool="models"]');
  const edit = models.getByRole('button', { name: 'Настроить профиль', exact: true });
  await edit.click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название профиля', { exact: true }).fill('Unsaved fixture');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(edit).toBeFocused();
  await edit.click();
  await expect(dialog.getByLabel('Название профиля', { exact: true })).toHaveValue(
    'Synthetic storyteller',
  );
  await dialog.getByLabel('Название профиля', { exact: true }).fill('Preserved fixture');
  state.pending = true;
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).not.toBeInViewport();
  state.release();
  const saveError = dialog.getByRole('alert');
  await expect(saveError).toBeVisible();
  await expect(saveError.locator('..')).toBeFocused();
  await expect(saveError).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(dialog.getByLabel('Название профиля', { exact: true })).toHaveValue(
    'Preserved fixture',
  );
  await capture(page, info, 'models-error-dialog');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(edit).toBeFocused();
  expect(state.requests[0].body).toMatchObject({
    key: 'fixture',
    name: 'Preserved fixture',
    instructions: 'Synthetic source instructions.',
    enabled: true,
  });

  await page.goto('/admin/reports');
  await page.locator('[data-admin-tool="reports"]').getByRole('button').first().click();
  dialog = page.getByRole('dialog');
  await dialog.locator('select').selectOption('dismissed');
  await dialog.locator('textarea').fill('Synthetic explanation.');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  state.release();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(state.requests[1].body).toEqual({
    status: 'dismissed',
    resolution: 'Synthetic explanation.',
  });
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();

  await page.goto('/admin/credits');
  const credits = page.locator('[data-admin-currency="sparks"]');
  await credits.locator('select').selectOption('tool-admin');
  await credits.locator('textarea').fill('Synthetic adjustment only.');
  await credits.locator('button[type="submit"]').click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(state.requests.length).toBe(2);
  await expect(credits.locator('button[type="submit"]')).toBeFocused();
  await credits.locator('button[type="submit"]').click();
  await dialog.getByRole('button', { name: 'Подтвердить операцию', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(3);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toBeVisible();
  state.release();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const key = state.requests[2].body.idempotencyKey;
  state.pending = false;
  await dialog.getByRole('button', { name: 'Подтвердить операцию', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(4);
  expect(state.requests[3].body.idempotencyKey).toBe(key);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
});

test('admin tools handle empty and failed resources without invented data', async ({
  page,
}, info) => {
  const state = await fixture(page);
  state.empty = true;
  for (const path of ['reports', 'models', 'audit']) {
    await page.goto(`/admin/${path}`);
    const tool = page.locator(`[data-admin-tool="${path}"]`);
    await expect(tool).toBeVisible();
    if (path === 'models')
      await expect(tool.getByText('Поведенческих профилей пока нет')).toBeVisible();
    else await expect(tool.locator('.empty')).toBeVisible();
    await capture(page, info, `${path}-empty`);
  }
  state.error = true;
  for (const path of ['reports', 'taxonomy', 'models', 'credits', 'audit']) {
    await page.goto(`/admin/${path}`);
    await expect(
      page.locator(`[data-admin-tool="${path}"]`).getByRole('alert').first(),
    ).toBeVisible();
    await capture(page, info, `${path}-error`);
  }
  expect(state.requests).toEqual([]);
});

test('admin tools show loading before their isolated resources settle', async ({ page }, info) => {
  await fixture(page);
  for (const path of ['reports', 'taxonomy', 'models', 'audit']) {
    let release: () => void = () => {};
    let waiting = false;
    const pattern = `**/api/v1/admin/${path}`;
    await page.route(pattern, async (route) => {
      waiting = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fallback();
    });
    await page.goto(`/admin/${path}`);
    await expect.poll(() => waiting).toBe(true);
    await expect(page.locator(`[data-admin-tool="${path}"] .skeleton-set`).first()).toBeVisible();
    await capture(page, info, `${path}-loading`);
    release();
    await expect(page.locator(`[data-admin-tool="${path}"] .skeleton-set`)).toHaveCount(0);
    await page.unroute(pattern);
  }
});

test('runtime provider changes stay disabled and taxonomy cancel preserves source identity', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/admin/models');
  const runtimeEdit = page.locator('[data-admin-tool="models"] tbody button');
  await runtimeEdit.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Провайдер', exact: true }).selectOption('openai');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0].body).toMatchObject({
    provider: 'openai',
    endpointId: 'openai',
    enabled: false,
    model: 'mock-narrative',
    maxInputTokens: 16000,
    maxOutputTokens: 2000,
    timeoutMs: 30000,
    concurrency: 1,
  });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(runtimeEdit).toBeFocused();
  await runtimeEdit.click();
  await expect(dialog.getByRole('combobox', { name: 'Провайдер', exact: true })).toHaveValue(
    'mock',
  );
  await page.keyboard.press('Escape');
  await page.goto('/admin/taxonomy');
  const tool = page.locator('[data-admin-tool="taxonomy"]');
  await tool.locator('tbody button').first().click();
  await expect(tool.getByLabel('ID жанра', { exact: true })).not.toBeEditable();
  await tool.getByLabel('Английский', { exact: true }).fill('Unsaved genre');
  await tool.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(tool.locator('tbody tr').first()).toContainText('Fantasy');
  await expect(tool.getByLabel('ID жанра', { exact: true })).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
});

test('Dreams grant panel isolates currency, confirms intent and safely retries an interrupted response', async ({
  page,
}, info) => {
  const state = await fixture(page);
  const requests: { userId: string; amount: number; reason: string; idempotencyKey: string }[] = [];
  const seen = new Set<string>();
  let release: () => void = () => {};
  let first = true;
  await page.route('**/api/v1/admin/dreams', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    seen.add(body.idempotencyKey);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return route.abort('connectionclosed');
    }
    return route.fulfill({
      status: 201,
      json: {
        dreams: {
          ownerId: 'tool-admin',
          currency: 'dreams',
          balanceSubunits: '1500000',
          heldSubunits: '25000',
          availableSubunits: '1475000',
          subunitsPerDream: '10000',
          spendingAvailable: true,
          ledger: [
            {
              id: '1',
              kind: 'admin_credit',
              amountSubunits: '1000000',
              createdAt: '2026-11-06T00:00:00Z',
            },
          ],
        },
      },
    });
  });
  await page.goto('/admin/credits');
  const dreams = page.locator('[data-admin-currency="dreams"]');
  const sparks = page.locator('[data-admin-currency="sparks"]');
  await expect(page.getByText('Неизменяемый учёт', { exact: true })).toHaveCount(0);
  await sparks.locator('textarea').fill('Keep the independent Sparks draft.');
  await dreams.locator('select').selectOption('tool-admin');
  await dreams.locator('textarea').fill('Synthetic Dreams reward.');
  for (const amount of ['0', '-1', '1.5']) {
    await dreams.locator('input').fill(amount);
    await expect(dreams.locator('button[type="submit"]')).toBeDisabled();
  }
  await dreams.locator('input').fill('100');
  const trigger = dreams.locator('button[type="submit"]');
  await trigger.click();
  let dialog = page.getByRole('dialog', { name: 'Подтвердить выдачу грёз?' });
  await expect(dialog).toContainText('+100 Грёзы');
  await expect(dialog).toContainText('@synthetic_admin');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(requests).toHaveLength(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Подтвердить операцию', exact: true });
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => requests.length).toBe(1);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(seen.size).toBe(1);
  await expect(dreams.getByRole('status')).toContainText('147,50');
  await expect(sparks.locator('textarea')).toHaveValue('Keep the independent Sparks draft.');
  await expect(sparks.locator('select')).toHaveValue('');
  await expect(sparks.locator('input')).toHaveValue('100');
  expect(state.requests).toEqual([]);
  await trigger.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Подтвердить операцию', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).toHaveLength(3);
  expect(requests[2].idempotencyKey).not.toBe(requests[1].idempotencyKey);
  await capture(page, info, 'dreams-grant-complete');
  await dreams.locator('select').selectOption('');
  await expect(dreams.getByRole('status')).toHaveCount(0);
});
