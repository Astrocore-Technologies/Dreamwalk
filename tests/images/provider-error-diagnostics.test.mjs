import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const {
  safeImageErrorDiagnostic,
  normalizeSafeImageDiagnostic,
  ImageProviderFailure,
} = require('../../apps/api/dist/image-generation/error-diagnostics.js');
const { OpenAiImageProvider } = require('../../apps/api/dist/image-generation/provider.js');
const response = (error, headers = {}) =>
  new Response(JSON.stringify({ error }), {
    status: 403,
    headers: { 'x-request-id': 'req_synthetic_403', ...headers },
  });
test('403 allowlisted provider reports retain safe category, never raw echoes or asserted billing', async () => {
  for (const [code, category] of [
    ['organization_verification_required', 'organization_verification'],
    ['model_not_found', 'model_access'],
    ['insufficient_permissions', 'permission_scope'],
  ]) {
    const diagnostic = await safeImageErrorDiagnostic(
      response({
        code,
        type: 'invalid_request_error',
        message: 'PRIVATE_PROMPT sk-synthetic-private Bearer synthetic-secret org-private-123',
      }),
    );
    assert.equal(diagnostic.httpStatus, 403);
    assert.equal(diagnostic.requestId, 'req_synthetic_403');
    assert.equal(diagnostic.providerCode, code);
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.evidence, 'provider_reported');
    assert.equal(diagnostic.billing, 'unknown');
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /PRIVATE_PROMPT|synthetic-private|synthetic-secret|org-private/,
    );
  }
});
test('unknown, malformed, oversized and malicious error text fail closed without raw data', async () => {
  for (const value of [
    response(
      { code: 'sk-private', type: 'PRIVATE_PROMPT', message: 'my private invented scene' },
      { 'x-request-id': 'Bearer private' },
    ),
    new Response('<private html>', { status: 403 }),
    new Response('x'.repeat(9000), { status: 403 }),
    new Response(JSON.stringify({ error: ['private'] }), { status: 403 }),
  ]) {
    const diagnostic = await safeImageErrorDiagnostic(value);
    assert.deepEqual(Object.keys(diagnostic).sort(), ['billing', 'evidence', 'httpStatus']);
  }
  const sanitized = normalizeSafeImageDiagnostic({
    httpStatus: 403,
    category: 'model_access',
    message: 'PRIVATE_PROMPT',
    rawBody: 'secret',
    requestId: 'Bearer secret',
    providerCode: 'secret',
    billing: 'free',
  });
  assert.equal(
    sanitized.message,
    'The provider reports that the requested model is unavailable or inaccessible.',
  );
  assert.equal(sanitized.billing, 'unknown');
  assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE_PROMPT|secret|rawBody|free/);
  assert.equal(normalizeSafeImageDiagnostic({ httpStatus: '403' }), undefined);
});
test('actual image adapter keeps one 403 dispatch uncertain and exposes only safe diagnosis', async () => {
  let calls = 0;
  const provider = new OpenAiImageProvider({
    enabled: true,
    apiKey: 'synthetic-no-network',
    verifiedUpperMicros: 1000000,
    networkApproved: true,
    model: 'gpt-image-2.5-sunburst-2026-09-08',
    inputTextMicrosPerMillion: 1,
    inputImageMicrosPerMillion: 1,
    outputImageMicrosPerMillion: 1,
    fetchImpl: async () => {
      calls++;
      return response({
        code: 'permission_denied',
        type: 'permission_error',
        message: 'PRIVATE_PROMPT and Bearer synthetic-no-network',
      });
    },
  });
  const input = {
    adventureId: randomUUID(),
    prompt: 'PRIVATE_PROMPT',
    title: 'Synthetic',
    kind: 'background',
    camera: 'top-down',
    tags: [],
    background: 'opaque',
    referenceRevisionIds: [],
    mode: 'external',
    declineReuse: true,
    rights: {
      basis: 'generated',
      licenseLabel: 'Synthetic',
      attribution: 'Synthetic',
      allowAuthorReuse: true,
      attested: true,
    },
  };
  await assert.rejects(provider.generate(input, randomUUID(), []), (e) => {
    assert.ok(e instanceof ImageProviderFailure);
    assert.equal(e.outcomeUnknown, true);
    assert.equal(e.message, 'PROVIDER_RESULT_UNKNOWN');
    assert.equal(e.diagnostic.category, 'permission_scope');
    assert.doesNotMatch(JSON.stringify(e), /PRIVATE_PROMPT|synthetic-no-network/);
    return true;
  });
  assert.equal(calls, 1);
});

test('recognized code outranks conflicting echoed prose and key-like request receipts are withheld', async () => {
  const diagnostic = await safeImageErrorDiagnostic(
    response(
      {
        code: 'invalid_api_key',
        type: 'authentication_error',
        message: 'PRIVATE_PROMPT says organization must be verified; sk-private',
      },
      { 'x-request-id': 'req_sk-private-credential' },
    ),
  );
  assert.equal(diagnostic.category, 'authentication');
  assert.equal(diagnostic.requestId, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PROMPT|sk-private|organization/);
  assert.equal(
    normalizeSafeImageDiagnostic({ httpStatus: 403, requestId: 'req_sk-private' }).requestId,
    undefined,
  );
});
