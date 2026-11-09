import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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

test('dynamic game action and error labels have complete registered translations', async () => {
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
  const checkedMaps = new Set();
  const walk = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ['actionKeys', 'errorKeys'].includes(node.name.getText(source))
    ) {
      checkedMaps.add(node.name.getText(source));
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
  assert.deepEqual([...checkedMaps].sort(), ['actionKeys', 'errorKeys']);
  assert.ok(count > 0);
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

test('mouse-only map movement keeps stop, focus and explicit accessible controls without keyboard stepping', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /sceneClick\(state.projection, x, y\)/);
  assert.match(source, /state.onSelectNpc\(interaction.npcId\)/);
  assert.match(source, /else if \(interaction\?\.kind === 'move'\)/);
  assert.match(
    source,
    /if \(!event.currentTarget.contains\(event.relatedTarget\)\) explicitStop\(\)/,
  );
  assert.match(source, /onClick=\{explicitStop\}/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.doesNotMatch(
    source,
    /onKeyDown|onKeyUp|releaseRepeat|directions.map|setInterval\(\(\) => step/,
  );
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

test('Studio retains standalone editor safeguards and uses reviewed builder plus explicit private publication', async () => {
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
  assert.match(studio, /useDirtyWarning\(dirty\)/);
  assert.match(studio, /dirty \? setConfirm\('leave'\)/);
  assert.match(studio, /<\/form>\s*\{!isNew && step === 5 && \([\s\S]*?<StoryPlayableBuilder\b/);
  assert.match(studio, /<StoryPlayableBuilder\b[^>]*beforePrepare=\{autosave.flush\}/);
  assert.match(studio, /<PrivateRelease[\s\S]*?beforePublish=\{autosave.flush\}/);
  assert.doesNotMatch(studio, /<PlayableMapEditor/);
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
    ...editor.matchAll(/<Field label=\{([^}\n]+)\}>\s*<Select\s+aria-label=\{([^}\n]+)\}/g),
  ];
  assert.equal(selects.length, [...editor.matchAll(/<Select\b/g)].length);
  assert.ok(selects.some((match) => match[1] === "t('Силуэт NPC')"));
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

test('living NPC controls preserve saved-version privacy and server-only outcomes', async () => {
  const read = (path) => readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
  const editor = await read('components/studio/playable-map-editor.tsx');
  const preview = await read('components/studio/living-npc-preview.tsx');
  const journal = await read('components/game/living-notices.tsx');
  const speech = await read('components/game/living-conversation.tsx');
  const budget = await read('components/game/living-ai-panel.tsx');
  assert.match(editor, /npcBehavior/);
  assert.match(editor, /autosave.flush/);
  assert.match(preview, /expectedRevision = await flush/);
  assert.match(preview, /\/studio\/adventures\/\$\{adventureId\}\/npc-preview/);
  assert.doesNotMatch(preview, /\/game\/campaigns/);
  assert.match(journal, /projection.npcObligations/);
  assert.match(journal, /projection.npcNotices/);
  assert.match(speech, /projection.npcUtterances/);
  assert.match(speech, /type: 'npc.speech'/);
  for (const source of [journal, speech, budget])
    assert.doesNotMatch(source, /npcBrains|relationships|dangerouslySetInnerHTML/);
  assert.match(budget, /quoteId: quote.id/);
  assert.match(budget, /consent: true/);
  assert.match(budget, /operationId: operation.current/);
  assert.match(budget, /provider !== 'mock'/);
});

test('living NPC author and player copy has complete locale entries', async () => {
  const files = [
    'studio/living-npc-profile',
    'studio/living-npc-examples',
    'studio/living-npc-authoring',
    'studio/living-npc-conditions',
    'studio/moderator-npc-preview',
    'game/party-chat',
    'game/intent-proposals',
    'game/sponsor-budget',
    'studio/living-npc-preview',
    'game/living-notices',
    'game/living-conversation',
    'game/living-ai-panel',
  ];
  for (const file of files) {
    const source = await readFile(
      new URL(`../../apps/web/components/${file}.tsx`, import.meta.url),
      'utf8',
    );
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 't' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const key = node.arguments[0].text;
        for (const locale of supportedLocales)
          assert.ok(dictionaries[locale][key], `${file}: ${locale}: ${key}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test('authored habits examples and links stay bounded and private', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/studio/living-npc-examples.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /decisionExamples/);
  assert.match(source, /maxLength=\{240\}/);
  assert.match(source, /npc.id !== npcId/);
  assert.match(source, /length \|\| 0\) >= 4/);
  const publicSpeech = await readFile(
    new URL('../../apps/web/components/game/living-conversation.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(publicSpeech, /decisionExamples|biography|personality|\.links/);
});

test('speech topics use only visible projected entities and reset quotes', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/living-ai-panel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /projection.entities.some\(\(entity\) => entity.id === selectedTopic\)/);
  assert.match(source, /purpose === 'speech'/);
  assert.match(source, /recipient, campaignId, purpose, channel, topicId/);
  assert.match(source, /purpose, channel, topicId/);
  assert.doesNotMatch(source, /requestedFactIds|disclosureFactIds|observationIds/);
});

test('public NPC speech style is explicit and separate from private prose', async () => {
  const profile = await readFile(
    new URL('../../apps/web/components/studio/living-npc-profile.tsx', import.meta.url),
    'utf8',
  );
  assert.match(profile, /profile.publicSpeechStyle \|\| 'neutral'/);
  assert.match(profile, /Частные заметки о манере речи/);
  for (const key of ['neutral', 'warm', 'formal', 'terse', 'wry'])
    assert.match(profile, new RegExp(key + ':'));
});

test('saved NPC textarea labels do not include their hydrated text content', async () => {
  const profile = await readFile(
    new URL('../../apps/web/components/studio/living-npc-profile.tsx', import.meta.url),
    'utf8',
  );
  assert.match(profile, /aria-label=\{t\('Биография и мотивы'\)\}/);
  assert.match(profile, /label=\{t\('Частные заметки о манере речи'\)\}/);
  const templateField = await readFile(
    new URL('../../apps/web/components/studio/npc-template-field.tsx', import.meta.url),
    'utf8',
  );
  assert.match(templateField, /<label htmlFor=\{id\}>\{label\}<\/label>/);
  assert.match(templateField, /<Textarea\s+id=\{id\}/);
});

test('completed living flows preserve explicit actions and private author data', async () => {
  const read = (path) =>
    readFile(new URL('../../apps/web/components/' + path + '.tsx', import.meta.url), 'utf8');
  const author = await read('studio/living-npc-authoring'),
    conditions = await read('studio/living-npc-conditions'),
    speech = await read('game/living-conversation'),
    chat = await read('game/party-chat'),
    intent = await read('game/intent-proposals'),
    sponsor = await read('game/sponsor-budget'),
    review = await read('studio/moderator-npc-preview');
  assert.match(author, /initialFacts/);
  assert.match(author, /initialGoals/);
  assert.match(author, /promiseTemplates/);
  assert.match(author, /ownerNpcId === npc.id/);
  assert.match(conditions, /value.length >= 4/);
  assert.match(speech, /projection.npcFactTopics/);
  assert.doesNotMatch(speech, /initialFacts|definitionText|biography/);
  assert.match(chat, /\/chat/);
  assert.doesNotMatch(chat, /npc.speech|npcFactTopics/);
  assert.match(chat, /operationId: crypto.randomUUID/);
  assert.match(intent, /\/confirm/);
  assert.match(intent, /confirmation.current/);
  assert.match(intent, /proposal.status === 'cancelled'/);
  assert.match(intent, /INTENT_EXPIRED/);
  assert.doesNotMatch(intent, /Date.parse\(proposal.expiresAt\)/);
  assert.match(sponsor, /consent: true/);
  assert.match(sponsor, /method: 'DELETE'/);
  assert.match(review, /\/admin\/adventures/);
  assert.match(review, /versionId, npcId, ticks/);
  assert.doesNotMatch(review, /\/game\/campaigns/);
});

test('NPC countdowns do not invalidate command revisions but outcomes and positions do', async () => {
  const { semanticGameProjection } = await import('../../apps/api/src/game/projection-clock.ts');
  const p = {
    tick: 5,
    revision: 7,
    entities: [{ id: 'helper', x: 2, y: 3 }],
    npcObligations: [{ id: 'p', status: 'accepted', remainingTicks: 50 }],
  };
  assert.deepEqual(
    semanticGameProjection(p),
    semanticGameProjection({
      ...p,
      tick: 6,
      revision: 8,
      npcObligations: [{ ...p.npcObligations[0], remainingTicks: 49 }],
    }),
  );
  assert.notDeepEqual(
    semanticGameProjection(p),
    semanticGameProjection({
      ...p,
      npcObligations: [{ ...p.npcObligations[0], status: 'fulfilled' }],
    }),
  );
  assert.notDeepEqual(
    semanticGameProjection(p),
    semanticGameProjection({ ...p, entities: [{ id: 'helper', x: 3, y: 3 }] }),
  );
});

test('map focus boundary retains internal menu/inventory focus and stops only on genuine exit', async () => {
  const text = await readFile(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
    'game-canvas.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handler, stop;
  const walk = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onBlur')
      handler = node.initializer.expression.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'explicitStop')
      stop = node.initializer.getText(source);
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(handler && stop);
  for (const disabled of [false, true])
    for (const planning of [false, true]) {
      let stops = 0;
      const explicitStop = new Function('latest', 'planning', 'onStop', 'return (' + stop + ')')(
        { current: { disabled } },
        planning,
        () => stops++,
      );
      const blur = new Function('explicitStop', 'return (' + handler + ')')(explicitStop);
      const root = {},
        menuClose = {},
        take = {},
        inventory = {},
        external = {};
      const internal = new Set([root, menuClose, take, inventory]);
      const currentTarget = { contains: (node) => internal.has(node) };
      for (const relatedTarget of internal) blur({ currentTarget, relatedTarget });
      assert.equal(stops, 0, 'internal focus/return must not stop or mutate revision');
      blur({ currentTarget, relatedTarget: external });
      blur({ currentTarget, relatedTarget: null });
      explicitStop(); // The accessible Stop button retains exactly the same handler.
      assert.equal(stops, disabled || planning ? 0 : 3);
    }
});

test('generation admission errors explain recovery in every locale', async () => {
  const text = await readFile(new URL('../../apps/web/lib/client.tsx', import.meta.url), 'utf8');
  const source = ts.createSourceFile(
    'client.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const required = new Set([
    'GENERATION_POLICY_CHANGED',
    'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
    'GENERATION_PRICING_EXPIRED',
    'STORY_PLANNER_UNAVAILABLE',
  ]);
  const walk = (node) => {
    if (ts.isPropertyAssignment(node) && required.has(node.name.getText(source))) {
      assert.ok(ts.isStringLiteral(node.initializer));
      for (const locale of supportedLocales) {
        const message = dictionaries[locale][node.initializer.text];
        assert.ok(message, `${locale}: ${node.name.getText(source)}`);
        assert.doesNotMatch(message, /Попробуйте ещё раз/);
      }
      required.delete(node.name.getText(source));
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.equal(required.size, 0);
});

function withoutPassiveReleaseAuditKey(text) {
  const source = ts.createSourceFile(
    'adoption-guard.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.deepEqual(source.parseDiagnostics, []);
  const keys = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== 'actionLabels' ||
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      )
        continue;
      for (const property of declaration.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.name) &&
          property.name.text === 'generation.release-policy.refresh' &&
          ts.isStringLiteral(property.initializer)
        )
          keys.push([property.name.getStart(source), property.name.end]);
      }
    }
  }
  // Only the passive audit property's name is exempt. Its value and all imports,
  // controls, state and request paths remain subject to the original guard.
  for (const [start, end] of keys.reverse())
    text = text.slice(0, start) + "'passive-audit-event'" + text.slice(end);
  return text;
}
const manualAdoptionControl = /ReleasePolicyReview|release-policy|policyTarget/;
test('server profile updates do not expose manual account adoption controls', async () => {
  for (const file of ['admin.tsx', 'game/adventure-launch.tsx']) {
    const source = await readFile(
      new URL('../../apps/web/components/' + file, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(withoutPassiveReleaseAuditKey(source), manualAdoptionControl);
  }
});
test('manual adoption guard exempts only a passive audit key, never controls or request paths', () => {
  const passive = "const actionLabels = { 'generation.release-policy.refresh': 'Rules updated' };";
  assert.doesNotMatch(withoutPassiveReleaseAuditKey(passive), manualAdoptionControl);
  for (const source of [
    passive + 'const view = <ReleasePolicyReview />;',
    passive + "import { ReleasePolicyReview } from './review';",
    passive + 'const policyTarget = null;',
    passive + "api('/admin/live-test/release-policy', { method: 'POST' });",
    passive.replace('Rules updated', '/release-policy'),
    passive.replace('actionLabels', 'otherLabels'),
    "const actionLabels = { 'generation.release-policy.refresh': () => true };",
  ])
    assert.match(withoutPassiveReleaseAuditKey(source), manualAdoptionControl);
});

test('every browser new-campaign launch explicitly requests turns, never realtime', async () => {
  const root = new URL('../../apps/web/', import.meta.url);
  const launches = [];
  async function inspectDirectory(relative = '') {
    for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = relative + entry.name;
      if (entry.isDirectory()) {
        await inspectDirectory(file + '/');
        continue;
      }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(
        file,
        await readFile(new URL(file, root), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const property = (object, name) =>
        object.properties.find(
          (value) => ts.isPropertyAssignment(value) && value.name.getText(source) === name,
        )?.initializer;
      const walk = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'api' &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === '/game/campaigns'
        ) {
          const options = node.arguments[1];
          if (options && ts.isObjectLiteralExpression(options)) {
            const method = property(options, 'method');
            if (method && ts.isStringLiteral(method) && method.text === 'POST') {
              const body = property(options, 'body');
              assert.ok(body && ts.isCallExpression(body), file);
              assert.equal(body.expression.getText(source), 'JSON.stringify', file);
              const payload = body.arguments[0];
              assert.ok(ts.isObjectLiteralExpression(payload), file);
              assert.equal(property(payload, 'turnBased')?.kind, ts.SyntaxKind.TrueKeyword, file);
              launches.push(file);
            }
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
    }
  }
  await inspectDirectory();
  assert.deepEqual(launches.sort(), [
    'components/game/adventure-launch.tsx',
    'components/studio/playable-map-editor.tsx',
  ]);
});

test('Studio exposes physical rules without player quotas and preserves legacy drafts until an explicit edit', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/studio/turn-ruleset-editor.tsx', import.meta.url),
    'utf8',
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const contracts = await import('@dreamwalk/contracts');
  const runtime = await import('react/jsx-runtime');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const module = { exports: {} };
  const imports = {
    '@dreamwalk/contracts': contracts,
    'react/jsx-runtime': runtime,
    '../ui': { Field: 'label', Input: 'input' },
    '../game/turn-messages': { useTurnText: () => (key) => key },
    '../visual-authoring/workshop.module.css': { default: {} },
  };
  new Function('require', 'exports', 'module', js)(
    (name) => {
      assert.ok(Object.hasOwn(imports, name), name);
      return imports[name];
    },
    module.exports,
    module,
  );
  const descendants = (node) =>
    Array.isArray(node)
      ? node.flatMap(descendants)
      : node && typeof node === 'object'
        ? [node, ...descendants(node.props?.children)]
        : [];
  const defaults = contracts.turnRulesSchema.parse({});
  for (const value of [undefined, { ...defaults, movement: 9 }]) {
    const saved = structuredClone(value),
      changes = [];
    const tree = module.exports.TurnRulesetEditor({
      value,
      onChange: (next) => changes.push(next),
    });
    assert.deepEqual(changes, [], 'Opening an old draft must not save or convert anything');
    const html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /type="checkbox"|type="radio"|<select/);
    const inputs = descendants(tree).filter((node) => node.type === 'input');
    assert.equal(inputs.length, 3);
    assert.deepEqual(
      inputs.map((input) => input.props.value),
      ['vitality', 'hitDamage', 'pushDistance'].map((key) => (value ?? defaults)[key]),
    );
    assert.doesNotMatch(
      html,
      /movementSetting|mainActionsSetting|additionalActionsSetting|reactionsSetting/,
    );
    assert.ok(inputs.every((node) => node.props.type === 'number'));
    assert.equal(inputs[0].props.value, (value ?? defaults).vitality);
    for (const input of inputs) {
      input.props.onChange({ target: { value: String(input.props.max + 1) } });
      input.props.onChange({ target: { value: 'invalid' } });
    }
    assert.deepEqual(changes, []);
    inputs[0].props.onChange({ target: { value: '12' } });
    assert.deepEqual(changes, [{ ...(value ?? defaults), vitality: 12 }]);
    assert.deepEqual(value, saved);
  }
  const preview = module.exports.TurnRulesetEditor({
    disabled: true,
    onChange: () => assert.fail('Preview cannot edit rules'),
  });
  assert.match(renderToStaticMarkup(preview), /<fieldset[^>]*disabled/);
});
