import { exposeDiscoveryFixtures } from './support/discovery-fixtures';
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
      await exposeDiscoveryFixtures(page);
      await page.goto(
        (entry === 'home' ? '/home' : '/adventures/old-observatory') + '?heroId=' + hero,
      );
      const created = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().endsWith('/api/v1/game/campaigns'),
      );
      if (entry === 'home') {
        const featured = page.getByTestId('home-featured');
        await expect(featured).toHaveAttribute('data-featured-slug', /.+/);
        for (
          let i = 0;
          i < 30 && (await featured.getAttribute('data-featured-slug')) !== 'old-observatory';
          i++
        )
          await page.getByTestId('home-next').click();
        await expect(featured).toHaveAttribute('data-featured-slug', 'old-observatory');
        await page.getByTestId('home-start-adventure').click();
        await expect(page).toHaveURL(/\/adventures\/old-observatory/);
      }
      await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
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
