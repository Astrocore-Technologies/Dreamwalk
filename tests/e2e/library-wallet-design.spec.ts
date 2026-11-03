import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const locale of ['ru', 'uk', 'en']) {
  test(`Library and two-currency wallet composition, ${locale}`, async ({ page }, info) => {
    test.setTimeout(150_000);
    const writes: string[] = [];
    let unavailable = false;
    let invitationStatus = 'pending';
    const stamp = '2026-11-03T12:00:00Z';
    const user = {
      id: 'synthetic-reader',
      handle: 'synthetic',
      name: 'Synthetic reader',
      role: 'user',
      onboarded: true,
      settings: { language: locale, theme: 'dark', reducedMotion: true },
    };
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/assets/synthetic-cover/file'))
        return route.fulfill({
          contentType: 'image/webp',
          body: readFileSync('apps/web/public/images/observatory.webp'),
        });
      if (route.request().method() !== 'GET') writes.push(path);
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
      if (path.endsWith('/library'))
        return route.fulfill({
          json: {
            favorites: [],
            drafts: [
              {
                id: 'synthetic-story',
                title: 'Synthetic story with a deliberately long title',
                synopsis: '',
                coverAssetId: 'synthetic-cover',
                status: 'draft',
                visibility: 'private',
                updatedAt: stamp,
              },
              {
                id: 'synthetic-no-cover',
                title: 'Synthetic draft without cover',
                synopsis: '',
                coverAssetId: null,
                status: 'draft',
                visibility: 'private',
                updatedAt: stamp,
              },
            ],
            privatePublished: [],
            heroes: [],
            shared: [],
          },
        });
      if (path.endsWith('/respond')) {
        invitationStatus = 'accepted';
        return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith('/invitations'))
        return route.fulfill({
          json: [
            {
              id: 'synthetic-invite',
              adventureId: 'private-world',
              adventureSlug: 'private-world',
              adventureTitle: 'Synthetic private invitation',
              owner: { id: 'author', name: 'Synthetic author', handle: 'author' },
              recipient: user,
              status: invitationStatus,
              createdAt: stamp,
              updatedAt: stamp,
            },
          ],
        });
      if (path.endsWith('/sparks/wallet'))
        return route.fulfill({
          status: unavailable ? 503 : 200,
          json: unavailable
            ? { code: 'INTERNAL_ERROR' }
            : {
                ownerId: user.id,
                enabled: true,
                balanceSubunits: '250000',
                heldSubunits: '12500',
                availableSubunits: '237500',
                subunitsPerSpark: '10000',
                ledger: [
                  { id: '1', kind: 'pending', amountSubunits: '12500', createdAt: stamp },
                  { id: '2', kind: 'capture', amountSubunits: '216', createdAt: stamp },
                ],
              },
        });
      if (path.endsWith('/currencies/wallet'))
        return route.fulfill({
          status: unavailable ? 503 : 200,
          json: {
            dreams: {
              ownerId: user.id,
              currency: 'dreams',
              balanceSubunits: '100000',
              heldSubunits: '10000',
              availableSubunits: '90000',
              subunitsPerDream: '10000',
              spendingAvailable: false,
              ledger: [],
            },
          },
        });
      return route.fulfill({ json: [] });
    });
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const theme of ['dark', 'light']) {
        for (const route of ['/library', '/library?tab=invitations', '/wallet']) {
          await page.goto(route);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await page
            .locator('html')
            .evaluate((html, value) => html.setAttribute('data-theme', value), theme);
          if (route.startsWith('/library')) {
            const tabs = page.locator('button[aria-pressed]');
            await expect(tabs).toHaveCount(6);
            for (const tab of await tabs.all()) {
              expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            }
            if (route.includes('invitations')) {
              await expect(page.getByText('Synthetic private invitation')).toBeVisible();
              await expect(page.locator('.invitation-list img')).toHaveCount(0);
            } else {
              await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true');
              await tabs.nth(4).focus();
              await page.keyboard.press('Enter');
              await expect(
                page.locator('a[href="/studio/adventures/synthetic-story"]'),
              ).toBeVisible();
              await expect(
                page.locator('a[href="/studio/adventures/synthetic-story"] img'),
              ).toHaveAttribute('src', '/api/v1/assets/synthetic-cover/file');
              await expect(
                page.locator('a[href="/studio/adventures/synthetic-no-cover"] img'),
              ).toHaveCount(0);
              await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all([...document.images].map((image) => image.decode()));
              });
              await page.screenshot({
                path: info.outputPath(`drafts-${width}-${theme}-${locale}.png`),
                fullPage: true,
              });
              await tabs.first().click();
            }
          } else {
            const dreams = page.getByTestId('wallet-dreams-balance');
            const sparks = page.getByTestId('wallet-sparks-balance');
            await expect(dreams).toHaveText(locale === 'en' ? '9.00' : '9,00');
            await expect(sparks).toHaveText(locale === 'en' ? '23.75✦' : '23,75✦');
            expect((await sparks.boundingBox())!.y).toBeLessThan(850);
            expect((await dreams.boundingBox())!.y).toBeLessThan(850);
            await expect(page.locator('tbody tr')).toHaveCount(2);
            await expect(page.locator('tbody')).toContainText(
              locale === 'en' ? '0.0216' : '0,0216',
            );
            await expect(page.locator('tbody')).toContainText(
              locale === 'en'
                ? 'Pending reconciliation'
                : locale === 'ru'
                  ? 'На сверке'
                  : 'На звірці',
            );
          }
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode()));
            const banner = new Image();
            banner.src = '/images/wallet-starlight.webp';
            await banner.decode();
          });
          await page.screenshot({
            path: info.outputPath(
              `${route.includes('invitations') ? 'invitations' : route.slice(1)}-${width}-${theme}-${locale}.png`,
            ),
            fullPage: true,
          });
        }
      }
    }
    expect(writes).toEqual([]);
    await page.goto('/library?tab=invitations');
    await page.locator('.invitation-list .button.primary').click();
    await expect(page.locator('button[aria-pressed]').nth(1)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(writes).toEqual(['/api/v1/invitations/synthetic-invite/respond']);
    await page.locator('button[aria-pressed]').nth(2).click();
    await expect(page.locator('a[href="/adventures/private-world"]')).toBeVisible();
    await page.goto('/wallet');
    unavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('wallet-sparks-balance')).toHaveText('—✦');
    await expect(page.getByTestId('wallet-dreams-balance')).toHaveText('—');
    await expect(page.locator('tbody tr')).toHaveCount(0);
  });
}
