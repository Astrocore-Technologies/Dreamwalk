import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exposeDiscoveryFixtures } from './support/discovery-fixtures';

test('start preparation quotes once, cancellation is free, reload resumes operation and confirmation dispatches once', async ({
  page,
}) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const signup = await page.request.post('/api/v1/auth/register', {
    data: {
      handle: 'start_' + suffix,
      email: 'start_' + suffix + '@example.test',
      name: 'Start QA',
      password: 'Synthetic-' + randomUUID() + '!',
    },
  });
  expect(signup.ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
  await page.request.patch('/api/v1/account/settings', { data: { language: 'ru' } });
  const hero = await page.request.post('/api/v1/heroes', {
    data: { name: 'Starter', backstory: 'Synthetic fixture', notes: '', traits: [] },
  });
  expect(hero.ok()).toBeTruthy();
  const heroId = (await hero.json()).id;
  await exposeDiscoveryFixtures(page);
  const details = await page.request.get('/api/v1/adventures/old-observatory?view=published');
  expect(details.ok()).toBeTruthy();
  const version = (await details.json()).playableVersionId;
  const existing = await page.request.post('/api/v1/game/campaigns', {
    data: { playableVersionId: version, heroId, turnBased: true },
  });
  expect(existing.ok()).toBeTruthy();
  const campaignId = (await existing.json()).campaignId;
  const preparationId = randomUUID();
  let preparedOperation = '';
  let dispatches = 0,
    quotes = 0,
    ready = false,
    starts = 0;
  await page.route('**/api/v1/game/start-preparations**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const state = {
      id: preparationId,
      status: ready ? 'ready' : 'prepared',
      reused: false,
      campaignId: null,
      jobs: [],
    };
    if (path.endsWith('/quote')) {
      quotes++;
      return route.fulfill({
        json: {
          id: randomUUID(),
          estimatedTotalMicros: 1000,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          sparks: { reserveSubunits: '10000', walletCharging: true },
        },
      });
    }
    if (path.endsWith('/dispatch')) {
      expect(req.postDataJSON().consent).toBe(true);
      dispatches++;
      ready = true;
      await new Promise((r) => setTimeout(r, 200));
      return route.fulfill({ json: { ...state, status: 'ready' } });
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      expect(body.heroId).toBe(heroId);
      if (preparedOperation) expect(body.operationId).toBe(preparedOperation);
      preparedOperation = body.operationId;
    }
    return route.fulfill({ json: state });
  });
  await page.route('**/api/v1/game/campaigns', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    starts++;
    expect(route.request().postDataJSON().startPreparationId).toBe(preparationId);
    return route.fulfill({ json: { campaignId } });
  });
  const path = '/adventures/old-observatory?heroId=' + heroId;
  await page.goto(path);
  expect(dispatches).toBe(0);
  await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(quotes).toBe(1);
  expect(dispatches).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(dispatches).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Начать прохождение', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(quotes).toBe(2);
  expect(dispatches).toBe(0);
  await page
    .getByRole('button', { name: 'Подтвердить и начать', exact: true })
    .click({ clickCount: 2 });
  await expect(page).toHaveURL(new RegExp('/game/' + campaignId + '$'));
  expect(dispatches).toBe(1);
  expect(starts).toBe(1);
});
