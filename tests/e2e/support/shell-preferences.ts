import { expect, type Page } from '@playwright/test';

/** Use the actual preferences control, including its mobile navigation drawer. */
export async function withShellPreferences(page: Page, change: () => Promise<void>) {
  const wasHidden = !(await page.locator('.locale-select').isVisible());
  if (wasHidden) {
    await page.locator('.mobile-menu').click();
    await expect(page.locator('.locale-select')).toBeVisible();
  }
  await change();
  if (wasHidden) {
    await page.locator('.mobile-close').click();
    await expect(page.locator('.mobile-menu')).toHaveAttribute('aria-expanded', 'false');
  }
}
