import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { settingsSchema } from '@dreamwalk/contracts';

// Synthetic admin protocol only: every API request is fulfilled or aborted.
for (const role of ['admin', 'user'] as const) {
  test(`release profile updates need no manual account review: ${role}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = randomUUID();
    const user = {
      id,
      email: 'fixture@example.test',
      name: 'Policy fixture',
      handle: 'policy_fixture',
      bio: '',
      avatarAssetId: null,
      role,
      onboarded: true,
      emailVerified: true,
      settings: settingsSchema.parse({ language: 'en' }),
      createdAt: new Date().toISOString(),
    };
    let adopted = 0,
      reads = 0;
    await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === '/api/v1/auth/me') return route.fulfill({ json: { user } });
      if (path === '/api/v1/taxonomy')
        return route.fulfill({ json: { genres: [], tags: [], genreDefinitions: [], revision: 0 } });
      if (path === '/api/v1/sparks/wallet')
        return route.fulfill({
          json: {
            enabled: true,
            balanceSubunits: '100000',
            heldSubunits: '7888',
            availableSubunits: '92112',
          },
        });
      if (path === '/api/v1/admin/users') return route.fulfill({ json: [user] });
      if (path.includes('/generation/release-policy/')) {
        if (request.method() === 'GET') reads++;
        else adopted++;
      }
      return route.abort('blockedbyclient');
    });
    await page.goto('/admin/users');
    if (role === 'user') {
      await expect(
        page.getByRole('heading', { name: 'This section is for the team' }),
      ).toBeVisible();
      expect(reads).toBe(0);
      expect(adopted).toBe(0);
    } else {
      await expect(
        page.getByRole('table').getByText('Policy fixture', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Generation settings', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(reads).toBe(0);
      expect(adopted).toBe(0);
    }
    await page.unrouteAll({ behavior: 'wait' });
  });
}
