import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { dictionaries, supportedLocales } from '../../apps/web/lib/locales.ts';
import { gameMessages } from '../../apps/web/lib/game-locales.ts';

test('game vocabulary is translated in all three platform dictionaries with matching tokens', () => {
  assert.ok(Object.keys(gameMessages).length >= 80);
  for (const [key, values] of Object.entries(gameMessages)) {
    for (const locale of supportedLocales) {
      assert.equal(dictionaries[locale][key], values[locale]);
      assert.ok(values[locale].trim());
      const tokens = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(tokens(values[locale]), tokens(key));
    }
  }
});

test('dynamic game action, error and event labels have complete registered translations', async () => {
  const text = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
    'game-page.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;
  const walk = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ['actionKeys', 'errorKeys', 'eventKeys'].includes(node.name.getText(source))
    ) {
      const inspect = (child) => {
        if (ts.isPropertyAssignment(child) && ts.isStringLiteral(child.initializer)) {
          count++;
          for (const locale of supportedLocales)
            assert.ok(
              Object.hasOwn(dictionaries[locale], child.initializer.text),
              `${locale}: ${child.initializer.text}`,
            );
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(count >= 30);
});

test('original runtime sprite atlas matches recorded source integrity and contains no active/external content', async () => {
  const source = await readFile(
    new URL('../../assets/game/observatory-atlas.svg', import.meta.url),
  );
  const runtime = await readFile(
    new URL('../../apps/web/public/game/observatory-atlas.svg', import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(new URL('../../assets/game/manifest.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(runtime, source);
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sha256);
  assert.equal(manifest.frames.length, 10);
  assert.equal(manifest.width, manifest.frameSize * manifest.frames.length);
  assert.doesNotMatch(source.toString(), /<script|foreignObject|onload\s*=|href\s*=/i);
});

test('direction releases preserve a bounded tap; explicit stop and blur stop on the server', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  // Source-level wiring guard, not a claim of a browser timing test.
  assert.match(source, /onPointerUp=\{releaseRepeat\}/);
  assert.match(source, /onLostPointerCapture=\{releaseRepeat\}/);
  assert.match(source, /onPointerCancel=\{explicitStop\}/);
  assert.match(source, /onBlur=\{explicitStop\}/);
  assert.match(source, /onClick=\{explicitStop\}/);
  const keyup = source.slice(source.indexOf('onKeyUp='), source.indexOf('onKeyDown='));
  assert.match(keyup, /releaseRepeat\(\)/);
  assert.doesNotMatch(keyup, /explicitStop|onStop/);
  const release = source.slice(
    source.indexOf('const releaseRepeat'),
    source.indexOf('const explicitStop'),
  );
  assert.match(release, /clearInterval/);
  assert.doesNotMatch(release, /onStop|onMove/);
  assert.match(source, /setInterval\(\(\) => step\(direction.dx, direction.dy\), 150\)/);
});
