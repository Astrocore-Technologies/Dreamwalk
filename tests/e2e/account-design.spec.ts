import { withShellPreferences } from './support/shell-preferences';
import { test, expect, type Page } from '@playwright/test';
import { settingsSchema, type Settings, type User } from '../../packages/contracts/src/index';

type ExportFixture = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
};

// Every API request is intercepted. These fixtures never mutate a real account;
// existing integration suites retain real authentication, ownership and RBAC checks.
async function mockAccount(page: Page, locale: 'ru' | 'uk' | 'en' = 'en') {
  const user: User = {
    id: 'visual-account',
    email: 'account-design@example.invalid',
    handle: 'reader',
    name: 'Reader',
    bio: '',
    avatarAssetId: null,
    role: 'admin',
    onboarded: true,
    emailVerified: false,
    emailVerificationRequired: false,
    createdAt: '2026-11-03T12:00:00Z',
    settings: settingsSchema.parse({ language: locale, theme: 'dark' }),
  };
  const fixture = {
    user,
    signedIn: true,
    authReads: 0,
    sessionReads: 0,
    exportReads: 0,
    emailRequests: [] as unknown[],
    emailResponse: { status: 200, code: 'EMAIL_DELIVERY_UNAVAILABLE' },
    exportRequests: [] as unknown[],
    downloads: [] as string[],
    settingsPatches: [] as Settings[],
    profilePatches: [] as unknown[],
    passwordChanges: [] as unknown[],
    accountDeletes: [] as unknown[],
    sessionDeletes: [] as { id: string; body: unknown }[],
    exports: [] as ExportFixture[],
    sessions: [
      {
        id: 'synthetic-current-session',
        current: true,
        createdAt: '2026-11-03T12:00:00Z',
        lastSeenAt: '2026-11-03T12:00:00Z',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0',
      },
      {
        id: 'synthetic-other-session',
        current: false,
        createdAt: '2026-11-02T12:00:00Z',
        lastSeenAt: '2026-11-03T11:00:00Z',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/144.0',
      },
    ],
  };
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    if (path === '/auth/me' && method === 'GET') {
      fixture.authReads += 1;
      return route.fulfill({ json: { user: fixture.signedIn ? user : null } });
    }
    if (path === '/admin/overview' && method === 'GET') {
      return route.fulfill({
        json: { users: 2, adventures: 3, pendingReview: 0, openReports: 0 },
      });
    }
    if (path === '/account/settings' && method === 'PATCH') {
      const payload = request.postDataJSON();
      fixture.settingsPatches.push(payload);
      Object.assign(user.settings, payload);
      return route.fulfill({ json: user });
    }
    if (path === '/account/profile' && method === 'PATCH') {
      const payload = request.postDataJSON();
      fixture.profilePatches.push(payload);
      Object.assign(user, payload);
      return route.fulfill({ json: user });
    }
    if (path === '/account/exports' && method === 'GET') {
      fixture.exportReads += 1;
      return route.fulfill({ json: fixture.exports });
    }
    if (path === '/account/export' && method === 'POST') {
      fixture.exportRequests.push(request.postDataJSON());
      fixture.exports.push({
        id: `synthetic-export-${fixture.exportRequests.length}`,
        status: 'requested',
        createdAt: '2026-11-03T12:00:00Z',
        completedAt: null,
        expiresAt: null,
      });
      return route.fulfill({ json: fixture.exports.at(-1) });
    }
    const download = path.match(/^\/account\/exports\/([^/]+)\/download$/);
    if (download && method === 'GET') {
      fixture.downloads.push(download[1]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Content-Disposition': 'attachment; filename="synthetic-account-export.json"',
        },
        body: JSON.stringify({ synthetic: true, accountId: user.id }),
      });
    }
    if (path === '/account/sessions' && method === 'GET') {
      fixture.sessionReads += 1;
      return route.fulfill({ json: fixture.sessions });
    }
    const session = path.match(/^\/account\/sessions\/([^/]+)$/);
    if (session && method === 'DELETE') {
      fixture.sessionDeletes.push({
        id: session[1],
        body: request.postDataJSON(),
      });
      if (fixture.sessions.some((item) => item.id === session[1] && item.current)) {
        fixture.signedIn = false;
      }
      fixture.sessions = fixture.sessions.filter((item) => item.id !== session[1]);
      return route.fulfill({ json: {} });
    }
    if (path === '/account/email-verification/request' && method === 'POST') {
      fixture.emailRequests.push(request.postDataJSON());
      return route.fulfill({
        status: fixture.emailResponse.status,
        json: { code: fixture.emailResponse.code },
      });
    }
    if (path === '/account/password' && method === 'POST') {
      fixture.passwordChanges.push(request.postDataJSON());
      fixture.sessions = fixture.sessions.filter((item) => item.current);
      return route.fulfill({ json: {} });
    }
    if (path === '/account' && method === 'DELETE') {
      fixture.accountDeletes.push(request.postDataJSON());
      fixture.signedIn = false;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  return fixture;
}

