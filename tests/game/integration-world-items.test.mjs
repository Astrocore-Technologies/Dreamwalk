import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  path,
  until,
  command,
} from './support-runtime.mjs';
import { bridgeFixture } from './world-items-fixtures.mjs';
let sourceNpcId, heroId;
const require = createRequire(import.meta.url),
  g = require('../../packages/game-core/dist'),
  { digest } = require('../../apps/api/dist/ai/context');
const { chromium } = require('@playwright/test');
const fence = (p) => ({
  roundId: p.turn.roundId,
  phaseEpoch: p.turn.phaseEpoch,
  rulesetVersion: 1,
});
const operation = (p, action, id = randomUUID()) => ({
  protocolVersion: 1,
  operationId: id,
  type: 'action',
  action,
  turnFence: fence(p),
});
async function saveFixture(id, s) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE game_campaigns SET state=$2,revision=$3 WHERE id=$1', [
      id,
      JSON.stringify(s),
      s.revision,
    ]);
    await c.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
      id,
      JSON.stringify(s),
      digest(s),
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
function draft() {
  const d = g.createAuthoredDraft('courtyard');
  // Item consumption stays in this room; unsolicited mock expansion is unrelated.
  d.narrativeConstraints = {
    ...d.narrativeConstraints,
    allowNewScenes: false,
    allowNewNpcs: false,
  };
  d.maps = [
    {
      ...d.maps[0],
      exits: [],
      blocked: [{ x: 4, y: 3 }],
      composition: {
        version: 1,
        provenance: 'original-drawn-fixture',
        layers: [{ id: 'table', visual: 'table', x: 4, y: 3, width: 1, height: 1, solid: true }],
      },
    },
  ];
  d.objects = [];
  d.npcs = [
    {
      id: 'host',
      label: 'Host',
      mapId: 'courtyard',
      x: 3,
      y: 3,
      visual: 'keeper',
      goal: 'help',
      itemStock: [
        { definitionId: 'food', quantity: 1 },
        { definitionId: 'cup', quantity: 1 },
      ],
    },
  ];
  d.npcBehavior = 'reactive-v1';
  d.turnRules = {};
  d.worldItemDefinitions = [
    {
      id: 'food',
      label: 'Dinner',
      description: 'Fresh dinner.',
      visual: 'food',
      portable: false,
      edible: true,
      restoreVitality: 1,
    },
    {
      id: 'cup',
      label: 'Blue cup',
      description: 'A ceramic cup.',
      visual: 'cup',
      portable: true,
      edible: false,
      restoreVitality: 0,
    },
  ];
  return d;
}
async function fixture(owner) {
  const story = await owner.request('/studio/adventures', { title: 'Item acceptance' });
  const saved = await owner.request(
    '/studio/adventures/' + story.id + '/playable-draft',
    {
      expectedRevision: 0,
      draft: {
        ...draft(),
        npcs: draft().npcs.map((n) => ({ ...n, ...(sourceNpcId ? { sourceNpcId } : {}) })),
      },
    },
    'PUT',
  );
  const version = await owner.request('/studio/adventures/' + story.id + '/playable-versions', {
    expectedRevision: saved.revision,
  });
  const { id, campaignId } = await owner.request('/game/campaigns', {
    playableVersionId: version.versionId,
    ...(heroId ? { heroId } : {}),
  });
  return campaignId ?? id;
}
async function withItems(owner, id) {
  const actor = (await snapshot(owner, id)).projection.actorId;
  await stopApi();
  let s = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
  Object.assign(s.entities[actor], { x: 4, y: 4, vitality: 3 });
  s = g.endPlayerTurn(s, actor, g.turnFence(s)).state;
  const result = g.materializeNpcItems(
    s,
    'host',
    actor,
    [
      { kind: 'place_stock', definitionId: 'food', surfaceId: 'table', x: 4, y: 3 },
      { kind: 'place_stock', definitionId: 'cup', surfaceId: 'table', x: 4, y: 3 },
    ],
    'fixture-' + id,
  );
  assert.equal(result.error, undefined);
  s = g.finishWorldPhase(result.state, g.turnFence(result.state)).state;
  await saveFixture(id, s);
  await startApi();
  return {
    actor,
    food: Object.values(s.entities).find((e) => e.item?.definitionId === 'food').id,
    cup: Object.values(s.entities).find((e) => e.item?.definitionId === 'cup').id,
  };
}
await test('world-item browser harness has matching disposable origin and API proxy', () => {
  const port = Number(process.env.TEST_GAME_WEB_PORT);
  assert.ok(
    Number.isInteger(port) && port > 0 && port <= 65535,
    'Runner must allocate TEST_GAME_WEB_PORT',
  );
  assert.equal(
    process.env.WEB_ORIGIN,
    `http://127.0.0.1:${port}`,
    'Browser origin must match its allocated listener',
  );
  assert.equal(
    process.env.API_URL,
    new URL(process.env.TEST_GAME_API_URL).origin,
    'Next proxy must target the disposable API',
  );
  assert.ok(
    !process.env.E2E_BROWSER_CHANNEL || process.env.E2E_BROWSER_CHANNEL === 'chrome',
    'Only the explicit chrome override is supported',
  );
});
await test(
  'world item commands are durable/idempotent and map context menu works without scrolling',
  { timeout: 240000 },
  async () => {
    let web, browser;
    try {
      await startApi();
      const owner = await client().register(),
        id = await fixture(owner),
        items = await withItems(owner, id);
      let p = (await snapshot(owner, id)).projection;
      const input = operation(p, { kind: 'consume', targetId: items.food });
      const results = await Promise.all([command(owner, id, input), command(owner, id, input)]);
      assert.deepEqual(results[0], results[1]);
      p = (await snapshot(owner, id)).projection;
      assert.ok(!p.entities.some((e) => e.id === items.food));
      const take = operation(p, { kind: 'pick_up', targetId: items.cup });
      await command(owner, id, take);
      await command(owner, id, take);
      await stopApi();
      await startApi();
      p = (await snapshot(owner, id)).projection;
      assert.deepEqual(
        p.inventory.map((e) => e.id),
        [items.cup],
      );
      assert.ok(!p.entities.some((e) => e.id === items.food));
      assert.equal(p.turn.resources.main, 1);
      assert.equal(p.turn.resources.additional, 1);
      const other = await client().register();
      await other.request(path(id, 'snapshot'), undefined, 'GET', 403);
      const textCampaign = await fixture(owner);
      const textItems = await withItems(owner, textCampaign);
      const textProjection = (await snapshot(owner, textCampaign)).projection;
      const textInput = {
        operationId: randomUUID(),
        text: '*съесть Dinner*',
        channel: 'say',
        replyLocale: 'ru',
        expectedCanonRevision: textProjection.narrative?.revision ?? 0,
        turnFence: fence(textProjection),
      };
      const textQuote = await owner.request(path(textCampaign, 'turns/quote'), textInput);
      assert.equal(textQuote.status, 'quoted', textQuote.code);
      const textSubmit = {
        ...textInput,
        turnId: textQuote.turnId,
        quoteId: textQuote.quote.id,
        consent: true,
        confirmedActionHash: textQuote.confirmationHash,
      };
      const textReceipt = await owner.request(path(textCampaign, 'turns'), textSubmit);
      assert.equal(textReceipt.status, 'committed');
      assert.deepEqual(await owner.request(path(textCampaign, 'turns'), textSubmit), textReceipt);
      assert.ok(
        (await snapshot(owner, textCampaign)).projection.entities.some(
          (entity) => entity.id === textItems.food,
        ),
      );
      await command(owner, textCampaign, {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'turn.end',
        turnFence: fence((await snapshot(owner, textCampaign)).projection),
      });
      await until(
        () => snapshot(owner, textCampaign),
        (result) => !result.projection.entities.some((entity) => entity.id === textItems.food),
      );
      const textAfter = (await snapshot(owner, textCampaign)).projection;
      assert.ok(!textAfter.entities.some((e) => e.id === textItems.food));
      assert.equal(textAfter.turn.resources.main, 1);
      const textState = (
        await db.query('SELECT state FROM game_campaigns WHERE id=$1', [textCampaign])
      ).rows[0].state;
      assert.ok(
        textState.npcBrains.host.living.observations.some((o) => o.kind === 'item_consumed'),
      );
      ({ npcId: sourceNpcId, heroId } = await bridgeFixture(db, owner));
      await owner.request('/account/settings', { language: 'en' }, 'PATCH');
      const browserId = await fixture(owner);
      await withItems(owner, browserId);
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
          windowsHide: true,
        },
      );
      const logs = [];
      for (const stream of [web.stdout, web.stderr])
        stream.on('data', (b) => {
          logs.push(b.toString());
          if (logs.length > 30) logs.shift();
        });
      const base = process.env.WEB_ORIGIN;
      let startupError;
      web.once('error', (error) => {
        startupError = error;
      });
      try {
        await until(
          async () => {
            if (startupError) throw startupError;
            if (web.exitCode !== null || web.signalCode !== null)
              throw Error(`Test web stopped (exit ${web.exitCode}, signal ${web.signalCode})`);
            return fetch(base, { signal: AbortSignal.timeout(2500) })
              .then((r) => r.ok)
              .catch(() => false);
          },
          Boolean,
          90000,
        );
      } catch (error) {
        // Bounded synthetic startup output makes invalid CLI/proxy/build failures
        // actionable without printing environment variables or session cookies.
        throw new Error(
          `Test web startup failed at ${base}: ${error.message}\n${logs.join('').slice(-12000)}`,
          { cause: error },
        );
      }
      browser = await chromium.launch({
        headless: true,
        ...(process.env.E2E_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}),
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: 'reduce',
        hasTouch: true,
      });
      await context.addCookies(
        owner.cookie.split('; ').map((c) => {
          const index = c.indexOf('=');
          return { name: c.slice(0, index), value: c.slice(index + 1), url: base };
        }),
      );
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
      await page.goto(base + '/game/' + browserId);
      const canvas = page.locator('[data-camera-scale]');
      await page.waitForFunction(
        () => !!document.querySelector('[data-camera-scale]')?.getAttribute('data-camera-scale'),
        null,
        { timeout: 60000 },
      );
      async function point(x, y) {
        const b = await canvas.boundingBox(),
          v = await canvas.evaluate((e) => ({
            x: Number(e.dataset.cameraX),
            y: Number(e.dataset.cameraY),
            s: Number(e.dataset.cameraScale),
          }));
        return { x: b.x + v.x + x * 48 * v.s, y: b.y + v.y + y * 48 * v.s };
      }
      const click = async (x, y) => {
        const p = await point(x, y);
        await page.mouse.click(p.x, p.y, { button: 'right' });
      };
      await click(3.5, 3.5);
      const npcMenu = page.getByRole('dialog', { name: 'Actions', exact: true });
      await npcMenu.getByText('Host', { exact: true }).waitFor();
      assert.equal(await npcMenu.getByRole('button', { name: 'Say', exact: true }).count(), 0);
      await npcMenu.getByRole('button', { name: 'Inspect', exact: true }).click();
      const inspection = page.getByTestId('npc-public-inspection');
      await inspection.getByRole('heading', { name: 'Host', exact: true }).waitFor();
      const closeInspection = inspection.getByRole('button', {
        name: 'Close inspection',
        exact: true,
      });
      await until(
        () => closeInspection.evaluate((el) => document.activeElement === el),
        Boolean,
        5000,
      );
      await inspection.getByTestId('npc-inspection-talk').click();
      const composer = page.getByTestId('unified-story');
      assert.ok(await composer.locator('textarea').evaluate((el) => document.activeElement === el));
      assert.equal(await composer.getByTestId('story-audience').innerText(), 'Speech nearby');
      assert.equal(
        await composer.getByRole('button', { name: 'Address the director', exact: true }).count(),
        0,
      );
      await closeInspection.click();
      await inspection.waitFor({ state: 'hidden' });
      await click(4.27, 2.77);
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: 'Eat', exact: true })
        .click();
      await page.waitForFunction(() => !document.querySelector('[data-map-target]'));
      await click(4.71, 2.77);
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: 'Take', exact: true })
        .click();
      await page.getByRole('button', { name: /Inventory/ }).click();
      const inventory = page.getByRole('dialog', { name: 'Inventory', exact: true });
      await inventory.getByText('Blue cup', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-inventory-id]').count(), 1);
      assert.equal(await page.getByRole('tab', { name: 'Out of character' }).count(), 0);
      assert.equal(await page.locator('[data-map-target]').count(), 0);
      await page.reload();
      await page.getByRole('button', { name: /Inventory/ }).click();
      await page
        .getByRole('dialog', { name: 'Inventory', exact: true })
        .getByText('Blue cup', { exact: true })
        .waitFor();
      const artifacts = process.env.DREAMWALK_ARTIFACT_DIR ?? '.local/test-artifacts';
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: join(artifacts, 'world-items-inventory-desktop.png'),
        fullPage: false,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(artifacts, 'world-items-inventory-mobile.png'),
        fullPage: false,
      });
      assert.ok(await inventory.isVisible());
      await inventory.getByRole('button', { name: 'Close', exact: true }).click();
      await canvas.scrollIntoViewIfNeeded();
      const npcPoint = await point(3.5, 3.5);
      await page.touchscreen.tap(npcPoint.x, npcPoint.y);
      // A touch tap on a character opens its compact art window; the actions menu
      // (items, exits and every character) stays available from the map tools.
      await page
        .getByTestId('actor-art-window')
        .getByRole('heading', { name: 'Host', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Close character art', exact: true }).click();
      await page.getByRole('button', { name: 'Actions', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByText('Host', { exact: true })
        .waitFor();
      await page.screenshot({
        path: join(artifacts, 'world-items-npc-touch-mobile.png'),
        fullPage: false,
      });
      await context.close();
      console.log(
        'Verified: disposable PostgreSQL commands/restart, duplicate consume/pickup, ACL, browser right-click Eat/Take, left overlay inventory, reload, desktop/mobile screenshots. Fixture art/NPC, no external calls.',
      );
    } finally {
      await browser?.close();
      if (web && web.exitCode === null) {
        const exit = once(web, 'exit');
        web.kill();
        await Promise.race([exit, delay(8000)]);
      }
      await stopApi();
      await db.end();
    }
  },
);
