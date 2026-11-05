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
  modelRejectionEvidenceHash: hash,
  exactModelRejectionEpoch: prove,
  MODEL_REJECTION_STOP: reason,
} = require('../../apps/api/src/image-generation/model-rejection-provenance.ts');
const job = { id: 'job', actor_id: 'actor', reservation_id: 'reserve', request_hash: 'request' };
const diagnostic = {
  httpStatus: 403,
  category: 'model_access',
  providerCode: 'model_not_found',
  providerType: 'invalid_request_error',
  requestId: 'req_native',
  evidence: 'provider_reported',
  billing: 'unknown',
};
const owner = {
  id: 'owner',
  scope_id: 'scope',
  policy_revision: 2,
  policy_hash: 'policy',
  config_hash: 'config',
};
const epoch = {
  id: '1',
  baseline_unknown: false,
  target_kind: 'authorization',
  target_id: owner.id,
};
const evidence = hash(job, 'dispatch', diagnostic);
const event = {
  epoch_id: '1',
  reason,
  cause_code: reason,
  stop_class: 'authorization',
  recoverable: false,
  source_kind: 'image',
  source_id: job.id,
  authorization_id: owner.id,
  scope_id: owner.scope_id,
  policy_revision: 2,
  policy_hash: 'policy',
  config_hash: 'config',
  evidence_hash: evidence,
};
test('exact native rejection is explicit-only and bounded identity is hash-bound', () => {
  assert.match(evidence, /^[a-f0-9]{64}$/);
  assert.equal(prove(epoch, [event], 'authorization', owner.id, owner, job.id, evidence), true);
  for (const key of Object.keys(job))
    assert.notEqual(hash({ ...job, [key]: 'other' }, 'dispatch', diagnostic), evidence);
  assert.notEqual(hash(job, 'other', diagnostic), evidence);
  assert.notEqual(hash(job, 'dispatch', { ...diagnostic, requestId: 'req_other' }), evidence);
  assert.notEqual(
    hash(job, 'dispatch', { ...diagnostic, providerCode: 'model_access_denied' }),
    evidence,
  );
  assert.equal(
    hash(job, 'dispatch', { ...diagnostic, message: 'raw secret not retained' }),
    evidence,
  );
});
for (const [key, value] of Object.entries({
  epoch_id: '2',
  reason: 'IMAGE_PROVIDER_ACCESS_OR_HTTP_FAILURE',
  cause_code: 'ADMIN_STOP',
  stop_class: 'request',
  recoverable: true,
  source_kind: 'npc',
  source_id: 'foreign',
  authorization_id: 'foreign',
  scope_id: 'foreign',
  policy_revision: 3,
  policy_hash: 'changed',
  config_hash: 'changed',
  evidence_hash: null,
}))
  test(`rejects conflicting ${key} even beside a valid event`, () =>
    assert.equal(
      prove(
        epoch,
        [event, { ...event, [key]: value }],
        'authorization',
        owner.id,
        owner,
        job.id,
        evidence,
      ),
      false,
    ));
test('historical, foreign, missing and oversized epoch proofs fail closed', () => {
  for (const e of [
    undefined,
    { ...epoch, baseline_unknown: true },
    { ...epoch, target_id: 'other' },
    { ...epoch, target_kind: 'scope' },
  ])
    assert.equal(prove(e, [event], 'authorization', owner.id, owner, job.id, evidence), false);
  for (const events of [[], Array(501).fill(event)])
    assert.equal(prove(epoch, events, 'authorization', owner.id, owner, job.id, evidence), false);
});
test('authentication, permission, quota, timeout and generic HTTP failures cannot obtain model proof', () => {
  for (const d of [
    null,
    { ...diagnostic, httpStatus: 401 },
    { ...diagnostic, httpStatus: 408 },
    { ...diagnostic, httpStatus: 500 },
    { ...diagnostic, providerCode: 'invalid_api_key' },
    { ...diagnostic, providerCode: 'permission_denied' },
    { ...diagnostic, providerCode: 'rate_limit_exceeded' },
    { ...diagnostic, requestId: undefined },
  ])
    assert.equal(hash(job, 'dispatch', d), undefined);
});
