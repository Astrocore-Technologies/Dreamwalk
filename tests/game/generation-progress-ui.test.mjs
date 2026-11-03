import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL(`../../apps/web/components/${path}`, import.meta.url), 'utf8');
test('generation progress is accessible, localized and respects reduced motion', async () => {
  const source = await read('visual-authoring/generation-progress.tsx');
  const css = await read('visual-authoring/generation-progress.module.css');
  for (const value of [
    'queued:',
    'dispatched:',
    'generated:',
    'role="status"',
    'aria-live="polite"',
    'aria-busy="true"',
    'aria-hidden="true"',
  ])
    assert.ok(source.includes(value));
  assert.match(source, /if \(!\(status in messages\)\) return null/);
  assert.doesNotMatch(source, /unknown:|admitted:|setInterval|Math.random|percent/i);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none/);
});
test('shared covers, portraits, character stages and location jobs use real pending progress', async () => {
  for (const path of [
    'assets/image-generation.tsx',
    'visual-authoring/external-generation.tsx',
    'visual-authoring/location-image-inline.tsx',
  ]) {
    const source = await read(path);
    assert.match(source, /GenerationProgress/);
  }
  const images = await read('assets/image-generation.tsx');
  assert.match(images, /\['queued', 'dispatched', 'generated'\]\.includes\(job.status\)/);
  assert.match(images, /!outstandingExternalJob/);
  assert.match(images, /dispatchUncertain/);
});
