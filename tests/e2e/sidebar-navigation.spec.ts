import { test, expect } from '@playwright/test';

test('desktop and mobile sidebar keep studio/settings without duplicate creation or early-access footer', async ({
  page,
}) => {
  await page.goto('/auth/sign-up');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.locator('.mobile-menu').click();
    const sidebar = page.locator('#main-sidebar');
    await expect(sidebar.locator('a[href="/studio"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/account/settings"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/help"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/studio/adventures/new"]')).toHaveCount(0);
    await expect(sidebar.locator('.sidebar-footer')).toHaveCount(0);
  }
});
