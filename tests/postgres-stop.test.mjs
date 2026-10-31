import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { stopWindowsPostgres } from '../scripts/postgres-local.mjs';

test('Windows graceful stop passes only its owned cluster to pg_ctl without a shell', async () => {
  const directory = 'D:\\Projects with spaces\\Dreamwalk\\.local\\owned\\postgres';
  await stopWindowsPostgres('D:\\bundled\\pg_ctl.exe', directory, 'owned', {
    spawnProcess(command, args, options) {
      assert.equal(command, 'D:\\bundled\\pg_ctl.exe');
      assert.deepEqual(args, ['stop', '-D', directory, '-m', 'fast', '-w', '-t', '30']);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio, 'ignore');
      assert.ok(options.signal instanceof AbortSignal);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  });
});

test('failed native stop rejects without a forced database kill or lock deletion', async () => {
  let calls = 0;
  await assert.rejects(
    stopWindowsPostgres('pg_ctl.exe', 'owned-data', 'owned', {
      spawnProcess() {
        calls++;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 1));
        return child;
      },
    }),
    /Preserve its data; no forced stop or lock deletion/,
  );
  assert.equal(calls, 1);
});

test('a pg_ctl spawn error rejects rather than waiting forever for an exit', async () => {
  await assert.rejects(
    stopWindowsPostgres('missing-pg_ctl.exe', 'owned-data', 'owned', {
      spawnProcess() {
        const child = new EventEmitter();
        queueMicrotask(() =>
          child.emit('error', Object.assign(Error('missing'), { code: 'ENOENT' })),
        );
        return child;
      },
    }),
    { code: 'ENOENT' },
  );
});

test('outer deadline terminates only a hung controller and rejects without a fallback', async () => {
  let closed;
  let calls = 0;
  await assert.rejects(
    stopWindowsPostgres('synthetic-controller', 'owned-data', 'owned', {
      timeoutMs: 100,
      spawnProcess(_command, _args, options) {
        calls++;
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        // Close observation must survive the expected AbortError from the controller.
        closed = new Promise((resolve) => child.once('close', resolve));
        return child;
      },
    }),
    { name: 'AbortError' },
  );
  await closed;
  assert.equal(calls, 1);
});
