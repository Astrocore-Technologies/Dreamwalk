import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  parseInline,
  stripMarkdown,
  MARKDOWN_LIMIT,
} from '../../apps/web/lib/markdown.ts';

const text = (value) => ({ type: 'text', value });

test('inline formatting: bold, italic, code and links nest safely', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    text('a '),
    { type: 'strong', children: [text('b')] },
    text(' c'),
  ]);
  assert.deepEqual(parseInline('*x* and _y_'), [
    { type: 'em', children: [text('x')] },
    text(' and '),
    { type: 'em', children: [text('y')] },
  ]);
  assert.deepEqual(parseInline('**a *b* c**'), [
    {
      type: 'strong',
      children: [text('a '), { type: 'em', children: [text('b')] }, text(' c')],
    },
  ]);
  assert.deepEqual(parseInline('`**not bold**`'), [{ type: 'code', value: '**not bold**' }]);
  assert.deepEqual(parseInline('[site](https://example.com/a?b=1)'), [
    { type: 'link', href: 'https://example.com/a?b=1', children: [text('site')] },
  ]);
});

test('unmatched or ambiguous markers stay literal text', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
  assert.deepEqual(parseInline('snake_case_word'), [text('snake_case_word')]);
  assert.deepEqual(parseInline('**open'), [text('**open')]);
  assert.deepEqual(parseInline('\\*not italic\\*'), [text('*not italic*')]);
});

test('raw HTML, scripts, images and unsafe links never become elements', () => {
  for (const source of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](data:text/html;base64,AAAA)',
    '[click](//evil.example/x)',
    '[click]( https://ok.example/ "title")',
  ]) {
    const flat = JSON.stringify(parseMarkdown(source));
    assert.doesNotMatch(flat, /"type":"(link|image|html|script)"/, source);
  }
  // An image marker is only a plain link: no image element exists, so nothing is ever loaded.
  assert.doesNotMatch(JSON.stringify(parseMarkdown('![img](https://example.com/x.png)')), /image/);
  // The literal text survives so the author sees exactly what they typed.
  assert.equal(stripMarkdown('<b>bold</b>'), '<b>bold</b>');
});

test('blocks: headings, lists, quotes, rules and line breaks', () => {
  const blocks = parseMarkdown(
    ['# Title', 'first', 'second', '', '- a', '- b', '', '1. x', '2. y', '', '> q', '', '---'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'list', 'quote', 'rule'],
  );
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].children, [text('first'), { type: 'br' }, text('second')]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].ordered, true);
  assert.equal(parseMarkdown('####### seven')[0].level, undefined);
  assert.equal(parseMarkdown('###### six')[0].level, 3);
});

test('stripMarkdown gives clean single-line text for cards', () => {
  assert.equal(
    stripMarkdown('# Тайна\n**Старая** обсерватория\n- звёзды\n- [карта](https://x.example)'),
    'Тайна Старая обсерватория звёзды карта',
  );
  assert.equal(stripMarkdown(''), '');
});

test('hostile input is bounded and linear enough to parse instantly', () => {
  const started = Date.now();
  parseMarkdown('*'.repeat(MARKDOWN_LIMIT * 2));
  parseMarkdown('[a](b'.repeat(4000));
  parseMarkdown('**a *'.repeat(3000));
  parseMarkdown('> '.repeat(500) + 'deep');
  assert.ok(Date.now() - started < 3000, 'parsing stays fast');
});
