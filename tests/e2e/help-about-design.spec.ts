import { test, expect } from '@playwright/test';

for (const locale of ['ru', 'uk', 'en']) {
  test(`Help and About illustrated composition: ${locale}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    // Guest-only isolated CI server. No accounts, external providers or production writes.
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const theme of ['dark', 'light']) {
        await page.goto('/help');
        await page.locator('.locale-select').selectOption(locale);
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await page.locator('.theme-button').click();
        for (const route of ['/help', '/about']) {
          await page.goto(route);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('#main-content h1')).toBeVisible();
          const root = page.locator(route === '/help' ? '.editorial-help' : '.editorial-about');
          await expect(root).toBeVisible();
          await root.locator('img').evaluateAll(async (images) => {
            await document.fonts.ready;
            await Promise.all(
              images.map(async (element) => {
                const image = element as HTMLImageElement;
                image.loading = 'eager';
                await image.decode();
                if (!image.naturalWidth) throw new Error(`Missing illustration: ${image.src}`);
              }),
            );
          });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
          if (route === '/help') {
            await expect(root.locator('.help-banner .page-heading')).toHaveCSS(
              'background-color',
              'rgba(0, 0, 0, 0)',
            );
            await expect(root.locator('.help-banner h1')).toHaveCSS('color', 'rgb(255, 249, 255)');
            await expect(root.locator('.help-emblem')).toHaveCount(4);
            const links = root.locator('.help-grid a');
            await expect(links).toHaveCount(4);
            expect(
              await links.evaluateAll((items) => items.map((item) => item.getAttribute('href'))),
            ).toEqual(['/explore', '/studio', '/wallet', '/content-policy']);
            for (const link of await links.all()) {
              await expect(link).toBeVisible();
              const box = (await link.boundingBox())!;
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(width);
              expect(box.height).toBeGreaterThanOrEqual(44);
            }
          } else {
            await expect(root.locator('.about-feature h2')).toHaveCount(2);
            await expect(root.locator('.about-divider')).toBeVisible();
            await expect(root.locator('.about-draft-note')).not.toBeEmpty();
            await expect(root.locator('.about-operator strong')).toBeVisible();
            if (width === 1536) {
              const feature = root.locator('.about-feature').first();
              const art = (await feature.locator('img').boundingBox())!;
              const text = (await feature.locator('h2').boundingBox())!;
              expect(art.x + art.width).toBeLessThan(text.x);
            }
          }
          await page.screenshot({
            path: info.outputPath(`help-about-${route.slice(1)}-${width}-${theme}-${locale}.png`),
            fullPage: true,
          });
        }
      }
    }
    await page.goto('/support');
    await expect(page.locator('.editorial-help h1')).toBeVisible();
    await page.locator('.help-grid a[href="/content-policy"]').click();
    await expect(page).toHaveURL(/\/content-policy/);
    await expect(page.locator('.static-prose')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.editorial-help')).toBeVisible();
  });
}
