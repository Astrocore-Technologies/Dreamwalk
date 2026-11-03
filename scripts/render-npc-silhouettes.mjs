/** Offscreen contact sheet of the exact renderer vector commands, no browser/provider. */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';
const source = readFileSync(
  new URL('../apps/web/components/game/npc-silhouettes.ts', import.meta.url),
  'utf8',
);
const exports = {};
new Function(
  'exports',
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
)(exports);
const { drawNpcSilhouette, NPC_PLACEHOLDERS } = exports;
const color = (n) => '#' + n.toString(16).padStart(6, '0');
function svgCommands() {
  const shapes = [];
  let current = '';
  let path = '';
  const g = {
    clear() {
      shapes.length = 0;
      return g;
    },
    circle(x, y, r) {
      current = `<circle cx="${x}" cy="${y}" r="${r}"`;
      return g;
    },
    roundRect(x, y, w, h, r) {
      current = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"`;
      return g;
    },
    moveTo(x, y) {
      path = `M${x} ${y}`;
      current = '';
      return g;
    },
    lineTo(x, y) {
      path += `L${x} ${y}`;
      return g;
    },
    quadraticCurveTo(cx, cy, x, y) {
      path += `Q${cx} ${cy} ${x} ${y}`;
      return g;
    },
    closePath() {
      path += 'Z';
      return g;
    },
    fill(style) {
      const s = typeof style === 'number' ? { color: style } : style;
      shapes.push(
        `${current || `<path d="${path}"`} fill="${color(s.color)}" opacity="${s.alpha ?? 1}"/>`,
      );
      return g;
    },
    stroke(s) {
      shapes.push(
        `${current || `<path d="${path}"`} fill="none" stroke="${color(s.color)}" stroke-width="${s.width}" opacity="${s.alpha ?? 1}"/>`,
      );
      return g;
    },
  };
  return { g, shapes };
}
const cells = [];
for (let row = 0; row < NPC_PLACEHOLDERS.length; row++) {
  const category = NPC_PLACEHOLDERS[row];
  cells.push(`<text x="15" y="${row * 140 + 30}" fill="#fff" font-size="18">${category}</text>`);
  for (let variant = 0; variant < 3; variant++) {
    const { g, shapes } = svgCommands();
    drawNpcSilhouette(g, category, variant);
    // 96px detail plus actual medium/small/tiny bounds from a 48px grid cell.
    for (const [column, size] of [
      [0, 96],
      [106, 40.8],
      [164, 28.8],
      [208, 19.2],
    ]) {
      cells.push(
        `<g transform="translate(${130 + variant * 250 + column},${row * 140 + (110 - size) / 2}) scale(${size / 64})">${shapes.join('')}</g>`,
      );
    }
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="940" height="560"><rect width="940" height="560" fill="#263347"/>${cells.join('')}</svg>`;
const out = resolve(process.argv[2] ?? '/tmp/dreamwalk-npc-silhouettes.png');
mkdirSync(resolve(out, '..'), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(out);
