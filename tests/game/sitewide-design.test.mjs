import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
const luminance = (hex) => {
  const channels = hex
    .match(/[a-f\d]{2}/gi)
    .map((channel) => parseInt(channel, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
test('both actual shared palettes meet WCAG AA normal text on main surfaces', async () => {
  const css = await read('app/globals.css');
  const root = css.match(/:root\s*\{([^}]+)/)[1];
  const light = css.match(/html\[data-theme='light'\]\s*\{([^}]+)/)[1];
  for (const block of [root, light]) {
    const token = (key) => block.match(new RegExp(`--${key}:\\s*(#[a-fA-F0-9]+)`))[1];
    const full = (value) =>
      value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value;
    for (const foreground of ['text', 'muted', 'accent'])
      for (const background of ['bg', 'surface', 'surface-soft'])
        assert.ok(
          contrast(full(token(foreground)), full(token(background))) >= 4.5,
          `${foreground}/${background} must be readable`,
        );
  }
  assert.ok(contrast('#241b2f', '#dfb568') >= 4.5);
});
test('metrics render only real API values and likes do not reuse bookmarks', async () => {
  const source = await read('components/story-metrics.tsx');
  assert.match(source, /Number.isFinite\(adventure.totalRounds\)/);
  assert.match(source, /Number.isFinite\(adventure.likeCount\)/);
  assert.match(source, /`\/likes\/\$\{adventure.id\}`/);
  assert.match(source, /body: '\{\}'/);
  assert.match(source, /aria-pressed=\{liked\}/);
  assert.doesNotMatch(source, /favoriteCount|Math.random|\/favorites/);
  const home = await read('components/home/home-page.tsx');
  assert.match(home, /sort=popular/);
  assert.match(home, /kind="popular"/);
});
test('game shell removes navigation without removing global language and theme controls', async () => {
  const shell = await read('components/shell.tsx');
  assert.match(shell, /!inGame && \(/);
  assert.match(shell, /game-return/);
  assert.match(shell, /className="locale-select"/);
  assert.match(shell, /className="icon-button theme-button"/);
  const page = await read('components/game/game-page.tsx');
  assert.doesNotMatch(page, /<CampaignObjectives/);
  const layout = await read('app/layout.tsx');
  assert.match(layout, /dreamwalk-theme/);
  assert.match(layout, /design-system.css/);
});
