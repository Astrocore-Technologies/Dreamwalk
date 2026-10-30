import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LaunchGate } from '../../apps/web/components/home/launch-gate.ts';
test('actual homepage launch gate admits one same-tick request and preserves lock on selection change', async () => {
  const gate = new LaunchGate();
  gate.select('approved-A');
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let routes = [];
  async function start() {
    const lease = gate.begin();
    if (!lease) return;
    calls++;
    await pending;
    if (gate.accepts(lease)) routes.push(lease.selection);
    gate.finish(lease);
  }
  const a = start(),
    b = start();
  assert.equal(calls, 1);
  assert.equal(gate.busy, true);
  gate.select('approved-B');
  assert.equal(gate.begin(), null);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(routes, []);
  assert.equal(gate.busy, false);
  const next = gate.begin();
  assert.equal(next.selection, 'approved-B');
  assert.equal(gate.accepts(next), true);
  gate.finish(next);
});
test('unmount and remount cannot route or finish a newer launch with an old response', () => {
  const gate = new LaunchGate();
  gate.select('a');
  const old = gate.begin();
  gate.dispose();
  assert.equal(gate.accepts(old), false);
  assert.equal(gate.begin(), null);
  gate.activate();
  const next = gate.begin();
  assert.equal(gate.finish(old), false);
  assert.equal(gate.busy, true);
  assert.equal(gate.accepts(next), true);
  gate.finish(next);
});
test('home uses approved detail mode and guards every manual carousel path with launch gate', async () => {
  const s = await readFile(
    new URL('../../apps/web/components/home/home-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(s, /view=published/);
  assert.match(s, /details.data\?\.id === active\?\.id/);
  assert.match(s, /launchGate.current.accepts\(lease\)/);
  assert.match(s, /launchGate.current.busy/);
  assert.doesNotMatch(s, /setInterval|autoplay/i);
  assert.match(s, /membership === 'accepted'/);
});
