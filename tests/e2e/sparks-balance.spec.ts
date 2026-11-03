import { test, expect } from '@playwright/test';

for (const locale of ['en', 'ru', 'uk']) {
  test(`actual Sparks balance refresh and account isolation in ${locale}`, async ({ page }) => {
    let owner = 'first';
    let amount = '500000';
    let unavailable = false;
    let reads = 0;
    let delayNext = false;
    let releaseOld: (() => void) | undefined;
    await page.clock.install();
    const user = () => ({
      id: owner,
      handle: owner,
      name: owner,
      role: 'user',
      onboarded: true,
      settings: { language: locale, theme: 'dark', reducedMotion: false },
    });
    await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user: user() } }));
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/v1/account/settings', (route) => route.fulfill({ json: user() }));
    await page.route('**/api/v1/sparks/wallet', async (route) => {
      reads++;
      const responseAmount = amount;
      const responseOwner = owner;
      if (delayNext) {
        delayNext = false;
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      }
      return route.fulfill({
        status: unavailable ? 503 : 200,
        json: unavailable
          ? { code: 'INTERNAL_ERROR' }
          : {
              ownerId: responseOwner,
              enabled: true,
              balanceSubunits: responseAmount,
              heldSubunits: '0',
              availableSubunits: responseAmount,
              subunitsPerSpark: '10000',
              ledger: [],
            },
      });
    });
    await page.goto('/auth/sign-up');
    const balance = page.getByTestId('sparks-balance');
    await expect(balance).toHaveText(locale === 'en' ? '50.00' : '50,00');
    await expect(balance).toHaveCSS('font-size', '16px');
    await expect(balance).toHaveCSS('font-weight', '700');
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(balance).toBeVisible();
      const box = await balance.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      const headerFits = await page
        .locator('.topbar')
        .evaluate((header) => header.scrollWidth <= header.clientWidth);
      expect(headerFits).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    amount = '487655';
    // Real app mutation helper emits a refresh after the theme PATCH succeeds.
    await page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-sun') })
      .click();
    await expect(balance).toHaveText(locale === 'en' ? '48.77' : '48,77');
    amount = '600000';
    // Provider completion can occur after the mutation response, without user interaction.
    await page.clock.fastForward(15200);
    await expect(balance).toHaveText(locale === 'en' ? '60.00' : '60,00');
    unavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(balance).toHaveText('—');
    await expect(balance).toHaveAttribute('aria-label', /unavailable|недоступ/);
    unavailable = false;
    delayNext = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => !!releaseOld).toBe(true);
    owner = 'second';
    amount = '0';
    await page.evaluate(
      (next) =>
        window.dispatchEvent(new CustomEvent('dreamwalk:account-updated', { detail: next })),
      user(),
    );
    await expect(balance).toHaveText(locale === 'en' ? '0.00' : '0,00');
    releaseOld?.();
    await page.waitForTimeout(200);
    await expect(balance).toHaveText(locale === 'en' ? '0.00' : '0,00');
    expect(reads).toBeGreaterThanOrEqual(6);
    await page.locator('.logout').click();
    await expect(balance).toHaveCount(0);
  });
}
