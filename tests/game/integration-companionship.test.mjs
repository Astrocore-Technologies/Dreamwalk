import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { db, client, startApi, stopApi, snapshot, command, until } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const g = require('../../packages/game-core/dist');
const { digest } = require('../../apps/api/dist/ai/context');
const fence = (p) => ({
  roundId: p.turn.roundId,
  phaseEpoch: p.turn.phaseEpoch,
  rulesetVersion: 1,
});

await test(
  'confirmed companionship survives PostgreSQL/API restart and end-turn executes bounded collision-safe NPC movement',
  { timeout: 240000 },
  async () => {
    let web, browser;
    try {
      await startApi();
      const owner = await client().register();
      const adventure = await owner.request('/studio/adventures', {
        title: 'Companion regression',
      });
      const draft = g.createCompleteObservatoryDraft();
      draft.turnRules = g.turnRulesSchema.parse({});
      const saved = await owner.request(
        `/studio/adventures/${adventure.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const version = await owner.request(`/studio/adventures/${adventure.id}/playable-versions`, {
        expectedRevision: saved.revision,
      });
      const campaign = await owner.request('/game/campaigns', {
        playableVersionId: version.versionId,
      });
      const id = campaign.campaignId ?? campaign.id;
      const actor = (await snapshot(owner, id)).projection.actorId;
      await stopApi();
      let s = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
      Object.assign(s.entities[actor], { x: 5, y: 4 });
      const input = {
        operationId: randomUUID(),
        text: 'Пойдешь со мной?',
        channel: 'say',
        targetNpcId: 'keeper',
        expectedCanonRevision: 0,
      };
      const turnId = randomUUID(),
        context = g.buildStoryTurnContext(s, actor, input, turnId);
      const proposal = g.createMockStoryTurnProposal(s, actor, input, turnId);
      proposal.steps[0].reply = {
        text: 'Да, пойдем вместе.',
        companionIntent: {
          kind: 'follow',
          actorId: actor,
          sourceObservationId: context.dialogues[0].replyToObservationId,
        },
      };
      const admitted = g.applyStoryTurnProposal(s, actor, input, turnId, proposal);
      assert.equal(admitted.error, undefined);
      s = admitted.state;
      const transaction = await db.connect();
      try {
        await transaction.query('BEGIN');
        await transaction.query('UPDATE game_campaigns SET state=$2,revision=$3 WHERE id=$1', [
          id,
          JSON.stringify(s),
          s.revision,
        ]);
        await transaction.query(
          'UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1',
          [id, JSON.stringify(s), digest(s)],
        );
        await transaction.query('COMMIT');
      } catch (error) {
        await transaction.query('ROLLBACK');
        throw error;
      } finally {
        transaction.release();
      }
      await startApi();
      let p = (await snapshot(owner, id)).projection;
      const npc = p.entities.find((e) => e.id === 'keeper');
      await command(owner, id, {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'action',
        action: { kind: 'move_to', target: { x: 3, y: 6 } },
        turnFence: fence(p),
      });
      p = (await snapshot(owner, id)).projection;
      assert.equal(
        p.entities.find((e) => e.id === 'keeper').x,
        npc.x,
        'NPC waits while player reads',
      );
      const end = {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'turn.end',
        turnFence: fence(p),
      };
      if (process.env.COMPANION_BROWSER === '1') {
        const { chromium } = require('@playwright/test');
        await owner.request('/account/settings', { language: 'en' }, 'PATCH');
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
            stdio: 'ignore',
            windowsHide: true,
          },
        );
        const base = process.env.WEB_ORIGIN;
        await until(
          () =>
            fetch(base, { signal: AbortSignal.timeout(3000) })
              .then((r) => r.ok)
              .catch(() => false),
          Boolean,
          90000,
        );
        browser = await chromium.launch({
          headless: true,
          ...(process.env.E2E_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}),
        });
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          reducedMotion: 'reduce',
        });
        await context.addCookies(
          owner.cookie.split('; ').map((cookie) => {
            const index = cookie.indexOf('=');
            return { name: cookie.slice(0, index), value: cookie.slice(index + 1), url: base };
          }),
        );
        const page = await context.newPage();
        await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
        await page.goto(base + '/game/' + id);
        await page.locator('[data-camera-scale]').waitFor({ timeout: 60000 });
        const endButton = page.getByRole('button', { name: 'End turn', exact: true });
        await endButton.waitFor();
        await endButton.click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-turn-phase]')?.getAttribute('data-turn-phase') ===
            'player',
        );
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('[data-camera-scale]').count(), 1);
        await context.close();
      } else {
        await command(owner, id, end);
        await command(owner, id, end);
      }
      const next = await until(
        () => snapshot(owner, id),
        (r) => r.projection.turn.roundNumber >= 2 && r.projection.turn.phase === 'player',
        15000,
      );
      p = next.projection;
      const followed = p.entities.find((e) => e.id === 'keeper'),
        player = p.entities.find((e) => e.id === actor);
      assert.ok(g.footprintDistance(followed, player) <= 1);
      assert.equal(g.footprintOverlaps(followed, player), false);
      assert.equal(JSON.stringify(p).includes('sourceObservationId'), false);
      const considerations = (
        await db.query(
          "SELECT npc_id,context FROM game_npc_decision_requests WHERE campaign_id=$1 AND purpose='plan'",
          [id],
        )
      ).rows;
      assert.equal(considerations.length, 1, 'The active-map NPC is considered once per round');
      assert.equal(considerations[0].npc_id, 'keeper');
      assert.equal(considerations[0].context.worldRoundDecision.roundId, end.turnFence.roundId);
      const jobs = (
        await db.query(
          'SELECT credits,provider_upper_micros,spark_hold_id FROM npc_ai_jobs WHERE campaign_id=$1',
          [id],
        )
      ).rows;
      assert.ok(
        jobs.every(
          (job) =>
            job.credits === 0 &&
            BigInt(job.provider_upper_micros) === 0n &&
            job.spark_hold_id === null,
        ),
        'Local companionship consideration must not create paid provider or wallet reservations',
      );
      await stopApi();
      await startApi();
      p = (await snapshot(owner, id)).projection;
      assert.deepEqual(
        p.entities.find((e) => e.id === 'keeper'),
        followed,
      );
      const restored = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
        .rows[0].state;
      assert.equal(restored.npcBrains.keeper.living.companionship.actorId, actor);
    } finally {
      await browser?.close();
      if (web && web.exitCode === null) {
        const exited = once(web, 'exit');
        web.kill();
        await exited;
      }
      await stopApi();
      await db.end();
    }
  },
);
