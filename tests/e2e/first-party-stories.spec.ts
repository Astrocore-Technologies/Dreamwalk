import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** The bundled first-party adventures start without any paid preparation and show their goal. */
for (const [slug, characters] of [
  ['old-observatory', 1],
  ['whispering-forest', 2],
  ['tidekeepers', 2],
] as const) {
  test(`first-party story ${slug} starts free and opens with a goal`, async ({ page }) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(20000);
    const handle = `firstparty_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const registered = await page.request.post('/api/v1/auth/register', {
      data: {
        email: `${handle}@example.test`,
        handle,
        name: 'First party',
        password: `Safe-${randomUUID()}!`,
      },
    });
    expect(registered.status()).toBe(201);
    await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
    await page.goto(`/adventures/${slug}`);
    await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
    await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
    await expect(page.getByText('Подключено', { exact: true })).toBeVisible();
    if (process.env.FIRST_PARTY_SHOTS) {
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${process.env.FIRST_PARTY_SHOTS}/${slug}.png` });
    }
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const snapshot = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
    expect(snapshot.ok()).toBeTruthy();
    const projection = (await snapshot.json()).projection;
    expect(projection.objectives).toHaveLength(1);
    expect(projection.objectives[0].status).toBe('active');
    expect(
      projection.entities.filter((e: { kind: string }) => e.kind === 'npc').length,
    ).toBeGreaterThanOrEqual(characters);
  });
}
