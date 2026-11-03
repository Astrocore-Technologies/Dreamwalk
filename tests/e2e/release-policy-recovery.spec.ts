import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { settingsSchema } from '@dreamwalk/contracts';

// Synthetic admin protocol only: every API request is fulfilled or aborted.
for (const role of ['admin', 'user'] as const) {
  test(`release profile recovery requires explicit admin review: ${role}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = randomUUID(),
      hash = 'a'.repeat(64),
      candidate = 'b'.repeat(64);
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
    const profile = {
      mode: 'release',
      allowance: 'unlimited',
      totalCapMicros: null,
      textCapMicros: null,
      imageCapMicros: null,
      aggregateCapMicros: null,
      text: {
        model: 'synthetic-text',
        maxOutputTokens: 2048,
        storyPlanMaxOutputTokens: 8192,
        inputMicrosPerMillion: 500000,
        outputMicrosPerMillion: 1500000,
        upperMicros: 22000,
      },
      image: { model: 'synthetic-image', estimatedTotalMicros: 20000, reserveMicros: 30000 },
    };
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
      if (path === `/api/v1/generation/release-policy/${id}` && request.method() === 'GET') {
        reads++;
        return route.fulfill({
          json: {
            active: { revision: 1, hash, profile: null },
            proposed: { candidateFingerprint: candidate, profile, canApply: true, blockers: [] },
            pendingSparkHolds: [{ id: randomUUID(), status: 'pending', reservedSubunits: '7888' }],
          },
        });
      }
      if (
        path === `/api/v1/generation/release-policy/${id}/revisions` &&
        request.method() === 'POST'
      ) {
        const body = request.postDataJSON();
        expect(body).toMatchObject({
          expectedRevision: 1,
          expectedHash: hash,
          candidateFingerprint: candidate,
          consent: true,
        });
        adopted++;
        return route.fulfill({
          json: {
            status: 'applied',
            operationId: body.operationId,
            revision: 2,
            hash: candidate,
            candidateFingerprint: candidate,
            acknowledgedAt: new Date().toISOString(),
          },
        });
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
      await page.getByRole('button', { name: 'Generation settings', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByText(/The previous profile and platform spending limit were not saved/),
      ).toBeVisible();
      await expect(
        dialog.getByText(
          'Text: synthetic-text · Regular response tokens: 2048 · Story plan tokens: 8192',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(dialog.getByText(/New platform spending limit USD/)).toBeVisible();
      expect(adopted).toBe(0);
      await dialog.getByRole('button', { name: 'Approve new profile', exact: true }).click();
      await expect(
        dialog.getByText('Settings approved. A new cost estimate is now available.'),
      ).toBeVisible();
      expect(adopted).toBe(1);
    }
    await page.unrouteAll({ behavior: 'wait' });
  });
}
