import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { GameProjection } from '@dreamwalk/contracts';
for (const entry of ['home', 'detail'] as const) {
  test(
    'authored ' + entry + ' launch requests turn mode and shows the player barrier',
    async ({ page }) => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const register = await page.request.post('/api/v1/auth/register', {
        data: {
          handle: 'launch_' + suffix,
          email: 'launch-' + suffix + '@example.test',
          name: 'Turn launch QA',
          password: 'Synthetic-' + randomUUID() + '!',
        },
      });
      expect(register.ok()).toBeTruthy();
      await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
      const settings = await page.request.patch('/api/v1/account/settings', {
        data: { language: 'ru' },
      });
      expect(settings.ok()).toBeTruthy();
      const heroResponse = await page.request.post('/api/v1/heroes', {
        data: {
          name: 'Turn launch hero',
          backstory: 'Synthetic browser fixture',
          notes: '',
          traits: [],
        },
      });
      expect(heroResponse.ok()).toBeTruthy();
      const hero = (await heroResponse.json()).id;
      await page.goto(
        (entry === 'home' ? '/home' : '/adventures/old-observatory') + '?heroId=' + hero,
      );
      const created = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().endsWith('/api/v1/game/campaigns'),
      );
      if (entry === 'home') await page.getByTestId('home-start-adventure').click();
      else await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
      expect((await created).postDataJSON()).toMatchObject({ turnBased: true, heroId: hero });
      await expect(page).toHaveURL(/\/game\/[a-f0-9-]+$/);
      await expect(page.locator('[data-turn-phase=player]')).toBeVisible();
      const id = new URL(page.url()).pathname.split('/').at(-1)!;
      const read = async (): Promise<GameProjection> => {
        const response = await page.request.get('/api/v1/game/campaigns/' + id + '/snapshot');
        expect(response.ok()).toBeTruthy();
        return (await response.json()).projection;
      };
      const first = await read();
      expect(first.turn?.ownTurn).toBe(true);
      expect(first.turn!.resources.movement).toBeGreaterThan(0);
      const npcs = (projection: GameProjection) =>
        projection.entities
          .filter((entity) => entity.kind === 'npc')
          .map((entity) => [entity.id, entity.x, entity.y]);
      await page.waitForTimeout(350);
      expect(npcs(await read())).toEqual(npcs(first));
      await page.screenshot({ path: test.info().outputPath('authored-turn-' + entry + '.png') });
    },
  );
}
