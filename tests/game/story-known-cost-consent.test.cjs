process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { readFileSync } = require('node:fs'),
  ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const {
  acceptStoryKnownCostPolicy,
  acceptedStoryKnownCostPolicy,
} = require('../../apps/api/src/game/story-known-cost-consent.ts');
const quote = () => ({
  id: 'native-quote',
  automaticKnownCostPolicy: 'known-cost-v1',
  providerReserveMicros: 120,
  expiresAt: '2026-11-01',
});
test('only explicit original story confirmation creates quote-bound policy authority', () => {
  const q = quote(),
    before = JSON.stringify(q);
  assert.equal(acceptStoryKnownCostPolicy(q, 'turn', undefined), undefined);
  const receipt = acceptStoryKnownCostPolicy(q, 'turn', 'known-cost-v1');
  assert.equal(acceptedStoryKnownCostPolicy(q, 'turn', receipt), 'known-cost-v1');
  assert.equal(JSON.stringify(q), before);
  assert.equal(acceptedStoryKnownCostPolicy(q, 'other-turn', receipt), undefined);
  assert.equal(acceptedStoryKnownCostPolicy({ ...q, id: 'other' }, 'turn', receipt), undefined);
  assert.equal(
    acceptedStoryKnownCostPolicy({ ...q, providerReserveMicros: 121 }, 'turn', receipt),
    undefined,
  );
  assert.equal(
    acceptedStoryKnownCostPolicy(q, 'turn', { ...receipt, version: 'other' }),
    undefined,
  );
});
test('legacy and free quotes never acquire authority from new client assertion', () => {
  assert.throws(
    () => acceptStoryKnownCostPolicy({ id: 'legacy' }, 'turn', 'known-cost-v1'),
    (e) => e.getResponse?.().code === 'GENERATION_SETTLEMENT_POLICY_MISMATCH',
  );
  assert.equal(acceptedStoryKnownCostPolicy(quote(), 'turn', undefined), undefined);
});
test('story acknowledgment persists outside provider context and is verified before internal queue', () => {
  const source = readFileSync(
    require.resolve('../../apps/api/src/game/story-turn-runtime.ts'),
    'utf8',
  );
  assert.match(
    source,
    /quote_result=quote_result\|\|jsonb_build_object\('automaticKnownCostAcceptance'/,
  );
  assert.match(source, /automaticKnownCostPolicy: acceptedStoryKnownCostPolicy\(/);
  assert.match(source, /reply\.automaticKnownCostAcceptance/);
  assert.match(source, /frozenReply\?\.automaticKnownCostPolicy/);
  assert.match(source, /replyRecovery: \{[\s\S]*?automaticKnownCostAcceptance: policyAcceptance/);
  assert.doesNotMatch(source, /context: \{ automaticKnownCostPolicy/);
  const game = readFileSync(require.resolve('../../apps/api/src/game/game.service.ts'), 'utf8');
  assert.match(game, /quotedReply\?\.automaticKnownCostPolicy/);
});
