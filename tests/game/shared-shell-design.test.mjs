import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (file) =>
  readFile(new URL(`../../apps/web/components/${file}`, import.meta.url), 'utf8');

test('reference rail keeps working search, supported routes and owned account data', async () => {
  const shell = await read('shell.tsx');
  assert.match(shell, /<AuthMark\s*\/>/);
  assert.doesNotMatch(shell, /nav-caption|nav-dot|catalog-shell-label/);
  assert.match(shell, /className="top-search rail-search"/);
  assert.match(shell, /role="search"/);
  assert.match(shell, /encodeURIComponent\(query\)/);
  for (const href of [
    '/home',
    '/explore',
    '/library',
    '/my-characters',
    '/studio',
    '/studio/visuals',
    '/wallet',
    '/notifications',
    '/help',
    '/account/profile',
    '/account/settings',
  ])
    assert.ok(shell.includes(href), href);
  assert.match(shell, /user\?\.role === 'admin'/);
  assert.match(shell, /<SparksBalance key=\{user.id\} ownerId=\{user.id\}/);
  assert.match(shell, /<DreamsBalance key=\{`dreams-\$\{user.id\}`\} ownerId=\{user.id\}/);
  assert.match(shell, /assetUrl\(user.avatarAssetId\)/);
  assert.match(shell, /className="profile-chip" aria-label=\{tr\('Профиль'\)\}/);
  assert.match(shell, /user.handle.slice\(0, 1\)/);
});

test('drawer closes and restores focus; standalone shells keep a single preference control', async () => {
  const shell = await read('shell.tsx');
  assert.match(shell, /useEffect\(\(\) => setMenu\(false\), \[path\]\)/);
  assert.match(shell, /event.key === 'Escape'/);
  assert.match(shell, /event.key !== 'Tab'/);
  assert.match(shell, /previousFocus.focus\(\)/);
  assert.match(shell, /\(inAuth \|\| inGame\) && <ShellPreferences/);
  assert.match(shell, /rail-preferences/);
  assert.match(shell, /localStorage.setItem\('dreamwalk-theme', theme\)/);
  assert.match(shell, /api<User>\('\/account\/settings'/);
  assert.match(shell, /setLocale\(e.target.value as 'ru' \| 'en' \| 'uk'\)/);
});

test('flat canvas and larger rail are scoped away from auth/gameplay', async () => {
  const css = await read('shell.css');
  assert.match(
    css,
    /\.app-shell:not\(\.game-shell\):not\(\.auth-shell\)::before\s*\{\s*content: none/,
  );
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(css, /:focus-within/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /padding-right: 500px/);
  assert.match(css, /\.main-content > \[data-locale\] > div/);
});
