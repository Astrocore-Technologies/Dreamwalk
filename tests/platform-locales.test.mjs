import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  imageQualityLabel,
  imageSizeLabel,
  requestPurposeLabel,
} from '../apps/web/lib/generation-labels.ts';
import { formatSparkSubunits } from '../packages/contracts/src/sparks.ts';
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
        const inspectKey = (key) => {
          if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
            checked++;
            for (const locale of supportedLocales)
              if (!Object.hasOwn(dictionaries[locale], key.text.trim()))
                missing.push(`${path.relative(root, filename)} ${locale}: ${key.text}`);
          } else if (ts.isConditionalExpression(key)) {
            inspectKey(key.whenTrue);
            inspectKey(key.whenFalse);
          } else if (ts.isParenthesizedExpression(key)) {
            inspectKey(key.expression);
          } else if (
            ts.isBinaryExpression(key) &&
            ['||', '??'].includes(key.operatorToken.getText(source))
          ) {
            inspectKey(key.left);
            inspectKey(key.right);
          }
        };
        inspectKey(argument);
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
    'Dreamwalk',
    'NPC',
    'NPC:',
    'DEMO',
    'RU',
    'UK',
    'EN',
    // Engine coordinate axes are the same mathematical notation in every locale.
    'x/y',
    'x → · y ↓',
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
    'labels',
    'goalLabels',
    'motivationLabels',
    'disclosureLabels',
    'observationLabels',
    'channelLabels',
  ]);
  for (const relative of [
    'apps/web/components/studio.tsx',
    'apps/web/components/admin.tsx',
    'apps/web/components/personal.tsx',
    'apps/web/components/game/living-ai-panel.tsx',
    'apps/web/components/studio/living-npc-authoring.tsx',
    'apps/web/components/studio/living-npc-preview.tsx',
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
      if (ts.isTypeNode(node)) return;
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
        (node.name.text !== 'labels' ||
          relative === 'apps/web/components/game/living-ai-panel.tsx') &&
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

test('authentication, validation and dynamic NPC labels are complete in the selected language', () => {
  const expected = {
    ru: ['Электронная почта', 'Ошибка', 'Помочь', 'Заполни это поле.'],
    en: ['Email', 'Error', 'Help', 'Fill in this field.'],
    uk: ['Електронна пошта', 'Помилка', 'Допомогти', 'Заповни це поле.'],
  };
  for (const locale of supportedLocales)
    assert.deepEqual(
      ['Электронная почта', 'Ошибка', 'Помочь', 'Заполни это поле.'].map((key) =>
        translate(locale, key),
      ),
      expected[locale],
    );
});

test('visible date and time formatting always has an explicit UI locale', async () => {
  const missing = [];
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
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'].includes(
          node.expression.name.text,
        ) &&
        !node.arguments.length
      )
        missing.push(`${path.relative(root, filename)}: ${node.getText(source)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
});

test('generation enum labels and launch amounts follow the chosen locale without mutating identifiers', async () => {
  for (const [locale, quality, size, task, amount] of [
    ['ru', 'Низкое качество', 'Автоматический размер', 'Реплика NPC', '1,25'],
    ['uk', 'Низька якість', 'Автоматичний розмір', 'Репліка NPC', '1,25'],
    ['en', 'Low quality', 'Automatic size', 'NPC reply', '1.25'],
  ]) {
    assert.equal(imageQualityLabel(locale, 'low'), quality);
    assert.equal(imageSizeLabel(locale, 'auto'), size);
    assert.equal(requestPurposeLabel(locale, 'speech'), task);
    assert.equal(formatSparkSubunits('12500', locale), amount);
    assert.equal(imageSizeLabel(locale, '1024x1536'), '1024x1536');
    assert.equal(imageQualityLabel(locale, 'provider-v2'), 'provider-v2');
    assert.ok(requestPurposeLabel(locale, 'future-task').length);
    for (const known of ['low', 'medium', 'high', 'auto'])
      assert.notEqual(imageQualityLabel(locale, known), known);
    for (const known of [
      'plan',
      'summary',
      'speech',
      'intent',
      'narrative',
      'story_turn',
      'story_plan',
      'supporting_npc',
    ])
      assert.notEqual(requestPurposeLabel(locale, known), known);
  }
  const launch = await readFile(
    path.join(root, 'apps/web/components/game/adventure-launch.tsx'),
    'utf8',
  );
  assert.match(launch, /formatSparkSubunits\(estimatedSubunits, locale\)/);
  assert.match(launch, /formatSparkSubunits\(quote.sparks.reserveSubunits, locale\)/);
});

test('persistent success notices translate at render rather than freezing the action-time language', async () => {
  for (const [relative, key, renderer] of [
    ['apps/web/components/account.tsx', 'setResult', 'tr(result)'],
    ['apps/web/components/account-email.tsx', 'setMessage', 't(message)'],
    ['apps/web/components/studio/story-npc-editor.tsx', 'setNotice', 'text(notice)'],
  ]) {
    const contents = await readFile(path.join(root, relative), 'utf8');
    assert.ok(contents.includes(renderer), relative);
    const source = ts.createSourceFile(
      relative,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === key &&
        node.arguments[0]
      ) {
        const inspectArgument = (argument) => {
          assert.ok(
            !ts.isCallExpression(argument) ||
              !['t', 'tr', 'text'].includes(argument.expression.getText(source)),
            relative,
          );
          ts.forEachChild(argument, inspectArgument);
        };
        inspectArgument(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test('story composer explains completed roleplay facts and technical checks in every locale', async () => {
  const filename = path.join(root, 'apps/web/components/game/story-messages.ts');
  const source = ts.createSourceFile(
    filename,
    await readFile(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let hints;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'hint') {
      assert.ok(ts.isArrayLiteralExpression(node.initializer));
      hints = node.initializer.elements.map((element) => {
        assert.ok(ts.isStringLiteral(element));
        return element.text;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(hints, [
    'Действие — между *звёздочками*, слова — обычным текстом. Описывай завершённые действия как факты истории. Изменения игрового состояния проходят технические проверки.',
    'Put actions between *asterisks* and speech in plain text. Describe completed actions as story facts. Game-state changes still undergo technical checks.',
    'Дія — між *зірочками*, слова — звичайним текстом. Описуй завершені дії як факти історії. Зміни ігрового стану проходять технічні перевірки.',
  ]);
  const composer = await readFile(
    path.join(root, 'apps/web/components/game/unified-story.tsx'),
    'utf8',
  );
  assert.match(composer, /aria-describedby=\{hintId\}/);
  assert.match(composer, /<p id=\{hintId\}[^>]*>\s*\{h\('hint'\)\}/);
});
