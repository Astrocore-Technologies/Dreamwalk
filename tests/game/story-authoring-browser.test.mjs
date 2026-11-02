import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client, until } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { chromium, expect } = require('@playwright/test');
const { createAuthoredDraft } = require('../../packages/game-core/dist');

test(
  'synthetic HTTP: scoped authoring to private release, library, hero and persisted campaign',
  { timeout: 90000, skip: process.env.STORY_AUTHORING_HTTP !== '1' },
  async () => {
    try {
      await startApi();
      const owner = await client().register(),
        stranger = await client().register();
      const template = await owner.request('/npcs', {
        name: 'HTTP template',
        appearance: 'Blue cloak',
      });
      const hero = await owner.request('/heroes', { name: 'HTTP hero', backstory: 'Fixture only' });
      const story = await owner.request('/studio/adventures', {
        title: 'HTTP private story',
        content: {
          locations: [
            { id: 'http-location', name: 'Fixture courtyard', description: 'Synthetic only' },
          ],
        },
      });
      const root = `/studio/adventures/${story.id}`;
      const create = {
        requestId: randomUUID(),
        expectedStoryRevision: story.editRevision,
        npc: { name: 'Local HTTP keeper' },
      };
      const first = await owner.request(`${root}/npcs`, create);
      assert.equal((await owner.request(`${root}/npcs`, create)).npc.id, first.npc.id);
      await stranger.request(`${root}/npcs`, undefined, 'GET', 404);
      await owner.request(`/npcs/${first.npc.id}`, undefined, 'GET', 404);
      const copied = await owner.request(`${root}/npcs/import`, {
        requestId: randomUUID(),
        expectedStoryRevision: first.storyEditRevision,
        templateId: template.id,
      });
      const edited = await owner.request(
        `${root}/npcs/${copied.npc.id}`,
        {
          requestId: randomUUID(),
          expectedStoryRevision: copied.storyEditRevision,
          expectedNpcRevision: copied.npc.editRevision,
          patch: { name: 'Story copy changed' },
        },
        'PATCH',
      );
      assert.equal((await owner.request(`/npcs/${template.id}`)).name, 'HTTP template');
      const exported = await owner.request(`${root}/npcs/${copied.npc.id}/template`, {
        requestId: randomUUID(),
        expectedStoryRevision: edited.storyEditRevision,
        expectedNpcRevision: edited.npc.editRevision,
      });
      assert.notEqual(exported.npc.id, copied.npc.id);
      assert.equal(exported.npc.storyId, null);
      const locals = await owner.request(`${root}/npcs`);
      assert.equal(locals.npcs.length, 2);
      const build = await owner.request(`/story-builds/adventures/${story.id}/prepare`, {
        operationId: randomUUID(),
      });
      assert.ok(build.id); // Prepare only: deliberately no quote or provider dispatch.
      const draft = createAuthoredDraft('courtyard');
      draft.maps = [{ ...draft.maps[0], exits: [], sourceLocationId: 'http-location' }];
      draft.objects = [];
      draft.npcs = locals.npcs.map((npc, index) => ({
        ...draft.npcs[0],
        id: `http-fixture-${index}`,
        sourceNpcId: npc.id,
        label: npc.name,
        x: 5 + index,
        y: 4,
      }));
      await owner.request(`${root}/playable-draft`, { expectedRevision: 0, draft }, 'PUT');
      const fresh = await owner.request(root);
      const publication = {
        operationId: randomUUID(),
        expectedEditRevision: fresh.editRevision,
        expectedGameRevision: 1,
        expectedArtRevision: 0,
      };
      const release = await owner.request(`${root}/private-release`, publication);
      assert.deepEqual(await owner.request(`${root}/private-release`, publication), release);
      const library = await owner.request('/library');
      assert.ok(
        library.privatePublished.some(
          (entry) => entry.id === story.id && entry.playableVersionId === release.playableVersionId,
        ),
      );
      await stranger.request(`/adventures/${story.slug}`, undefined, 'GET', 404);
      const campaign = await owner.request('/game/campaigns', {
        playableVersionId: release.playableVersionId,
        heroId: hero.id,
        turnBased: true,
      });
      assert.ok(campaign.campaignId);
      const savedHero = await owner.request(`/game/campaigns/${campaign.campaignId}/hero`);
      assert.equal(savedHero.hero.name, 'HTTP hero');
      const snap = await owner.request(`/game/campaigns/${campaign.campaignId}/snapshot`);
      assert.ok(snap.projection.map.id);
      await stopApi();
      await startApi();
      const restored = await owner.request(`/game/campaigns/${campaign.campaignId}/snapshot`);
      assert.equal(restored.projection.map.id, snap.projection.map.id);
      assert.equal(
        Number(
          (
            await db.query(
              'SELECT count(*) n FROM adventure_private_releases WHERE adventure_id=$1',
              [story.id],
            )
          ).rows[0].n,
        ),
        1,
      );
      console.log(
        'Verified real HTTP/session route wiring, idempotent scoped NPCs, immutable library template, fixture playable publication, private library, hero selection, campaign start and API-restart persistence. No AI dispatch.',
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);

test(
  'synthetic browser: inline NPC authoring, private release and playable launch',
  {
    timeout: 240000,
    skip: process.env.STORY_AUTHORING_HTTP === '1',
  },
  async () => {
    let web, browser, page;
    // Screenshots only: never persist synthetic login credentials, cookies or traces.
    const screenshotDir = process.env.STORY_AUTHORING_ARTIFACT_DIR
      ? resolve(process.env.STORY_AUTHORING_ARTIFACT_DIR)
      : process.env.CI
        ? resolve('test-results/story-authoring')
        : join(tmpdir(), `dreamwalk-story-authoring-${randomUUID()}`);
    await mkdir(screenshotDir, { recursive: true });
    const logs = [];
    try {
      await startApi();
      const owner = client();
      const fixtureEmail = `authoring-${randomUUID()}@example.test`,
        fixturePassword = `Synthetic-${randomUUID()}!`;
      owner.user = (
        await owner.request(
          '/auth/register',
          {
            email: fixtureEmail,
            handle: 'qa_' + randomUUID().replaceAll('-', '').slice(0, 12),
            name: 'Authoring QA',
            password: fixturePassword,
          },
          'POST',
          201,
        )
      ).user;
      await owner.request('/account/settings', { language: 'ru' }, 'PATCH');
      const template = await owner.request('/npcs', {
        name: 'Библиотечный хранитель',
        description: 'Неизменяемый исходный шаблон',
        appearance: 'Длинный синий плащ',
      });
      const hero = await owner.request('/heroes', {
        name: 'Проверочный герой',
        backstory: 'Только синтетическая проверка',
      });
      web = spawn(
        process.execPath,
        [
          'node_modules/next/dist/bin/next',
          'dev',
          'apps/web',
          '--hostname',
          '127.0.0.1',
          '--port',
          process.env.TEST_GAME_WEB_PORT,
        ],
        {
          env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      for (const stream of [web.stdout, web.stderr])
        stream.on('data', (bytes) => {
          logs.push(bytes.toString());
          if (logs.length > 40) logs.shift();
        });
      const base = process.env.WEB_ORIGIN;
      await until(
        async () => {
          if (web.exitCode !== null) throw Error('Synthetic web stopped');
          return fetch(base, { signal: AbortSignal.timeout(2500) })
            .then((r) => r.ok)
            .catch(() => false);
        },
        Boolean,
        90000,
      );
      // Use the Chromium revision installed by `playwright install chromium` in CI.
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        reducedMotion: 'reduce',
      });
      await context.addCookies(
        owner.cookie.split('; ').map((cookie) => {
          const at = cookie.indexOf('=');
          return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: base };
        }),
      );
      await context.addInitScript(() => localStorage.setItem('dreamwalk-language', 'ru'));
      page = await context.newPage();
      page.setDefaultTimeout(25000);
      await page.goto(base + '/studio/adventures/new');
      await page
        .getByLabel('Название приключения', { exact: true })
        .fill('Облачная проверка истории');
      await page
        .getByLabel('Синопсис', { exact: false })
        .fill('Синтетическая история для проверки приватной публикации.');
      await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
      await page.waitForURL(/\/studio\/adventures\/[0-9a-f-]{36}$/);
      const storyId = page.url().split('/').at(-1);
      await page.getByRole('button', { name: /Локации$/ }).click();
      await page.getByRole('button', { name: 'Добавить локацию', exact: true }).click();
      await page.getByLabel('Название локации', { exact: true }).fill('Проверочный двор');
      await page
        .getByLabel('Описание локации', { exact: true })
        .fill('Небольшой двор для синтетической проверки.');
      await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
      await page.getByRole('button', { name: /NPC$/ }).click();
      await page.getByRole('button', { name: 'Создать NPC здесь', exact: true }).click();
      await page.getByLabel('Имя NPC', { exact: true }).fill('Локальный хранитель');
      await page.getByLabel('Внешность', { exact: true }).fill('Рисованная фигура в зелёном плаще');
      await page.getByRole('button', { name: 'Сохранить персонажа', exact: true }).dblclick();
      await expect(
        page.getByText('Персонаж сохранён в этой истории.', { exact: true }),
      ).toBeVisible();
      let locals = await owner.request(`/studio/adventures/${storyId}/npcs`);
      assert.equal(locals.npcs.length, 1, 'double-click must not create two NPCs');
      const localId = locals.npcs[0].id;
      await expect(
        page.getByRole('heading', { name: 'Образ на карте', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Имя NPC', { exact: true }).fill('Не сохранять');
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const discard = page.getByRole('dialog', { name: 'Закрыть без сохранения?', exact: true });
      // Select the explicit destructive footer action, not the equally named modal X.
      await discard
        .getByRole('button', { name: 'Закрыть', exact: true })
        .filter({ hasText: /^\s*Закрыть\s*$/ })
        .click();
      await expect(discard).not.toBeVisible();
      await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
      await expect(page.getByLabel('Имя NPC', { exact: true })).toHaveValue('Локальный хранитель');
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page
        .getByLabel('Необязательный шаблон из библиотеки', { exact: true })
        .selectOption(template.id);
      await page.getByRole('button', { name: 'Добавить копию', exact: true }).click();
      await expect(page.getByLabel('Имя NPC', { exact: true })).toHaveValue(
        'Библиотечный хранитель',
      );
      await page.getByLabel('Имя NPC', { exact: true }).fill('Копия для этой истории');
      await page.getByRole('button', { name: 'Сохранить персонажа', exact: true }).click();
      await expect(
        page.getByText('Персонаж сохранён в этой истории.', { exact: true }),
      ).toBeVisible();
      assert.equal((await owner.request(`/npcs/${template.id}`)).name, 'Библиотечный хранитель');
      await page.screenshot({ path: `${screenshotDir}/inline-npc.png`, fullPage: true });
      await page.reload();
      await page.getByRole('button', { name: /NPC$/ }).click();
      locals = await owner.request(`/studio/adventures/${storyId}/npcs`);
      assert.equal(locals.npcs.length, 2);
      assert.ok(locals.npcs.some((n) => n.id === localId));
      await expect(page.getByText('Копия для этой истории', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /Локации$/ }).click();
      await page.getByRole('button', { name: 'Подготовить план', exact: true }).click();
      await expect(page.getByText('Исходные данные готовы', { exact: true })).toBeVisible();
      // No quote or provider dispatch. Install only a validated deterministic playable fixture
      // in this disposable database, preserving real author location/NPC source IDs.
      const story = await owner.request(`/studio/adventures/${storyId}`);
      const draft = createAuthoredDraft('courtyard');
      draft.maps = [
        { ...draft.maps[0], exits: [], sourceLocationId: story.content.locations[0].id },
      ];
      draft.objects = [];
      draft.npcs = locals.npcs.map((npc, index) => ({
        ...draft.npcs[0],
        id: `fixture-${index}`,
        sourceNpcId: npc.id,
        label: npc.name,
        x: 5 + index,
        y: 4,
      }));
      await owner.request(
        `/studio/adventures/${storyId}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      await page.getByRole('button', { name: /Публикация$/ }).click();
      await page
        .getByLabel('Опубликовать эту готовую версию приватно, без общего каталога', {
          exact: true,
        })
        .check();
      await page
        .getByRole('button', { name: 'Опубликовать в моей библиотеке', exact: true })
        .dblclick();
      await expect(
        page.getByRole('link', { name: 'Открыть историю и выбрать героя', exact: true }),
      ).toBeVisible();
      assert.equal(
        Number(
          (
            await db.query(
              'SELECT count(*) n FROM adventure_private_releases WHERE adventure_id=$1',
              [storyId],
            )
          ).rows[0].n,
        ),
        1,
      );
      await page.screenshot({ path: `${screenshotDir}/private-release.png`, fullPage: true });
      await page
        .getByRole('link', { name: 'Открыть историю и выбрать героя', exact: true })
        .click();
      const start = page.getByRole('button', { name: 'Начать прохождение', exact: true });
      await expect(start).toBeEnabled();
      await page.getByTestId('hero-selection').locator('select').selectOption(hero.id);
      await page.screenshot({ path: `${screenshotDir}/ready-to-play.png`, fullPage: true });
      await start.click();
      await page.waitForURL(/\/game\/[0-9a-f-]{36}/);
      await expect(page.locator('[data-camera-scale]')).toBeVisible();
      await page.screenshot({ path: `${screenshotDir}/playable-campaign.png`, fullPage: true });
      const library = await owner.request('/library');
      assert.ok(library.privatePublished.some((item) => item.id === storyId));
      console.log(
        `Synthetic browser journey passed; screenshots: ${screenshotDir}. No AI generation, payment or existing-story mutation.`,
      );
    } catch (error) {
      if (page)
        await page
          .screenshot({ path: `${screenshotDir}/failure.png`, fullPage: true })
          .catch(() => {});
      console.error(logs.slice(-6).join('\n'));
      throw error;
    } finally {
      await browser?.close();
      if (web && web.exitCode === null) {
        const exited = once(web, 'exit');
        const killTimer = setTimeout(() => web.kill('SIGKILL'), 5000);
        killTimer.unref();
        web.kill('SIGTERM');
        try {
          await exited;
        } finally {
          clearTimeout(killTimer);
        }
      }
      await stopApi();
      await db.end();
    }
  },
);
