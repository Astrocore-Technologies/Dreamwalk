/** Real isolated PostgreSQL WAL/session-lock acceptance, zero external transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  createPgStoryGuard,
  readPgStoryLedger,
  LEDGER_ID,
} from '../scripts/live-story/pg-guard.mjs';
import { LIMITS } from '../scripts/live-story/guard.mjs';
const url = process.env.TEST_LIVE_GUARD_DB_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
const pool = new pg.Pool({ connectionString: url });
const request = (id) => ({
  method: 'POST',
  redirect: 'error',
  headers: { 'X-Client-Request-Id': id },
  body: JSON.stringify({
    model: LIMITS.model,
    service_tier: 'default',
    store: false,
    stream: false,
    max_output_tokens: LIMITS.maxOutputTokens,
    input: JSON.stringify({ purpose: 'speech', context: { contextHash: 'synthetic' } }),
  }),
});
await test('PostgreSQL evaluation ledger commits before dispatch and survives locks, restart and killed process', async (t) => {
  let guard;
  try {
    await t.test('missing prior ledger cannot be silently reinitialized', async () => {
      await assert.rejects(
        createPgStoryGuard(url, async () => {
          throw Error('NEVER');
        }),
        /EXISTING_EVALUATION_LEDGER_MISSING/,
      );
    });
    await t.test(
      'explicit first initialization carries debit; session lock prevents concurrent guard',
      async () => {
        guard = await createPgStoryGuard(
          url,
          async () => {
            const persisted = await readPgStoryLedger(url);
            assert.equal(persisted.attempts.at(-1).state, 'reserved');
            return new Response(
              JSON.stringify({
                id: 'pg-synthetic',
                service_tier: 'default',
                usage: { input_tokens: 10, output_tokens: 10 },
              }),
            );
          },
          { initialize: true },
        );
        assert.equal(guard.snapshot().limits.carriedMicros, 10769);
        await assert.rejects(
          createPgStoryGuard(url, async () => {}),
          /EVALUATION_ALREADY_RUNNING/,
        );
        await guard.fetch('https://api.openai.com/v1/responses', request('first'));
        assert.equal((await readPgStoryLedger(url)).attempts[0].state, 'known');
        await guard.close();
      },
    );
    await t.test('reopened process preserves receipts and refuses duplicate dispatch', async () => {
      let calls = 0;
      guard = await createPgStoryGuard(url, async () => {
        calls++;
      });
      await assert.rejects(
        guard.fetch('https://api.openai.com/v1/responses', request('first')),
        /DUPLICATE_DISPATCH/,
      );
      assert.equal(calls, 0);
      await guard.close();
    });
    await t.test(
      'SIGKILL after committed reservation retains exposure; new process never redispatches',
      async () => {
        const source = `import {createPgStoryGuard} from './scripts/live-story/pg-guard.mjs';const g=await createPgStoryGuard(process.env.TEST_LIVE_GUARD_DB_URL,async()=>{process.send('reserved');await new Promise(()=>{});});await g.fetch('https://api.openai.com/v1/responses',${JSON.stringify(request('crashed'))});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            TEST_LIVE_GUARD_DB_URL: url,
          },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
          const ready = await Promise.race([
            once(child, 'message'),
            once(child, 'exit').then(() => {
              throw Error('RESERVATION_CHILD_EXITED_EARLY');
            }),
          ]);
          assert.equal(ready[0], 'reserved');
          const end = once(child, 'exit');
          child.kill('SIGKILL');
          await end;
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        assert.equal((await readPgStoryLedger(url)).attempts.at(-1).state, 'reserved');
        await delay(100);
        guard = await createPgStoryGuard(url, async () => {
          throw Error('NO_NETWORK');
        });
        await assert.rejects(
          guard.fetch('https://api.openai.com/v1/responses', request('after-crash')),
          /UNRECONCILED_EXPOSURE/,
        );
        assert.equal(guard.snapshot().attempts.length, 2);
        await guard.close();
      },
    );
    await t.test('missing row or tampered carry never creates a fresh allowance', async () => {
      await pool.query(
        "UPDATE live_story_evaluation_ledger SET state=jsonb_set(state,'{limits,carriedMicros}','0') WHERE id=$1",
        [LEDGER_ID],
      );
      await assert.rejects(
        createPgStoryGuard(url, async () => {}),
        /LEDGER_POLICY_CHANGED/,
      );
      await pool.query('DELETE FROM live_story_evaluation_ledger WHERE id=$1', [LEDGER_ID]);
      await assert.rejects(
        createPgStoryGuard(url, async () => {}, { initialize: true }),
        /EXISTING_EVALUATION_LEDGER_MISSING/,
      );
    });
  } finally {
    await guard?.close();
    await pool.end();
  }
});
