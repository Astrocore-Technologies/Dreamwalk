/** Source-backed, no provider or production database. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recoverableStopEpoch,
} = require('../../apps/api/src/generation/verified-access-recovery.ts');
const {
  withGenerationStop,
  countFailureCode,
  nativeRequestStop,
} = require('../../apps/api/src/generation/stop-provenance.ts');
const auth = {
  id: 'authorization',
  scope_id: 'scope',
  policy_revision: 2,
  policy_hash: 'policy',
  config_hash: 'config',
};
const epoch = { id: '31', baseline_unknown: false, target_kind: 'scope', target_id: 'scope' };
const event = {
  epoch_id: '31',
  recoverable: true,
  stop_class: 'request',
  reason: 'IMAGE_RESULT_UNKNOWN',
  authorization_id: auth.id,
  scope_id: auth.scope_id,
  policy_revision: 2,
  policy_hash: 'policy',
  config_hash: 'config',
  source_kind: 'image',
  source_id: 'job',
};
const eligible = (e = epoch, events = [event], a = auth) =>
  recoverableStopEpoch(e, events, 'scope', 'scope', a);
test('only clean source-bound current-policy epoch is eligible', () =>
  assert.equal(eligible(), true));
test('historically blocked plus new recoverable assignment cannot manufacture clean baseline', () => {
  assert.equal(eligible({ ...epoch, baseline_unknown: true }), false);
  assert.equal(eligible(undefined, []), false);
});
test('every unrelated or repeated stop veto survives later recoverable events', () => {
  for (const reason of [
    'ADMIN_STOP',
    'SECURITY_DENIED',
    'IMAGE_PROVIDER_ACCESS_OR_HTTP_FAILURE',
    'PROVIDER_DEADLINE_EXCEEDED',
    'COST_BOUND_EXCEEDED',
    'DATA_ERASED',
    'AUTHORIZATION_REVOKED',
    'UNATTRIBUTED_STOP',
  ]) {
    assert.equal(
      eligible(epoch, [event, { ...event, reason, recoverable: false }, event]),
      false,
      reason,
    );
    assert.equal(eligible(epoch, [{ ...event, reason, recoverable: true }]), false, reason);
  }
});
test('source ownership, epoch, scope and policy never inherited from another assignment', () => {
  for (const change of [
    { epoch_id: '32' },
    { authorization_id: 'other' },
    { scope_id: 'other' },
    { policy_revision: 3 },
    { policy_hash: 'other' },
    { config_hash: 'other' },
    { source_kind: 'reservation' },
    { source_id: null },
    { recoverable: null },
  ])
    assert.equal(eligible(epoch, [{ ...event, ...change }]), false, JSON.stringify(change));
  assert.equal(eligible({ ...epoch, target_id: 'other' }), false);
  assert.equal(eligible({ ...epoch, target_kind: 'authorization' }), false);
});
test('transaction-local stop context is restored after success and failure', async () => {
  for (const fail of [false, true]) {
    let current = 'prior';
    const writes = [];
    const c = {
      query: async (sql, args) => {
        if (sql.includes('current_setting')) return { rows: [{ value: current }] };
        current = args[0];
        writes.push(current);
        return { rows: [] };
      },
    };
    const action = withGenerationStop(
      c,
      {
        authorizationId: 'a',
        sourceKind: 'image',
        sourceId: 'j',
        reason: 'IMAGE_RESULT_UNKNOWN',
        recoverable: true,
      },
      async () => {
        assert.equal(JSON.parse(current).sourceId, 'j');
        if (fail) throw new Error('fixture');
        return 7;
      },
    );
    if (fail) await assert.rejects(action, /fixture/);
    else assert.equal(await action, 7);
    assert.equal(current, 'prior');
    assert.equal(writes.length, 2);
  }
});

test('count credential, HTTP and invalid-response failures never collapse to uncertainty', () => {
  for (const code of [
    'TEXT_COUNT_OUTCOME_UNKNOWN',
    'TEXT_COUNT_CREDENTIAL_REQUIRED',
    'TEXT_COUNT_HTTP_ERROR',
    'TEXT_COUNT_INVALID_RESPONSE',
    'PROVIDER_HTTP_403',
  ])
    assert.equal(countFailureCode(new Error(code)), code);
  assert.equal(
    countFailureCode(new Error('arbitrary provider failure')),
    'UNATTRIBUTED_TEXT_COUNT_FAILURE',
  );
});

test('native request timeout/cancel is typed separately from authorization expiry and security', () => {
  for (const cause of [
    'PROVIDER_TIMEOUT',
    'PROVIDER_DEADLINE_EXCEEDED',
    'IMAGE_PROVIDER_DEADLINE_EXCEEDED',
    'TEXT_COUNT_DEADLINE_EXCEEDED',
    'PROVIDER_CANCELLED_IN_FLIGHT',
    'PROVIDER_RESERVATION_EXPIRED',
    'PROVIDER_FINALIZED_IN_FLIGHT',
  ]) {
    const stop = nativeRequestStop(cause);
    assert.equal(stop.stopClass, 'request');
    assert.equal(stop.recoverable, true);
    assert.equal(stop.causeCode, cause);
    assert.equal(eligible(epoch, [{ ...event, reason: stop.reason }]), true);
    assert.equal(
      eligible(epoch, [{ ...event, reason: stop.reason, stop_class: 'authorization' }]),
      false,
    );
  }
  for (const cause of [
    'AUTHORIZATION_EXPIRED',
    'USER_STOP_ALL',
    'ADMIN_STOP',
    'SECURITY_DENIED',
    'IMAGE_PROVIDER_ACCESS_OR_HTTP_FAILURE',
    'COST_BOUND_EXCEEDED',
    'ERASED',
  ])
    assert.equal(nativeRequestStop(cause).recoverable, false, cause);
});