for (const locale of ['ru', 'uk', 'en'] as const) {
  test(`account and admin illustrations remain readable and reachable (${locale})`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const { user } = await mockAccount(page, locale);
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      for (const theme of ['dark', 'light']) {
        await page.goto('/account/profile');
        await expect(page.locator('.account-design')).toBeVisible();
        if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
          const saved = page.waitForResponse(
            (r) => r.url().endsWith('/account/settings') && r.request().method() === 'PATCH',
          );
          await withShellPreferences(page, () => page.locator('.theme-button').click());
          expect((await saved).ok()).toBeTruthy();
        }
        for (const route of [
          '/account/profile',
          '/account/settings',
          '/account/privacy',
          '/account/sessions',
          '/admin',
        ]) {
          await page.goto(route);
          await expect(page.locator('.account-design, .admin-design')).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await expect(page.locator('.tabs [aria-current="page"]')).toHaveCount(1);
          if (route === '/account/profile') {
            await expect(page.locator('.account-story-art')).toBeVisible();
            const avatar = page.locator('.profile-upload .avatar');
            await expect(avatar.locator('img')).toHaveCount(0);
            const avatarBox = await avatar.boundingBox();
            expect(avatarBox).not.toBeNull();
            if (width === 1536) {
              expect(avatarBox!.width).toBeCloseTo(180, 0);
              expect(avatarBox!.height).toBeCloseTo(180, 0);
            } else {
              expect(avatarBox!.width).toBeLessThanOrEqual(120);
              expect(avatarBox!.height).toBeLessThanOrEqual(120);
              expect(avatarBox!.width).toBeGreaterThanOrEqual(100);
            }
            const save = page.locator('.account-profile-panel .form-actions .button');
            const actionBox = await save.boundingBox();
            expect(actionBox!.height).toBeGreaterThanOrEqual(width === 1536 ? 56 : 52);
            if (width === 1536) {
              expect(actionBox!.width).toBeGreaterThanOrEqual(280);
            } else {
              const actionsBox = await page
                .locator('.account-profile-panel .form-actions')
                .boundingBox();
              expect(Math.abs(actionBox!.width - actionsBox!.width)).toBeLessThan(2);
            }
            const uploadBox = await page.locator('.profile-upload .upload-button').boundingBox();
            expect(uploadBox!.height).toBeGreaterThanOrEqual(52);
            await expect(page.locator('.profile-upload input[type="file"]')).toHaveAttribute(
              'accept',
              'image/png,image/jpeg,image/webp',
            );
          }
          if (route === '/account/settings') {
            const group = page.locator('.account-preference-toggles');
            const rows = group.locator('.toggle-row');
            await expect(rows).toHaveCount(7);
            await expect(group.getByRole('checkbox')).toHaveCount(7);
            await expect(group.getByRole('checkbox').first()).toHaveCSS('width', '64px');
            await expect(group.getByRole('checkbox').first()).toHaveCSS('height', '34px');
            await expect(group).toHaveCSS('row-gap', '0px');
            const boxes = await rows.evaluateAll((items) =>
              items.map((item) => {
                const box = item.getBoundingClientRect();
                return { y: box.y, bottom: box.bottom, height: box.height };
              }),
            );
            for (const [index, box] of boxes.entries()) {
              expect(box.height).toBeGreaterThanOrEqual(width === 1536 ? 64 : 68);
              if (index > 0) expect(Math.abs(box.y - boxes[index - 1].bottom)).toBeLessThan(2);
            }
            await expect(page.locator('.account-preferences-panel select')).toHaveCount(3);
            await expect(
              page.locator('.account-preferences-panel .form-actions button'),
            ).toBeEnabled();
          }
          if (route === '/account/privacy') {
            const art = page.locator('.account-privacy-art');
            await expect(art).toBeVisible();
            const imageBox = await art.boundingBox();
            const panelBox = await page.locator('.account-privacy-panel').boundingBox();
            expect(
              Math.abs(imageBox!.x + imageBox!.width - panelBox!.x - panelBox!.width),
            ).toBeLessThan(2);
            await expect(page.locator('.account-data-row > svg')).toHaveCount(1);
            await expect(page.locator('.account-export-summary h3')).toBeVisible();
            await expect(page.locator('.account-export-summary p')).toBeVisible();
            await expect(page.locator('.account-export-actions button')).toHaveCount(2);
            await expect(page.locator('.account-delete-row > svg')).toHaveCount(1);
            await expect(page.locator('.account-delete-row .account-data-copy h3')).toBeVisible();
            await expect(page.locator('.account-delete-row .account-data-copy p')).toBeVisible();
            await expect(page.locator('.account-delete-row button')).toBeEnabled();
          }
          if (route === '/account/sessions') {
            const current = page.locator('.session-row[data-current="true"]');
            const other = page.locator('.session-row[data-current="false"]');
            await expect(current).toContainText('Chrome · Linux');
            await expect(other).toContainText('Firefox · Windows');
            await expect(current.getByRole('button')).toBeEnabled();
            await expect(other.getByRole('button')).toBeEnabled();
            await expect(page.locator('.account-session-list .session-row')).toHaveCount(2);
            for (const id of ['account-current-password', 'account-new-password']) {
              await expect(page.locator(`#${id}`)).toHaveAttribute('type', 'password');
              await expect(page.locator(`button[aria-controls="${id}"]`)).toHaveAccessibleName(
                /\S/,
              );
              const inputBox = await page.locator(`#${id}`).boundingBox();
              expect(inputBox!.height).toBeGreaterThanOrEqual(52);
              await expect(page.locator(`button[aria-controls="${id}"]`)).toHaveAttribute(
                'type',
                'button',
              );
              await expect(page.locator(`button[aria-controls="${id}"]`)).toHaveAttribute(
                'aria-pressed',
                'false',
              );
            }
            const passwordAction = await page
              .locator('.account-password-panel form > button')
              .boundingBox();
            const passwordForm = await page.locator('.account-password-panel form').boundingBox();
            expect(passwordAction!.height).toBeGreaterThanOrEqual(width === 1536 ? 56 : 52);
            expect(Math.abs(passwordAction!.width - passwordForm!.width)).toBeLessThan(2);
            await expect(page.locator('.account-email-copy p').first()).toHaveCSS(
              'color',
              'rgb(255, 247, 237)',
            );
          }
          if (route === '/admin') {
            await expect(page.locator('.admin-overview-art img')).toHaveCount(2);
            await expect(page.locator('.admin-overview-art .button.primary')).toHaveCount(2);
          }
          for (const img of await page
            .locator('.account-story-art, .account-privacy-art, .admin-overview-art img')
            .all()) {
            await expect
              .poll(() =>
                img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
              )
              .toBe(true);
          }
          // All account locales are captured; keep the existing RU admin matrix.
          // JPEG keeps these 52 full-page evidence images small enough for CI artifacts.
          if (route !== '/admin' || locale === 'ru')
            await info.attach(`${locale}-${route.replaceAll('/', '-')}-${width}-${theme}`, {
              body: await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }),
              contentType: 'image/jpeg',
            });
        }
      }
    }
    user.emailVerificationRequired = true;
    await page.goto('/account/sessions');
    await expect(page.locator('.account-email-banner')).toBeVisible();
    await expect(page.locator('.account-email-copy')).toContainText(
      locale === 'ru' ? 'Подтверди почту' : locale === 'en' ? 'email' : 'пошту',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [1536, 390]) {
  test.describe(`account actions at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 1024 } });

    test('profile save retains validation and the existing profile payload', async ({ page }) => {
      const fixture = await mockAccount(page);
      await page.goto('/account/profile');
      const panel = page.locator('.account-profile-panel');
      const handle = panel.locator('input:not([type="file"])');
      const save = panel.locator('.form-actions button');
      await handle.fill('x');
      await save.click();
      expect(await handle.evaluate((node: HTMLInputElement) => node.validity.patternMismatch)).toBe(
        true,
      );
      expect(fixture.profilePatches).toHaveLength(0);
      await handle.fill('synthetic_reader');
      await panel.locator('textarea').fill('Synthetic account design regression fixture.');
      await save.focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => fixture.profilePatches)
        .toEqual([
          {
            handle: 'synthetic_reader',
            bio: 'Synthetic account design regression fixture.',
            avatarAssetId: null,
          },
        ]);
      await expect(save).toBeEnabled();
      await page.reload();
      await expect(handle).toHaveValue('synthetic_reader');
      await expect(panel.locator('textarea')).toHaveValue(
        'Synthetic account design regression fixture.',
      );
    });

    test('seven grouped preferences save and persist every setting', async ({ page }) => {
      const fixture = await mockAccount(page);
      const originalSettings = { ...fixture.user.settings };
      await page.goto('/account/settings');
      const panel = page.locator('.account-preferences-panel');
      const selects = panel.locator('select');
      await expect(selects).toHaveCount(3);
      await selects.nth(0).selectOption('light');
      await selects.nth(1).selectOption('uk');
      await panel.locator('input:not([type="checkbox"])').fill('Europe/Kyiv');
      await selects.nth(2).selectOption('long');
      const keys = [
        'reducedMotion',
        'notifications',
        'emailNotifications',
        'publicationNotifications',
        'reportNotifications',
        'costHints',
        'confirmExpensive',
      ] as const;
      const toggles = panel.locator('.account-preference-toggles input[type="checkbox"]');
      await expect(toggles).toHaveCount(keys.length);
      for (const [index, key] of keys.entries()) {
        await toggles.nth(index).setChecked(!originalSettings[key]);
      }
      await panel.locator('.form-actions button').click();
      const expected = {
        ...originalSettings,
        theme: 'light',
        language: 'uk',
        timezone: 'Europe/Kyiv',
        replyLength: 'long',
        ...Object.fromEntries(keys.map((key) => [key, !originalSettings[key]])),
      };
      await expect.poll(() => fixture.settingsPatches).toEqual([expected]);
      await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.reload();
      await expect(selects.nth(0)).toHaveValue('light');
      await expect(selects.nth(1)).toHaveValue('uk');
      await expect(selects.nth(2)).toHaveValue('long');
      await expect(panel.locator('input:not([type="checkbox"])')).toHaveValue('Europe/Kyiv');
      for (const [index, key] of keys.entries()) {
        await expect(toggles.nth(index)).toBeChecked({
          checked: !originalSettings[key],
        });
      }
      expect(fixture.settingsPatches).toHaveLength(1);
    });

    test('export request, refresh and download use the existing endpoints', async ({ page }) => {
      const fixture = await mockAccount(page);
      await page.goto('/account/privacy');
      const exports = page.locator('.account-exports');
      const actions = exports.locator('.account-export-actions button');
      await expect(actions).toHaveCount(2);
      await expect(exports.locator('a[download]')).toHaveCount(0);
      await expect.poll(() => fixture.exportReads).toBeGreaterThan(0);
      const reads = fixture.exportReads;
      await actions.nth(0).click();
      await expect.poll(() => fixture.exportRequests).toEqual([{}]);
      await expect.poll(() => fixture.exportReads).toBeGreaterThan(reads);
      await expect(exports.locator('li')).toHaveCount(1);
      await expect(exports.locator('a[download]')).toHaveCount(0);
      Object.assign(fixture.exports[0], {
        status: 'completed',
        completedAt: '2026-11-03T12:01:00Z',
        expiresAt: '2099-11-10T12:00:00Z',
      });
      fixture.exports.push({
        id: 'synthetic-expired-export',
        status: 'expired',
        createdAt: '2026-10-01T12:00:00Z',
        completedAt: '2026-10-01T12:01:00Z',
        expiresAt: '2026-10-08T12:00:00Z',
      });
      const beforeRefresh = fixture.exportReads;
      await actions.nth(1).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => fixture.exportReads).toBeGreaterThan(beforeRefresh);
      await expect(exports.locator('li')).toHaveCount(2);
      const downloadLink = exports.locator('a[download]');
      await expect(downloadLink).toHaveCount(1);
      await expect(downloadLink).toHaveAttribute(
        'href',
        '/api/v1/account/exports/synthetic-export-1/download',
      );
      await expect(exports.locator('li').nth(1).locator('a[download]')).toHaveCount(0);
      const downloaded = page.waitForEvent('download');
      await downloadLink.click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe('synthetic-account-export.json');
      expect(await download.failure()).toBeNull();
      expect(fixture.downloads).toEqual(['synthetic-export-1']);
      expect(fixture.exportRequests).toHaveLength(1);
      await expect(page).toHaveURL(/\/account\/privacy$/);
    });

    test('delete requires confirmation and survives cancel, Escape and history navigation', async ({
      page,
    }) => {
      const fixture = await mockAccount(page);
      await page.goto('/account/privacy');
      const open = page.locator('.account-delete-row button');
      const dialog = page.getByRole('dialog');
      const password = dialog.locator('input[type="password"]');
      const confirmation = dialog.locator('input:not([type="password"])');
      const remove = dialog.locator('.form-actions button.danger');
      await open.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(remove).toBeDisabled();
      await password.fill('synthetic-current-password');
      await confirmation.fill('delete');
      await expect(remove).toBeDisabled();
      await dialog.locator('.form-actions button.secondary').click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/account\/privacy$/);
      await open.click();
      await expect(dialog).toBeVisible();
      await confirmation.fill('DELETE');
      await expect(remove).toBeEnabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(fixture.accountDeletes).toHaveLength(0);
      await page.locator('.tabs a[href="/account/settings"]').click();
      await expect(page).toHaveURL(/\/account\/settings$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/account\/privacy$/);
      await expect(dialog).toHaveCount(0);
      await page.goForward();
      await expect(page).toHaveURL(/\/account\/settings$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/account\/privacy$/);
      await expect(dialog).toHaveCount(0);
      expect(fixture.accountDeletes).toHaveLength(0);
      await open.click();
      await confirmation.fill('DELETE');
      await password.fill('');
      await remove.click();
      expect(await password.evaluate((node: HTMLInputElement) => node.validity.valueMissing)).toBe(
        true,
      );
      expect(fixture.accountDeletes).toHaveLength(0);
      await password.fill('synthetic-current-password');
      await remove.click();
      await expect
        .poll(() => fixture.accountDeletes)
        .toEqual([{ password: 'synthetic-current-password', confirmation: 'DELETE' }]);
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/$/);
    });

    test('password visibility is independent and submission validates, resets and reloads sessions', async ({
      page,
    }) => {
      const fixture = await mockAccount(page);
      await page.goto('/account/sessions');
      const panel = page.locator('.account-password-panel');
      const current = panel.locator('#account-current-password');
      const next = panel.locator('#account-new-password');
      const showCurrent = panel.locator('button[aria-controls="account-current-password"]');
      const showNext = panel.locator('button[aria-controls="account-new-password"]');
      const save = panel.locator('button:not([aria-controls])');
      await expect(current).toHaveAttribute('autocomplete', 'current-password');
      await expect(next).toHaveAttribute('autocomplete', 'new-password');
      await expect(next).toHaveAttribute('minlength', '10');
      await expect(next).toHaveAttribute('maxlength', '128');
      await current.fill('synthetic-current-password');
      await next.fill('short');
      await showCurrent.focus();
      await page.keyboard.press('Space');
      await expect(current).toHaveAttribute('type', 'text');
      await expect(showCurrent).toHaveAttribute('aria-pressed', 'true');
      await expect(next).toHaveAttribute('type', 'password');
      await showNext.click();
      await expect(next).toHaveAttribute('type', 'text');
      await expect(showNext).toHaveAttribute('aria-pressed', 'true');
      await showCurrent.focus();
      await page.keyboard.press('Enter');
      await expect(current).toHaveAttribute('type', 'password');
      await expect(next).toHaveAttribute('type', 'text');
      await showNext.click();
      await expect(next).toHaveAttribute('type', 'password');
      expect(fixture.passwordChanges).toHaveLength(0);
      await save.click();
      expect(await next.evaluate((node: HTMLInputElement) => node.validity.tooShort)).toBe(true);
      expect(fixture.passwordChanges).toHaveLength(0);
      const reads = fixture.sessionReads;
      await next.fill('synthetic-new-password');
      await save.click();
      await expect
        .poll(() => fixture.passwordChanges)
        .toEqual([
          {
            currentPassword: 'synthetic-current-password',
            newPassword: 'synthetic-new-password',
          },
        ]);
      await expect(current).toHaveValue('');
      await expect(next).toHaveValue('');
      await expect.poll(() => fixture.sessionReads).toBeGreaterThan(reads);
      await expect(page.locator('.session-row[data-current="true"]')).toHaveCount(1);
      await expect(page.locator('.session-row[data-current="false"]')).toHaveCount(0);
      expect(fixture.sessionDeletes).toHaveLength(0);
    });

    test('email verification states and resend results stay readable inside the security banner', async ({
      page,
    }, info) => {
      const fixture = await mockAccount(page);
      fixture.user.emailVerified = true;
      fixture.user.emailVerificationRequired = true;
      await page.goto('/account/sessions');
      const banner = page.locator('.account-email-banner');
      const copy = banner.locator('.account-email-copy');
      const resend = copy.getByRole('button');
      async function assertBannerBounds() {
        const contained = await banner.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return [...node.querySelectorAll('h2, p, button, [role="alert"]')].every((child) => {
            const box = child.getBoundingClientRect();
            return (
              box.left >= bounds.left &&
              box.right <= bounds.right + 1 &&
              box.top >= bounds.top &&
              box.bottom <= bounds.bottom + 1 &&
              child.scrollWidth <= child.clientWidth + 1
            );
          });
        });
        expect(contained).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      async function capture(state: string) {
        await assertBannerBounds();
        await info.attach(`en-account-security-${state}-${width}-dark`, {
          body: await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }),
          contentType: 'image/jpeg',
        });
      }
      await expect(copy.locator('p').first()).toHaveText('Email verified');
      await expect(resend).toHaveCount(0);
      await capture('verified');

      fixture.user.emailVerified = false;
      await page.reload();
      await expect(copy.locator('p').first()).toHaveText('Email not yet verified');
      await expect(copy).toContainText(
        'Verify your email to start playing and receive your welcome gift.',
      );
      await expect(resend).toHaveAccessibleName(/\S/);
      await resend.focus();
      await page.keyboard.press('Enter');
      await expect(copy.getByRole('status')).toHaveText(
        'Email delivery has not been configured yet.',
      );
      await expect(resend).toBeEnabled();
      await expect(copy.getByRole('alert')).toHaveCount(0);
      await capture('required-unavailable');

      fixture.emailResponse = { status: 503, code: 'SYNTHETIC_EMAIL_FAILURE' };
      await resend.click();
      await expect(copy.getByRole('alert')).toBeVisible();
      await expect(copy.getByRole('alert')).toContainText(/\S/);
      await expect(copy.getByRole('status')).toHaveCount(0);
      await expect(resend).toBeEnabled();
      await capture('required-error');

      fixture.emailResponse = { status: 200, code: 'EMAIL_VERIFICATION_REQUESTED' };
      await resend.click();
      await expect(copy.getByRole('status')).toHaveText(
        'Check your inbox. If delivery is available, an email with a link will arrive shortly.',
      );
      await expect(copy.getByRole('alert')).toHaveCount(0);
      await expect(copy.locator('p').first()).toHaveText('Email not yet verified');
      await expect(resend).toBeEnabled();
      await capture('required-requested');
      expect(fixture.emailRequests).toEqual([{}, {}, {}]);
      expect(fixture.user.emailVerified).toBe(false);
    });

    test('other and current session actions retain revoke, reload and auth refresh behavior', async ({
      page,
    }) => {
      const fixture = await mockAccount(page);
      await page.goto('/account/sessions');
      const current = page.locator('.session-row[data-current="true"]');
      const other = page.locator('.session-row[data-current="false"]');
      await expect(current).toHaveCount(1);
      await expect(other).toHaveCount(1);
      const reads = { auth: fixture.authReads, sessions: fixture.sessionReads };
      await other.getByRole('button').click();
      await expect
        .poll(() => fixture.sessionDeletes)
        .toEqual([{ id: 'synthetic-other-session', body: {} }]);
      await expect.poll(() => fixture.sessionReads).toBeGreaterThan(reads.sessions);
      await expect.poll(() => fixture.authReads).toBeGreaterThan(reads.auth);
      await expect(other).toHaveCount(0);
      await expect(current).toHaveCount(1);
      const beforeCurrent = fixture.authReads;
      await current.getByRole('button').focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => fixture.sessionDeletes)
        .toEqual([
          { id: 'synthetic-other-session', body: {} },
          { id: 'synthetic-current-session', body: {} },
        ]);
      await expect.poll(() => fixture.authReads).toBeGreaterThan(beforeCurrent);
      await expect(page.locator('.account-session-panel')).toHaveCount(0);
      expect(fixture.signedIn).toBe(false);
    });
  });
}
