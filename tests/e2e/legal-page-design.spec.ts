import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  closedTestDraftLabel,
  closedTestLegalCopy,
} from '../../apps/web/components/closed-test-legal-copy';

test('Reviewed legal copy remains byte-for-byte unchanged', () => {
  const source = readFileSync('apps/web/components/closed-test-legal-copy.ts');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    'bd0eed2e38d3b4795c1b6a5a7b642ad437844f9adfe4f13315632697b6457435',
  );
});

for (const locale of ['ru', 'uk', 'en'] as const) {
  test(`Legal draft presentation preserves every paragraph: ${locale}`, async ({ page }, info) => {
    test.setTimeout(150_000);
    // Synthetic guest browser only; no consent, accounts, provider calls or writes.
    for (const width of [1536, 390]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const theme of ['dark', 'light']) {
        await page.goto('/terms');
        const preferencesInDrawer = !(await page.locator('.locale-select').isVisible());
        if (preferencesInDrawer) await page.locator('.mobile-menu').click();
        await page.locator('.locale-select').selectOption(locale);
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await page.locator('.theme-button').click();
        if (preferencesInDrawer) await page.keyboard.press('Escape');
        for (const route of ['/terms', '/privacy'] as const) {
          await page.goto(route);
          const root = page.locator('[data-legal-page]');
          const copy = closedTestLegalCopy[locale][route];
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(root.locator('h1')).toHaveText(copy.title);
          await expect(root.locator('header > p')).toHaveText(closedTestDraftLabel[locale]);
          const paragraphs = root.locator('[data-legal-paragraph]');
          await expect(paragraphs).toHaveCount(copy.paragraphs.length);
          for (const [index, paragraph] of copy.paragraphs.entries())
            await expect(paragraphs.nth(index)).toHaveText(paragraph.replaceAll('**', ''));
          await expect(root.locator('form, input, button')).toHaveCount(0);
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
          const summary = root.locator('summary');
          await summary.focus();
          await expect(summary).toBeFocused();
          await expect(summary).toHaveCSS('outline-style', 'solid');
          await page.keyboard.press('Enter');
          const links = root.locator('nav a');
          await expect(links).toHaveCount(copy.paragraphs.length - 1);
          const lastId = `legal-section-${copy.paragraphs.length - 1}`;
          await links.last().click();
          await expect(page).toHaveURL(new RegExp(`#${lastId}$`));
          await expect(root.locator(`#${lastId}`)).toBeFocused();
          await page.goBack();
          await expect(page).toHaveURL(new RegExp(`${route}$`));
          await page.goForward();
          await expect(page).toHaveURL(new RegExp(`#${lastId}$`));
          await root.locator('footer a[href="#legal-top"]').click();
          await expect(root.locator('h1')).toBeFocused();
          await summary.click();
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
          await page.screenshot({
            path: info.outputPath(`legal-${route.slice(1)}-${locale}-${theme}-${width}.png`),
            fullPage: true,
          });
        }
      }
    }
    await page.goto('/content-policy');
    await expect(page.locator('[data-legal-page]')).toHaveAttribute('data-legal-page', '/terms');
    await page.locator('[data-legal-page] footer a[href="/privacy"]').click();
    await expect(page.locator('[data-legal-page]')).toHaveAttribute('data-legal-page', '/privacy');
    await page.goBack();
    await expect(page).toHaveURL(/\/content-policy$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/privacy$/);
  });
}
