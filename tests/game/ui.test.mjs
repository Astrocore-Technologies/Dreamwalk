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

test('Studio map tools and localized template labels have complete dictionary coverage', async () => {
  const text = await readFile(
    new URL('../../apps/web/components/studio/playable-map-editor.tsx', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
    'playable-map-editor.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ['toolLabels', 'names'].includes(node.name.getText(source))
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
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(count >= 16);
});

test('the renderer only resolves the pinned bundled atlas and its immutable file matches the hash', async () => {
  const { resolveGameAtlas, prototypeAtlas } = await import('../../apps/web/lib/game-assets.ts');
  assert.equal(resolveGameAtlas(), prototypeAtlas.path);
  assert.equal(
    resolveGameAtlas({ id: prototypeAtlas.id, sha256: prototypeAtlas.sha256 }),
    prototypeAtlas.path,
  );
  assert.throws(() =>
    resolveGameAtlas({ id: 'https://example.com/untrusted.svg', sha256: prototypeAtlas.sha256 }),
  );
  assert.throws(() => resolveGameAtlas({ id: prototypeAtlas.id, sha256: 'modified' }));
  const bytes = await readFile(
    new URL(`../../apps/web/public${prototypeAtlas.path}`, import.meta.url),
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), prototypeAtlas.sha256);
  const manifest = JSON.parse(
    await readFile(new URL('../../assets/game/manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.immutableRuntimePath, prototypeAtlas.path);
});

test('Studio wiring preserves explicit playable opt-in, revision saves, private version pinning and publication guard', async () => {
  // Wiring assertions complement API/core/browser acceptance; not browser execution evidence.
  const editor = await readFile(
    new URL('../../apps/web/components/studio/playable-map-editor.tsx', import.meta.url),
    'utf8',
  );
  const studio = await readFile(
    new URL('../../apps/web/components/studio.tsx', import.meta.url),
    'utf8',
  );
  assert.match(editor, /createAuthoredDraft\(template\)/);
  assert.match(editor, /expectedRevision: revision/);
  assert.match(editor, /const result = await autosave.flush\(\)/);
  assert.match(editor, /useDraftAutosave<AuthoredGameDraft \| null, DraftResponse>/);
  assert.match(editor, /playableVersionId: version.versionId/);
  assert.doesNotMatch(editor, /dangerouslySetInnerHTML|JSON\.parse|<Textarea/);
  assert.match(studio, /if \(playableFlush.current\) await playableFlush.current\(\)/);
  assert.match(studio, /useDirtyWarning\(dirty \|\| playableDirty\)/);
  assert.match(studio, /dirty \|\| playableDirty \? setConfirm\('leave'\)/);
  assert.match(studio, /hidden=\{step !== 2 && step !== 6\}/);
});

test('moderation map inspector is read-only and approval waits for review of the submitted version', async () => {
  const panel = await readFile(
    new URL('../../apps/web/components/studio/playable-review.tsx', import.meta.url),
    'utf8',
  );
  const admin = await readFile(
    new URL('../../apps/web/components/admin.tsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /\/admin\/adventures\/\$\{adventureId\}\/playable-review/);
  assert.match(panel, /useResource<ReviewResponse>/);
  assert.doesNotMatch(
    panel,
    /method:|\/game\/campaigns|npcBrains|npcDefinitions|dangerouslySetInnerHTML/,
  );
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /review.data.versionId === checkedVersion/);
  assert.match(admin, /reviewedPlayableVersionId: reviewedVersionId/);
  assert.match(admin, /STALE_REVIEW/);
  assert.match(admin, /decision === 'approve' && !playableReviewed/);
  assert.match(admin, /target.status === 'pending_review' && target.visibility === 'public'/);
});

test('playable select labels stay exact independently of option text', async () => {
  const editor = await readFile(
    new URL('../../apps/web/components/studio/playable-map-editor.tsx', import.meta.url),
    'utf8',
  );
  // A wrapping label also contains option text. Explicit names preserve precise
  // label queries even when user-authored map/NPC names change.
  const selects = [
    ...editor.matchAll(
      /<Field label=\{t\('([^']+)'\)\}>\s*<Select\s+aria-label=\{t\('([^']+)'\)\}/g,
    ),
  ];
  assert.equal(selects.length, 11);
  for (const match of selects) assert.equal(match[1], match[2]);
});

test('authored game header reserves status width and stacks on narrow screens', async () => {
  const css = await readFile(
    new URL('../../apps/web/components/game/game.module.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /\.roomHeader > div:first-child\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 0;/);
  assert.match(css, /\.connection\s*\{[^}]*flex: 0 0 auto;[^}]*max-width: 40%;/);
  assert.match(
    css.slice(css.indexOf('@media (max-width: 650px)')),
    /\.roomHeader\s*\{[^}]*flex-direction: column;/,
  );
});
