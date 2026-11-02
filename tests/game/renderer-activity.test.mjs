import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(
  new URL('../../apps/web/components/game/renderer-activity.ts', import.meta.url),
  'utf8',
);
const exports = {};
new Function(
  'exports',
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
)(exports);
const { rendererActivity, intersectsViewport } = exports;
test('fully offscreen stops; any positive partial intersection remains visible', () => {
  assert.equal(
    intersectsViewport({ top: -663, bottom: -43, left: 0, right: 800 }, 1024, 768),
    false,
  );
  assert.equal(intersectsViewport({ top: -663, bottom: 1, left: 0, right: 800 }, 1024, 768), true);
  assert.equal(
    intersectsViewport({ top: 768, bottom: 900, left: 0, right: 800 }, 1024, 768),
    false,
  );
  assert.equal(
    intersectsViewport({ top: 0, bottom: 100, left: 1024, right: 1200 }, 1024, 768),
    false,
  );
});
test('ready, viewport and document visibility gate only renderer transitions idempotently', () => {
  const calls = [];
  const activity = rendererActivity({
    resume: () => calls.push('sync-latest-then-start'),
    pause: () => calls.push('stop'),
  });
  activity.visibility(false, false);
  activity.ready();
  assert.deepEqual(calls, []);
  activity.visibility(true, false);
  activity.visibility(true, false);
  activity.visibility(true, true);
  activity.visibility(false, true);
  activity.visibility(true, true);
  activity.visibility(true, false);
  assert.deepEqual(calls, ['sync-latest-then-start', 'stop', 'sync-latest-then-start']);
  activity.dispose();
  activity.dispose();
  activity.ready();
  activity.visibility(true, false);
  assert.deepEqual(calls, ['sync-latest-then-start', 'stop', 'sync-latest-then-start', 'stop']);
  assert.equal(activity.isActive(), false);
});
test('no observer fallback starts normally and late init after disposal cannot restart', () => {
  let starts = 0;
  const activity = rendererActivity({ resume: () => starts++, pause: () => {} });
  activity.ready();
  assert.equal(starts, 1);
  const cancelled = rendererActivity({ resume: () => starts++, pause: () => {} });
  cancelled.dispose();
  cancelled.ready();
  assert.equal(starts, 1);
});
test('resume callback reads newest authoritative snapshot rather than paused frame', () => {
  let snapshot = { x: 1 },
    rendered;
  const activity = rendererActivity({
    resume: () => {
      rendered = snapshot;
    },
    pause: () => {},
  });
  activity.ready();
  activity.visibility(false, false);
  snapshot = { x: 8 };
  assert.equal(rendered.x, 1);
  activity.visibility(true, false);
  assert.equal(rendered.x, 8);
});
test('canvas integration source contract: latest React ref, gated resize, transient snap and cleanup', () => {
  const canvas = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(canvas, /latest\.current = \{\s*projection,/);
  assert.match(canvas, /autoStart: false/);
  assert.doesNotMatch(canvas, /resizeTo: element/);
  assert.match(canvas, /if \(!activity\.isActive\(\)\) return;/);
  assert.match(canvas, /resize\(\);\s*resumeFrame\(\);\s*app\.render\(\);/);
  assert.match(
    canvas,
    /if \(resuming\) \{\s*record\.trace = undefined;\s*record\.feedback = undefined;/,
  );
  assert.match(canvas, /intersection\?\.disconnect\(\)/);
  assert.match(canvas, /document\.removeEventListener\('visibilitychange', visibility\)/);
  assert.match(canvas, /activity\.dispose\(\);\s*app\.destroy/);
});

test('initial intersection excludes zero-area canvas and viewport', () => {
  assert.equal(intersectsViewport({ top: 5, bottom: 5, left: 5, right: 30 }, 100, 100), false);
  assert.equal(intersectsViewport({ top: 5, bottom: 30, left: 5, right: 5 }, 100, 100), false);
  assert.equal(intersectsViewport({ top: -5, bottom: 30, left: -5, right: 30 }, 0, 100), false);
  assert.equal(intersectsViewport({ top: -5, bottom: 30, left: -5, right: 30 }, 100, 0), false);
});
