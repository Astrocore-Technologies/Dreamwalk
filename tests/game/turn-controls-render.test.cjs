const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
test('End turn remains visible and correctly disabled during world/reaction and other-player phases', () => {
  const source = readFileSync('apps/web/components/game/turn-controls.tsx', 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const load = (name) =>
    name === 'react/jsx-runtime'
      ? require(name)
      : name === '../ui'
        ? { Button: ({ busy: _busy, ...props }) => React.createElement('button', props) }
        : name === './spatial-recovery'
          ? { isSpatialRecoveryRequired: () => false }
          : name === './turn-messages'
            ? { useTurnText: () => (key) => (key === 'end' ? 'End turn' : key) }
            : name.endsWith('.css')
              ? { __esModule: true, default: {} }
              : require(name);
  new Function('require', 'exports', 'module', js)(load, module.exports, module);
  for (const [phase, ownTurn, disabled] of [
    ['player', true, false],
    ['world', false, true],
    ['reaction', false, true],
    ['player', false, true],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(module.exports.TurnControls, {
        projection: {
          actorId: 'alice',
          entities: [],
          turn: {
            phase,
            ownTurn,
            roundNumber: 1,
            phaseEpoch: 1,
            resources: {},
            pendingNpcReplies: [],
          },
        },
        connected: true,
        busy: false,
        onEnd() {},
        onReaction() {},
      }),
    );
    assert.match(html, />End turn<\/button>/);
    assert.doesNotMatch(html, /<dl|<dd|movement|additional|reactionResource/);
    assert.equal(/<button[^>]*disabled/.test(html), disabled, phase);
  }
});
