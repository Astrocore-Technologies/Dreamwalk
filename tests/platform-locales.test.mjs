import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  dictionaries,
  supportedLocales,
  translate,
  formatDate,
  formatNumber,
  formatCount,
} from '../apps/web/lib/locales.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const placeholders = (text) =>
  [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();

test('all three locale dictionaries have identical nonempty keys and interpolation tokens', () => {
  const reference = Object.keys(dictionaries.ru).sort();
  assert.ok(reference.length >= 750, 'the complete platform vocabulary must be retained');
  assert.deepEqual([...supportedLocales].sort(), ['en', 'ru', 'uk']);
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), reference);
    for (const key of reference) {
      const value = dictionaries[locale][key];
      assert.equal(typeof value, 'string', `${locale}: ${key}`);
      assert.ok(value.trim().length, `${locale}: ${key}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(key),
        `${locale}: placeholder mismatch for ${key}`,
      );
    }
  }
});

test('UI translations are genuinely localized rather than copied from Russian', () => {
  assert.equal(translate('en', 'Создать аккаунт'), 'Create account');
  assert.equal(translate('uk', 'Создать аккаунт'), 'Створити обліковий запис');
  assert.equal(translate('ru', 'Создать аккаунт'), 'Создать аккаунт');
  assert.equal(translate('en', 'С возвращением, {name}', { name: 'Олена' }), 'Welcome back, Олена');
  assert.equal(translate('uk', '  Отмена '), '  Скасувати ');
  assert.equal(
    translate('en', 'Проверка: {title}', { title: '<script>story</script>' }),
    'Review: <script>story</script>',
  );
  // The helper returns text, never HTML. Rendering components remain responsible for text escaping.
  const unknown = 'unregistered.ui.key';
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(translate('en', unknown), '[Translation missing]');
    assert.equal(translate('uk', unknown), '[Переклад відсутній]');
  } finally {
    console.warn = warn;
  }
});

test('Intl count grammar, number and date formatting follow the active locale', () => {
  assert.equal(formatCount('en', 1), '1 adventure');
  assert.equal(formatCount('en', 2), '2 adventures');
  assert.equal(formatCount('ru', 1), '1 приключение');
  assert.equal(formatCount('ru', 2), '2 приключения');
  assert.equal(formatCount('ru', 5), '5 приключений');
  assert.equal(formatCount('ru', 21), '21 приключение');
  assert.equal(formatCount('uk', 1), '1 пригода');
  assert.equal(formatCount('uk', 2), '2 пригоди');
  assert.equal(formatCount('uk', 5), '5 пригод');
  assert.equal(formatCount('uk', 11), '11 пригод');
  assert.equal(formatCount('uk', 21, 'player'), '21 гравець');
  assert.equal(formatCount('ru', 2, 'player'), '2 игрока');
  assert.equal(formatNumber('en', 1234.5), '1,234.5');
  assert.equal(formatNumber('uk', 1234.5).replaceAll('\u00a0', ' '), '1 234,5');
  assert.match(formatDate('en', '2026-10-30T12:00:00Z'), /30 Oct 2026/);
  assert.match(formatDate('uk', '2026-10-30T12:00:00Z'), /жовт/);
  assert.match(formatDate('ru', '2026-10-30T12:00:00Z'), /окт/);
  assert.equal(formatDate('uk', 'not a date'), '—');
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(filename)
        : /\.(ts|tsx)$/.test(filename)
          ? [filename]
          : [];
    }),
  );
  return groups.flat();
}

test('every literal t()/tr() UI key exists in all dictionaries', async () => {
  const files = (
    await Promise.all(
      ['components', 'lib'].map((folder) => sourceFiles(path.join(root, 'apps/web', folder))),
    )
  ).flat();
  const missing = [];
  let checked = 0;
  for (const filename of files) {
    if (filename.endsWith('/locales.ts')) continue;
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ['t', 'tr'].includes(node.expression.getText(source)) &&
        node.arguments.length
      ) {
        const argument = node.arguments[0];
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          checked++;
          for (const locale of supportedLocales)
            if (!Object.hasOwn(dictionaries[locale], argument.text.trim()))
              missing.push(`${path.relative(root, filename)} ${locale}: ${argument.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked > 500, 'platform UI should be localized through translation calls');
  assert.deepEqual(missing, []);
});

test('visible Cyrillic and Latin JSX copy is localized except explicit invariant names', async () => {
  const files = await sourceFiles(path.join(root, 'apps/web/components'));
  const unlocalized = [];
  // Exact names only: no broad English-word exemption that could hide untranslated copy.
  const invariantText = new Set([
    'Русский',
    'Українська',
    'English',
    'dreamwalk',
    'NPC',
    'NPC:',
    'DEMO',
    'RU',
    'UK',
    'EN',
  ]);
  // These examples are machine identifiers, not a sentence or instruction to the user.
  const invariantExamples = new Set(['wanderer', 'you@example.com', 'handle']);
  const visibleAttributes = new Set(['title', 'aria-label', 'alt', 'placeholder']);
  for (const filename of files) {
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        ts.isJsxText(node) &&
        /[A-Za-zА-Яа-яЁёІіЇїЄєҐґ]/.test(node.text) &&
        !invariantText.has(node.text.trim())
      ) {
        unlocalized.push(`${path.relative(root, filename)} JSX: ${node.text.trim()}`);
      }
      if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        (/[А-Яа-яЁёІіЇїЄєҐґ]/.test(node.initializer.text) ||
          (visibleAttributes.has(node.name.getText(source)) &&
            /[A-Za-z]/.test(node.initializer.text) &&
            !invariantExamples.has(node.initializer.text)))
      ) {
        // Canonical form values are data, not interface text. They must not change with locale.
        if (node.name.getText(source) !== 'value')
          unlocalized.push(
            `${path.relative(root, filename)} ${node.name.getText(source)}: ${node.initializer.text}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(unlocalized, []);
});

test('dynamic translated step, status, audit and navigation collections contain registered keys', async () => {
  const missing = [];
  const collections = new Set([
    'steps',
    'statuses',
    'statusLabel',
    'actionLabels',
    'links',
    'inviteStatuses',
    'invitationLabels',
  ]);
  for (const relative of [
    'apps/web/components/studio.tsx',
    'apps/web/components/admin.tsx',
    'apps/web/components/personal.tsx',
  ]) {
    const filename = path.join(root, relative);
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const inspect = (node, collection) => {
      if (ts.isStringLiteral(node)) {
        // Navigation routes are identifiers; only its labels are translated.
        if (
          collection === 'links' &&
          (!ts.isPropertyAssignment(node.parent) || node.parent.name.getText(source) !== 'label')
        )
          return;
        // Keys of object maps are stable API identifiers, not interface copy.
        if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
        for (const locale of supportedLocales) {
          if (!Object.hasOwn(dictionaries[locale], node.text.trim()))
            missing.push(`${relative} ${collection} ${locale}: ${node.text}`);
        }
      }
      ts.forEachChild(node, (child) => inspect(child, collection));
    };
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        collections.has(node.name.text) &&
        node.initializer
      )
        inspect(node.initializer, node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
  assert.equal(translate('en', 'NPC'), 'NPC');
  assert.equal(translate('uk', 'NPC'), 'NPC');
});

test('platform UI offers no obsolete unlisted or link-only publication mode', async () => {
  const forbidden = new Set(['unlisted', 'По ссылке', 'Доступно по прямой ссылке']);
  const findings = [];
  for (const filename of await sourceFiles(path.join(root, 'apps/web/components'))) {
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        forbidden.has(node.text)
      )
        findings.push(`${path.relative(root, filename)}: ${node.text}`);
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'unlisted'
      )
        findings.push(`${path.relative(root, filename)}: unlisted status label`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(findings, []);
});

test('built-in adventure metadata has complete translations without inventing authored content', () => {
  assert.equal(translate('en', '1–2 часа'), '1–2 hours');
  assert.equal(translate('uk', '1–2 часа'), '1–2 години');
  assert.equal(translate('en', 'Средне'), 'Moderate');
  assert.equal(translate('uk', 'Средне'), 'Середньо');
  assert.equal(translate('en', 'Уютное фэнтези'), 'Cozy fantasy');
  assert.equal(translate('uk', 'Уютное фэнтези'), 'Затишне фентезі');
  // UI taxonomy rendering intentionally passes unknown creator metadata through unchanged.
  const creatorDuration = 'until the silver moon sets';
  assert.equal(dictionaries.uk[creatorDuration] ?? creatorDuration, creatorDuration);
  assert.equal(dictionaries.en[creatorDuration] ?? creatorDuration, creatorDuration);
});
