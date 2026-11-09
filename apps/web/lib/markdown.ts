/**
 * A small, safe Markdown subset for author text. It parses into a plain data tree; the renderer
 * only ever creates text nodes and a fixed set of elements, so author input can never inject HTML,
 * scripts, images or non-http links. Raw HTML is shown as literal text.
 *
 * Blocks: paragraphs (a single newline is a line break), headings (# to ###), bullet and numbered
 * lists, block quotes, horizontal rules. Inline: **bold**, *italic* / _italic_, `code`, [text](https://link).
 */
export type Inline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };
export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' };

export const MARKDOWN_LIMIT = 20000;
const MAX_DEPTH = 4;
const safeHref = /^https?:\/\/[^\s<>"'`]{1,2000}$/i;
const escapable = /[\\`*_[\]()#>+\-.!~|{}]/;

function pushText(out: Inline[], value: string) {
  if (!value) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.value += value;
  else out.push({ type: 'text', value });
}

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  const text = source;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && escapable.test(text[i + 1])) {
      pushText(out, text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ type: 'code', value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[' && depth < MAX_DEPTH) {
      const close = text.indexOf('](', i + 1);
      const end = close < 0 ? -1 : text.indexOf(')', close + 2);
      if (close > i + 1 && end > close + 2) {
        const label = text.slice(i + 1, close);
        const href = text.slice(close + 2, end).trim();
        if (!label.includes('[') && safeHref.test(href)) {
          out.push({ type: 'link', href, children: parseInline(label, depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    if ((ch === '*' || ch === '_') && depth < MAX_DEPTH) {
      const double = text[i + 1] === ch;
      const mark = double ? ch + ch : ch;
      const start = i + mark.length;
      // `_` only opens at a word boundary so snake_case words stay literal.
      const boundary = ch === '*' || i === 0 || /[\s([{>,.;:!?"'«—-]/.test(text[i - 1]);
      let end = -1;
      if (boundary && start < text.length && !/\s/.test(text[start])) {
        let from = start;
        while (from < text.length) {
          const found = text.indexOf(mark, from);
          if (found < 0) break;
          if (found > start && !/\s/.test(text[found - 1])) {
            end = found;
            break;
          }
          from = found + 1;
        }
      }
      if (end > start) {
        const children = parseInline(text.slice(start, end), depth + 1);
        out.push(double ? { type: 'strong', children } : { type: 'em', children });
        i = end + mark.length;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index) out.push({ type: 'br' });
    out.push(...parseInline(line.replace(/\s+$/u, '')));
  });
  return out;
}

const bullet = /^\s{0,3}[-*+]\s+(.*)$/;
const numbered = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const quote = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.slice(0, MARKDOWN_LIMIT).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: inlineLines(paragraph) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = heading.exec(line);
    if (h) {
      flush();
      blocks.push({
        type: 'heading',
        level: Math.min(h[1].length, 3) as 1 | 2 | 3,
        children: parseInline(h[2]),
      });
      continue;
    }
    if (rule.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    if (quote.test(line) && depth < 2) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && quote.test(lines[i])) inner.push(quote.exec(lines[i++])![1]);
      i--;
      blocks.push({ type: 'quote', children: parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }
    const kind = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null;
    if (kind) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && kind.test(lines[i]))
        items.push(parseInline(kind.exec(lines[i++])![1]));
      i--;
      blocks.push({ type: 'list', ordered: kind === numbered, items });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.type === 'text' || node.type === 'code'
        ? node.value
        : node.type === 'br'
          ? ' '
          : inlineText(node.children),
    )
    .join('');
}
function blockText(block: Block): string {
  if (block.type === 'rule') return '';
  if (block.type === 'list') return block.items.map(inlineText).join(' ');
  if (block.type === 'quote') return block.children.map(blockText).join(' ');
  return inlineText(block.children);
}
/** Plain text for cards, previews and meta contexts where formatting must not show as symbols. */
export function stripMarkdown(source: string): string {
  return parseMarkdown(source).map(blockText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
