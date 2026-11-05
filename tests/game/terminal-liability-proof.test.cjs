/** Source-transpiled synthetic fixtures; no database, provider, build or writes. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
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
const { digest } = require('../../apps/api/src/ai/context.ts');
const { providerMicrosToSparkSubunits } = require('@dreamwalk/contracts');
const {
  proveTerminalLiabilitySnapshot: prove,
  proveTerminalScopeLiabilities,
} = require('../../apps/api/src/generation/terminal-liability-proof.ts');
function fixtures(file, names) {
  const filename = path.join(__dirname, file),
    m = new Module(filename, module);
  m.filename = filename;
  m.paths = module.paths;
  const original = m.require.bind(m);
  m.require = (name) =>
    name === 'node:test' ? () => {} : original(name.replace('/dist/', '/src/'));
  m._compile(
    fs.readFileSync(filename, 'utf8') + `\nmodule.exports = { ${names.join(',')} };`,
    filename,
  );
  return m.exports;
}
const text = fixtures('known-text-settlement.test.cjs', ['countFixture', 'permitFixture', 'split']);
const image = fixtures('known-image-settlement.test.cjs', ['fixture']);
const authoring = fixtures('known-authoring-settlement.test.cjs', ['fixture', 'addDreams']);
const npc = fixtures('known-npc-settlement.test.cjs', ['automaticFixture']);
function snapshot(kind, split = false, pending = false) {
  const f =
    kind === 'count'
      ? text.countFixture()
      : kind === 'permit'
        ? text.permitFixture()
        : kind === 'image'
          ? image.fixture(split)
          : kind === 'authoring'
            ? authoring.fixture()
            : npc.automaticFixture();
  if (split && ['count', 'permit'].includes(kind)) text.split(f);
  if (split && kind === 'authoring') authoring.addDreams(f);
  const a = f.authorization,
    h = f.funding?.hold ?? f.hold,
    q = f.funding?.quote ?? f.quote,
    dreams = f.funding?.dreams ?? f.dreams;
  const s = {
    scope: {
      id: a.scope_id,
      approved: true,
      unlimited_allowance: false,
      total_cap_micros: '1000000',
      text_cap_micros: '1000000',
      image_cap_micros: '1000000',
    },
    authorizations: [a],
    reservations: [f.reservation],
  };
  for (const key of [
    'counts',
    'permits',
    'npcJobs',
    'npcQuotes',
    'authoringJobs',
    'authoringQuotes',
    'imageJobs',
    'imageQuotes',
    'imageAttempts',
    'recoveries',
    'requests',
    'batches',
    'audits',
    'providerBudgets',
    'sparkWallets',
    'sparkHolds',
    'sparkQuotes',
    'sparkLedger',
    'dreamWallets',
    'dreamHolds',
    'dreamQuotes',
    'dreamLedger',
  ])
    s[key] = [];
  let id;
  if (kind === 'count') {
    s.counts.push(f.job);
    id = f.job.id;
  }
  if (kind === 'permit') {
    s.permits.push(f.permit);
    s.npcJobs.push(f.npc);
    s.requests.push(f.request);
    f.npc.provider_id = 'fixture-provider';
    id = f.permit.id;
  }
  if (kind === 'image') {
    s.imageJobs.push(f.job);
    s.imageQuotes.push(f.native);
    s.imageAttempts.push(f.attempt);
    id = f.job.id;
  }
  if (kind === 'authoring') {
    s.authoringJobs.push(f.job);
    s.authoringQuotes.push(f.native);
    id = f.job.id;
  }
  if (kind === 'npc') {
    s.npcJobs.push(f.job);
    s.npcQuotes.push(f.native);
    id = f.job.id;
  }
  for (const j of s.npcJobs)
    s.providerBudgets.push({
      provider_id: j.provider_id,
      blocked: false,
      unlimited_allowance: false,
      cap_micros: '1000000',
      reserved_micros: '0',
      unknown_micros: '0',
      overrun_micros: '0',
      spent_micros: j.provider_actual_micros,
    });
  const receipt = {
    outcome: 'success',
    actualMicros: String(f.reservation.actual_micros),
    evidence: 'configured_rates',
    receiptId: kind === 'npc' ? `automatic-npc-settlement:${id}` : `${kind}:${id}`,
  };
  const reserve = BigInt(h.reserved_subunits),
    sparkReserve = BigInt(h.sparks_reserved_subunits ?? h.reserved_subunits),
    dreamReserve = reserve - sparkReserve;
  const capture = BigInt(
      providerMicrosToSparkSubunits(receipt.actualMicros, q.price_snapshot.tariff.sparkRateVersion),
    ),
    dreamCapture = capture < dreamReserve ? capture : dreamReserve;
  const install = (prefix, hold, quote, reserved, captured, receipt) => {
    hold.settled_at = pending ? null : new Date('2026-10-01');
    hold.status = pending
      ? 'pending'
      : BigInt(hold.reserved_subunits) === reserve && prefix === 'spark'
        ? capture === 0n
          ? 'released'
          : 'settled'
        : captured === 0n
          ? 'released'
          : 'settled';
    hold.reason = pending ? (prefix === 'spark' ? 'failure_policy_pending' : 'unknown') : null;
    hold.captured_subunits = pending ? null : (prefix === 'spark' ? capture : captured).toString();
    hold.settlement_fingerprint = pending ? null : digest(receipt);
    s[prefix + 'Holds'].push(hold);
    s[prefix + 'Quotes'].push(quote);
    s[prefix + 'Wallets'].push({
      owner_id: a.owner_id,
      held_subunits: pending ? reserved.toString() : '0',
      balance_subunits: (1000000n - (pending ? 0n : captured)).toString(),
    });
    const ledger = s[prefix + 'Ledger'];
    ledger.push({
      owner_id: a.owner_id,
      hold_id: null,
      event_key: 'grant',
      kind: 'starter_grant',
      amount_subunits: '1000000',
      evidence: {},
    });
    ledger.push({
      owner_id: a.owner_id,
      hold_id: hold.id,
      event_key: `reserve:${hold.id}`,
      kind: 'reserve',
      amount_subunits: reserved.toString(),
      evidence: {},
    });
    if (pending) {
      const evidence = {
        outcome: prefix === 'spark' ? 'failure_policy_pending' : 'unknown',
        receiptId: kind === 'npc' ? `failure:${id}` : `${kind}:${id}`,
      };
      ledger.push({
        owner_id: a.owner_id,
        hold_id: hold.id,
        event_key: `pending:${hold.id}:${digest(evidence)}`,
        kind: 'pending',
        amount_subunits: reserved.toString(),
        evidence,
      });
    } else
      for (const [kind, amount] of [
        ['capture', captured],
        ['release', reserved - captured],
      ])
        ledger.push({
          owner_id: a.owner_id,
          hold_id: hold.id,
          event_key: `${kind}:${hold.id}`,
          kind,
          amount_subunits: amount.toString(),
          evidence: receipt,
        });
  };
  install('spark', h, q, sparkReserve, capture - dreamCapture, receipt);
  if (dreams)
    install('dream', dreams.hold, dreams.quote, dreamReserve, dreamCapture, {
      outcome: 'success',
      actualSubunits: dreamCapture.toString(),
      evidence: 'configured_rates',
      policyVersion: 'dreams-first-v1',
      receiptId: receipt.receiptId,
    });
  return s;
}
for (const kind of ['count', 'permit', 'image', 'authoring', 'npc']) {
  test(`${kind} exact terminal native receipt is eligible without writes`, () => {
    const s = snapshot(kind),
      before = digest(s),
      result = prove(s);
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(digest(s), before);
    assert.equal(result.evidence.verifiedSources[0].kind, kind);
  });
  test(`${kind} retained fully funded known bill requires explicit proof mode`, () => {
    const s = snapshot(kind, false, true);
    assert.equal(prove(s).code, `${kind.toUpperCase()}_KNOWN_FULLY_FUNDED_PENDING`);
    const result = prove(s, { allowRetainedFullyFundedPending: true });
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(result.evidence.retainedSourceIds.length, 1);
  });
}
for (const kind of ['count', 'permit', 'image', 'authoring'])
  test(`${kind} exact Dreams-first split is proved`, () => {
    const s = snapshot(kind, true);
    assert.equal(prove(s).eligible, true, JSON.stringify(prove(s)));
    s.dreamHolds[0].settlement_fingerprint = 'altered';
    assert.equal(prove(s).eligible, false);
  });
for (const [name, mutate] of [
  ['hold fingerprint', (s) => (s.sparkHolds[0].settlement_fingerprint = 'changed')],
  ['capture amount', (s) => (s.sparkHolds[0].captured_subunits = '1')],
  [
    'release ledger',
    (s) => (s.sparkLedger.find((l) => l.kind === 'release').amount_subunits = '9'),
  ],
  ['extra ledger', (s) => s.sparkLedger.push({ ...s.sparkLedger[1] })],
  ['wallet held', (s) => (s.sparkWallets[0].held_subunits = '1')],
  ['wallet balance', (s) => (s.sparkWallets[0].balance_subunits = '1')],
  ['orphan reservation', (s) => s.reservations.push({ ...s.reservations[0], id: 'orphan' })],
  ['untrusted count', (s) => (s.counts[0].input_tokens = '9007199254740992')],
  ['erased count', (s) => (s.counts[0].error_code = 'DATA_ERASED')],
  [
    'global unknown count',
    (s) => s.counts.push({ id: 'foreign', scope_id: 'other', status: 'unknown' }),
  ],
  ['overrun', (s) => (s.reservations[0].actual_micros = '1001')],
  ['null cap', (s) => (s.scope.total_cap_micros = null)],
  ['cap exceeded', (s) => (s.scope.total_cap_micros = '999')],
])
  test(`fails closed: ${name}`, () => {
    const s = snapshot('count');
    mutate(s);
    assert.equal(prove(s).eligible, false);
  });
test('retained unknown ledger corruption cannot hide behind valid pending entry', () => {
  const s = snapshot('count', true, true);
  s.sparkLedger.push({ ...s.sparkLedger.at(-1), event_key: 'invalid' });
  assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, false);
});
test('generated but unadmitted image remains work, not a cleared liability', () => {
  const s = snapshot('image');
  s.imageJobs[0].status = 'generated';
  assert.equal(prove(s).code, 'IMAGE_NOT_TERMINAL');
});
test('source denial cannot hide behind an ordinary result code', () => {
  const s = snapshot('image');
  s.imageJobs[0].result_code = 'OK';
  s.imageJobs[0].error_code = 'AUTHORIZATION_REVOKED';
  assert.equal(prove(s).code, 'IMAGE_SOURCE_RESTRICTED');
});
test('legacy provider blocked or unexplained spent ledger blocks reopening', () => {
  const s = snapshot('permit');
  s.providerBudgets[0].blocked = true;
  assert.equal(prove(s).code, 'NPC_PROVIDER_LEDGER_UNRESOLVED');
  s.providerBudgets[0].blocked = false;
  s.providerBudgets[0].spent_micros = '501';
  assert.equal(prove(s).code, 'NPC_PROVIDER_LEDGER_UNRESOLVED');
});
test('wrapper bounds every read and uses only NOWAIT source/wallet locks', async () => {
  const queries = [];
  const c = {
    query: async (sql) => {
      queries.push(sql);
      return {
        rows: sql.includes('FROM users WHERE id=$1') ? [{ id: 'owner', deleted_at: null }] : [],
      };
    },
  };
  await proveTerminalScopeLiabilities(c, { id: 'scope' }, [
    { id: 'auth', owner_id: 'owner', scope_id: 'scope' },
  ]);
  assert.ok(queries.every((q) => q.startsWith('SELECT ') && q.includes('LIMIT 501')));
  assert.ok(queries.filter((q) => /FOR (SHARE|UPDATE)/.test(q)).every((q) => q.endsWith('NOWAIT')));
  assert.deepEqual(
    queries.filter((q) => q.includes('FOR UPDATE')).map((q) => q.match(/FROM (\w+)/)[1]),
    ['spark_wallets', 'dream_wallets'],
  );
});

test('bounded wrapper returns honest overflow, never a partial proof', async () => {
  const c = {
    query: async () => ({ rows: Array.from({ length: 501 }, (_, i) => ({ id: String(i) })) }),
  };
  assert.equal(
    (
      await proveTerminalScopeLiabilities(c, { id: 'scope' }, [
        { id: 'auth', owner_id: 'owner', scope_id: 'scope' },
      ])
    ).code,
    'PROOF_SIZE_LIMIT',
  );
});
test('NOWAIT contention propagates for transaction rollback rather than hiding an aborted transaction', async () => {
  const error = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const c = {
    query: async () => {
      throw error;
    },
  };
  await assert.rejects(
    () =>
      proveTerminalScopeLiabilities(c, { id: 'scope' }, [
        { id: 'auth', owner_id: 'owner', scope_id: 'scope' },
      ]),
    (e) => e === error,
  );
});

test('historical unmarked fixed count remains fully reserved without capture authority', () => {
  const s = snapshot('count', true, true);
  delete s.sparkQuotes[0].price_snapshot.providerQuote.automaticKnownCostPolicy;
  delete s.sparkQuotes[0].price_snapshot.providerQuote.automaticKnownCostAcceptance;
  s.dreamQuotes[0].price_snapshot.providerQuote.priceSnapshot = structuredClone(
    s.sparkQuotes[0].price_snapshot,
  );
  const before = digest(s);
  assert.equal(prove(s).code, 'COUNT_KNOWN_FULLY_FUNDED_PENDING');
  assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, true);
  assert.equal(digest(s), before);
});
for (const kind of ['permit', 'image', 'authoring'])
  test(`${kind} retained split retains both exact funds`, () => {
    const s = snapshot(kind, true, true);
    assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, true);
    s.dreamWallets[0].held_subunits = '0';
    assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, false);
  });
test('foreign legacy spent job without trusted usage is still a shared liability', () => {
  const s = snapshot('permit');
  const j = {
    ...s.npcJobs[0],
    id: 'foreign',
    generation_authorization_id: 'foreign',
    provider_usage: null,
  };
  s.npcJobs.push(j);
  s.providerBudgets[0].spent_micros = '1000';
  assert.equal(prove(s).code, 'NPC_PROVIDER_LEDGER_UNRESOLVED');
});
test('unlimited shape is explicit, never inferred from missing caps', () => {
  const s = snapshot('count');
  Object.assign(s.scope, {
    unlimited_allowance: true,
    total_cap_micros: null,
    text_cap_micros: null,
    image_cap_micros: null,
  });
  assert.equal(prove(s).code, 'SCOPE_UNLIMITED_SHAPE_INVALID');
  Object.assign(s.authorizations[0], {
    unlimited_allowance: true,
    cap_micros: null,
    text_cap_micros: null,
    image_cap_micros: null,
  });
  assert.equal(prove(s).eligible, true);
});

test('own late unknown count must independently prove its exact completed receipt', () => {
  const s = snapshot('count');
  s.counts[0].status = 'unknown';
  assert.equal(prove(s).eligible, true);
  s.counts[0].actual_micros = null;
  assert.equal(prove(s).eligible, false);
});
test('own known-funded late count remains retained without altering source status or tokens', () => {
  const s = snapshot('count', false, true);
  s.counts[0].status = 'unknown';
  const before = digest(s);
  assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, true);
  assert.equal(digest(s), before);
  s.counts[0].completed_at = null;
  assert.equal(prove(s, { allowRetainedFullyFundedPending: true }).eligible, false);
});

test('exact immutable request deadline permission only allows discarded verified source', () => {
  const s = snapshot('image');
  s.imageJobs[0].error_code = 'IMAGE_PROVIDER_DEADLINE_EXCEEDED';
  assert.equal(prove(s).eligible, false);
  const option = {
    allowedRequestStops: [
      { kind: 'image', id: s.imageJobs[0].id, causeCode: 'IMAGE_PROVIDER_DEADLINE_EXCEEDED' },
    ],
  };
  assert.equal(prove(s, option).eligible, true);
  s.imageJobs[0].status = 'admitted';
  assert.equal(prove(s, option).eligible, false);
  s.imageJobs[0].status = 'rejected';
  s.imageJobs[0].error_code = 'GENERATION_AUTHORIZATION_DEADLINE_EXCEEDED';
  assert.equal(prove(s, option).eligible, false);
});
test('permit deadline permission proves linked discarded provider status, not merely settled permit', () => {
  const s = snapshot('permit');
  s.permits[0].result_code = 'PROVIDER_DEADLINE_EXCEEDED';
  s.npcJobs[0].result_code = 'PROVIDER_DEADLINE_EXCEEDED';
  const option = {
    allowedRequestStops: [
      { kind: 'permit', id: s.permits[0].id, causeCode: 'PROVIDER_DEADLINE_EXCEEDED' },
    ],
  };
  assert.equal(prove(s).eligible, false);
  const result = prove(s, option);
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.evidence.verifiedSources[0].providerJobStatus, 'failed');
  s.npcJobs[0].status = 'committed';
  assert.equal(prove(s, option).eligible, false);
});
test('wrong source/cause permission cannot clear a timeout', () => {
  const s = snapshot('authoring');
  s.authoringJobs[0].error_code = 'PROVIDER_TIMEOUT';
  assert.equal(
    prove(s, {
      allowedRequestStops: [{ kind: 'authoring', id: 'other', causeCode: 'PROVIDER_TIMEOUT' }],
    }).eligible,
    false,
  );
  assert.equal(
    prove(s, {
      allowedRequestStops: [
        { kind: 'authoring', id: s.authoringJobs[0].id, causeCode: 'PROVIDER_DEADLINE_EXCEEDED' },
      ],
    }).eligible,
    false,
  );
});

for (const status of ['unknown', 'over_context'])
  test(`exact scoped late ${status} count request deadline requires proven native receipt`, () => {
    const s = snapshot('count');
    s.counts[0].status = status;
    s.counts[0].result_code = 'TEXT_COUNT_DEADLINE_EXCEEDED';
    const options = {
      allowedRequestStops: [
        { kind: 'count', id: s.counts[0].id, causeCode: 'TEXT_COUNT_DEADLINE_EXCEEDED' },
      ],
    };
    assert.equal(prove(s).eligible, false);
    const before = digest(s);
    assert.equal(prove(s, options).eligible, true);
    assert.equal(digest(s), before);
    for (const mutate of [
      (j) => (j.actual_micros = null),
      (j) => (j.input_tokens = null),
      (j) => (j.completed_at = null),
      (j) => (j.error_code = 'AUTHORIZATION_REVOKED'),
    ]) {
      const invalid = structuredClone(s);
      mutate(invalid.counts[0]);
      assert.equal(prove(invalid, options).eligible, false);
    }
    const wrong = {
      allowedRequestStops: [
        { kind: 'count', id: 'foreign', causeCode: 'TEXT_COUNT_DEADLINE_EXCEEDED' },
      ],
    };
    assert.equal(prove(s, wrong).eligible, false);
  });
test('matching request cause never exempts an unknown non-count source', () => {
  const s = snapshot('image');
  s.imageJobs[0].status = 'unknown';
  s.imageJobs[0].error_code = 'IMAGE_PROVIDER_DEADLINE_EXCEEDED';
  assert.equal(
    prove(s, {
      allowedRequestStops: [
        { kind: 'image', id: s.imageJobs[0].id, causeCode: 'IMAGE_PROVIDER_DEADLINE_EXCEEDED' },
      ],
    }).eligible,
    false,
  );
});

for (const split of [false, true])
  test(`audited terminal authoring preserves original pending identity (${split ? 'split' : 'Sparks'})`, () => {
    const s = snapshot('authoring', split);
    const job = s.authoringJobs[0],
      hold = s.sparkHolds[0];
    const operationId = job.operation_id;
    const receiptId = `owner-authoring-settlement:${operationId}`;
    s.audits.push({
      actor_id: job.actor_id,
      target_id: job.id,
      action: 'authoring.known_failure.settled',
      details: {
        operationId,
        holdId: hold.id,
        actualMicros: String(job.actual_micros),
        captureSubunits: hold.captured_subunits,
        releaseSubunits: (
          BigInt(hold.reserved_subunits) - BigInt(hold.captured_subunits)
        ).toString(),
      },
    });
    for (const prefix of split ? ['spark', 'dream'] : ['spark']) {
      const h = s[prefix + 'Holds'][0],
        ledger = s[prefix + 'Ledger'];
      for (const entry of ledger.filter((e) => ['capture', 'release'].includes(e.kind)))
        entry.evidence = { ...entry.evidence, receiptId };
      h.settlement_fingerprint = digest(ledger.find((e) => e.kind === 'capture').evidence);
      const evidence = {
        outcome: prefix === 'spark' ? 'failure_policy_pending' : 'unknown',
        receiptId: `authoring:${job.id}`,
      };
      ledger.push({
        owner_id: h.owner_id,
        hold_id: h.id,
        kind: 'pending',
        event_key: `pending:${h.id}:${digest(evidence)}`,
        amount_subunits: prefix === 'spark' ? h.sparks_reserved_subunits : h.reserved_subunits,
        evidence,
      });
    }
    const before = digest(s),
      result = prove(s);
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(digest(s), before);
    const forged = structuredClone(s),
      pending = forged.sparkLedger.find((e) => e.kind === 'pending');
    pending.evidence.receiptId = 'authoring:unrelated-source';
    pending.event_key = `pending:${hold.id}:${digest(pending.evidence)}`;
    assert.equal(prove(forged).eligible, false);
    if (split) {
      const forgedDream = structuredClone(s),
        pending = forgedDream.dreamLedger.find((e) => e.kind === 'pending');
      pending.evidence.receiptId = 'authoring:unrelated-source';
      pending.event_key = `pending:${forgedDream.dreamHolds[0].id}:${digest(pending.evidence)}`;
      assert.equal(prove(forgedDream).eligible, false);
    }
  });

for (const status of ['stale', 'failed', 'cancelled'])
  test(`NPC automatic settlement proves exact original finalize ${status} identity`, () => {
    const s = snapshot('npc'),
      job = s.npcJobs[0],
      hold = s.sparkHolds[0];
    job.status = status;
    const evidence = {
      outcome: 'failure_policy_pending',
      receiptId: `finalize:${job.id}:${status}`,
    };
    s.sparkLedger.push({
      owner_id: hold.owner_id,
      hold_id: hold.id,
      kind: 'pending',
      event_key: `pending:${hold.id}:${digest(evidence)}`,
      amount_subunits: hold.sparks_reserved_subunits ?? hold.reserved_subunits,
      evidence,
    });
    const before = digest(s),
      result = prove(s);
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(digest(s), before);
    for (const receiptId of [
      `finalize:unrelated:${status}`,
      `finalize:${job.id}:committed`,
      `finalize:${job.id}:${status === 'stale' ? 'failed' : 'stale'}`,
    ]) {
      const forged = structuredClone(s),
        pending = forged.sparkLedger.find((e) => e.kind === 'pending');
      pending.evidence.receiptId = receiptId;
      pending.event_key = `pending:${hold.id}:${digest(pending.evidence)}`;
      assert.equal(prove(forged).eligible, false);
    }
  });
