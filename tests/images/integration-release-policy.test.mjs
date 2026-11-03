/** Isolated local PostgreSQL; injected synthetic provider only, never network transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../game/support-runtime.mjs';
import { ownerProfile } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const database = new Db();
const profile = { ...ownerProfile(), aggregateCapMicros: 10000000 };
const config = (value) =>
  readGenerationConfig({
    GENERATION_MODE: 'release',
    GENERATION_CONFIG_JSON: JSON.stringify(value),
  });
const original = config(profile);
const candidate = config({
  ...profile,
  text: { ...profile.text, model: 'synthetic-updated-text' },
});
const initial = new GenerationAuthority(database, original);
const updated = new GenerationAuthority(database, candidate);
const code = (error) => error?.getResponse?.().code ?? error?.message;
const definition = {
  version: 'release-policy-fixture-v1',
  schema: { type: 'object' },
  instructions: 'Synthetic only',
  validateProposal: (proposal) => proposal,
};
let calls = 0;
const provider = {
  version: definition.version,
  generate: async () => {
    calls++;
    return {
      proposal: {},
      requestId: `synthetic-${calls}`,
      failureCode: 'AUTHORING_PROPOSAL_INVALID',
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
    };
  },
};
const engine = (authority) => new AuthoringTextEngine(database, authority, provider, definition);
const oldEngine = engine(initial),
  newEngine = engine(updated);
async function actor(role = 'user') {
  const id = randomUUID(),
    projectId = randomUUID();
  const handle = `policy_${id.replaceAll('-', '').slice(0, 12)}`;
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle,role) VALUES($1,$2,'synthetic-unusable-login','Fixture',$3,$4)",
    [id, `${handle}@example.test`, handle, role],
  );
  await db.query(
    'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,2000000)',
    [id],
  );
  const sourceHash = digest(id),
    readsetHash = digest(projectId);
  await db.query(
    "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location','{}',$3,'concept')",
    [projectId, id, sourceHash],
  );
  const binding = {
    projectId,
    projectRevision: 1,
    sourceHash,
    readsetHash,
    context: { brief: 'Synthetic location' },
  };
  const guard = async (c, b) => {
    assert.equal(
      (
        await c.query(
          'SELECT id FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 AND revision=$3 AND source_hash=$4 FOR UPDATE',
          [b.projectId, id, b.projectRevision, b.sourceHash],
        )
      ).rowCount,
      1,
    );
    assert.equal(b.readsetHash, readsetHash);
  };
  return { id, binding, guard };
}
const quote = (runtime, who) =>
  runtime.quote(who.id, { ...who.binding, operationId: randomUUID() }, who.guard);
const enqueue = (runtime, who, q) =>
  runtime.enqueue(who.id, { quoteId: q.id, operationId: randomUUID(), consent: true }, who.guard);
const input = (review) => ({
  operationId: randomUUID(),
  expectedRevision: review.active.revision,
  expectedHash: review.active.hash,
  candidateFingerprint: review.proposed.candidateFingerprint,
  consent: true,
});
async function financialSnapshot(who) {
  const rows = async (sql) => (await db.query(sql, [who.id])).rows;
  return {
    scope: await rows("SELECT * FROM generation_budget_scopes WHERE id='release:' || $1::text"),
    wallet: await rows('SELECT * FROM spark_wallets WHERE owner_id=$1'),
    holds: await rows('SELECT * FROM spark_holds WHERE owner_id=$1 ORDER BY id'),
    ledger: await rows('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY id'),
    reservations: await rows(
      'SELECT * FROM generation_budget_reservations WHERE actor_id=$1 ORDER BY id',
    ),
    jobs: await rows('SELECT * FROM live_authoring_text_jobs WHERE actor_id=$1 ORDER BY id'),
  };
}
await test(
  'explicit administrator release policy adoption preserves financial history',
  { timeout: 45000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      const admin = await actor('admin'),
        who = await actor();
      const oldQuote = await quote(oldEngine, who);
      await t.test(
        'review is read-only, admin-only and cannot silently authorize a different profile',
        async () => {
          const before = await financialSnapshot(who);
          await assert.rejects(
            updated.reviewReleasePolicy(who.id, who.id),
            (e) => code(e) === 'FORBIDDEN',
          );
          let previewTransactions = 0;
          const readOnlyAuthority = new GenerationAuthority(
            {
              tx: (work) =>
                database.tx(async (c) => {
                  const result = await work(c);
                  assert.equal(
                    (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
                    'on',
                  );
                  previewTransactions++;
                  return result;
                }),
            },
            candidate,
          );
          const review = await readOnlyAuthority.reviewReleasePolicy(admin.id, who.id);
          assert.equal(previewTransactions, 1);
          assert.equal(review.legacyProfileStatus, 'unavailable');
          assert.equal(review.active.profile, null);
          assert.equal(review.active.revision, 1);
          assert.equal(review.active.hash, original.configFingerprint);
          assert.equal(review.scopeId, `release:${who.id}`);
          assert.equal(review.proposed.candidateFingerprint, candidate.configFingerprint);
          assert.equal(review.proposed.canApply, true);
          assert.deepEqual(review.proposed.blockers, []);
          await assert.rejects(
            quote(newEngine, who),
            (e) => code(e) === 'GENERATION_POLICY_CHANGED',
          );
          await assert.rejects(
            updated.adoptReleasePolicy(who.id, who.id, input(review)),
            (e) => code(e) === 'FORBIDDEN',
          );
          await assert.rejects(
            updated.adoptReleasePolicy(admin.id, who.id, { ...input(review), consent: false }),
          );
          for (const patch of [
            { expectedRevision: 2 },
            { expectedHash: '0'.repeat(64) },
            { candidateFingerprint: '0'.repeat(64) },
          ])
            await assert.rejects(
              updated.adoptReleasePolicy(admin.id, who.id, { ...input(review), ...patch }),
              (e) => code(e) === 'GENERATION_POLICY_STALE',
            );
          assert.deepEqual(await financialSnapshot(who), before);
        },
      );
      await t.test(
        'stopped scopes, blocked scopes and disabled wallets stay unchanged',
        async () => {
          for (const alteration of [
            "UPDATE live_test_sessions SET state='stopped',stop_code='SYNTHETIC_STOP' WHERE owner_id=$1",
            "UPDATE generation_budget_scopes SET blocked=true WHERE id='release:' || $1::text",
            'UPDATE spark_wallets SET enabled=false WHERE owner_id=$1',
          ]) {
            const stopped = await actor();
            await quote(oldEngine, stopped);
            await db.query(alteration, [stopped.id]);
            const before = await financialSnapshot(stopped);
            const sessionBefore = (
              await db.query('SELECT * FROM live_test_sessions WHERE owner_id=$1', [stopped.id])
            ).rows;
            const review = await updated.reviewReleasePolicy(admin.id, stopped.id);
            assert.equal(review.proposed.canApply, false);
            assert.ok(review.proposed.blockers.includes('GENERATION_ACCOUNT_REVIEW_REQUIRED'));
            await assert.rejects(
              updated.adoptReleasePolicy(admin.id, stopped.id, input(review)),
              (e) => code(e) === 'GENERATION_ACCOUNT_REVIEW_REQUIRED',
            );
            assert.deepEqual(await financialSnapshot(stopped), before);
            assert.deepEqual(
              (await db.query('SELECT * FROM live_test_sessions WHERE owner_id=$1', [stopped.id]))
                .rows,
              sessionBefore,
            );
          }
        },
      );
      await t.test('cap and allowance changes require another workflow', async () => {
        for (const patch of [
          { totalCapMicros: profile.totalCapMicros + 1 },
          { textCapMicros: profile.textCapMicros + 1 },
          { imageCapMicros: profile.imageCapMicros + 1 },
          {
            allowance: 'unlimited',
            totalCapMicros: null,
            textCapMicros: null,
            imageCapMicros: null,
          },
        ]) {
          const authority = new GenerationAuthority(
            database,
            config(
              patch.allowance === 'unlimited'
                ? { allowance: 'unlimited', text: profile.text, image: profile.image }
                : { ...profile, ...patch },
            ),
          );
          const review = await authority.reviewReleasePolicy(admin.id, who.id);
          assert.equal(review.proposed.canApply, false);
          assert.ok(
            review.proposed.blockers.includes('GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED'),
          );
          await assert.rejects(
            authority.adoptReleasePolicy(admin.id, who.id, input(review)),
            (e) => code(e) === 'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
          );
        }
      });
      await t.test(
        'queued work blocks adoption; known failed result permits it without releasing Spark hold',
        async () => {
          const job = await enqueue(oldEngine, who, await quote(oldEngine, who));
          let review = await updated.reviewReleasePolicy(admin.id, who.id);
          assert.equal(review.proposed.canApply, false);
          assert.ok(review.proposed.blockers.includes('GENERATION_POLICY_BUSY'));
          await assert.rejects(
            updated.adoptReleasePolicy(admin.id, who.id, input(review)),
            (e) => code(e) === 'GENERATION_POLICY_BUSY',
          );
          assert.equal(calls, 0);
          const failed = await oldEngine.run(who.id, job.id, who.guard, async () =>
            assert.fail('Failed proposal cannot commit'),
          );
          assert.equal(failed.status, 'failed');
          assert.equal(calls, 1);
          const before = await financialSnapshot(who);
          assert.equal(before.reservations[0].status, 'settled');
          assert.equal(before.holds[0].status, 'pending');
          review = await updated.reviewReleasePolicy(admin.id, who.id);
          assert.equal(review.proposed.canApply, true);
          assert.equal(review.liabilities.spentMicros, 30);
          assert.deepEqual(review.pendingSparkHolds, [
            {
              id: before.holds[0].id,
              status: 'pending',
              reservedSubunits: before.holds[0].reserved_subunits,
            },
          ]);
          const oldStatus = await updated.status(who.id);
          assert.equal(oldStatus.policyRevision, 1);
          assert.equal(oldStatus.policyHash, original.configFingerprint);
          assert.equal(oldStatus.activeConfigFingerprint, original.configFingerprint);
          assert.equal(oldStatus.configFingerprint, candidate.configFingerprint);
          assert.equal(oldStatus.stopCode, 'GENERATION_POLICY_CHANGED');
          const request = input(review);
          const [receipt, replay] = await Promise.all([
            updated.adoptReleasePolicy(admin.id, who.id, request),
            updated.adoptReleasePolicy(admin.id, who.id, request),
          ]);
          assert.deepEqual(replay, receipt);
          assert.equal(receipt.revision, 2);
          assert.equal(receipt.hash, candidate.configFingerprint);
          const newStatus = await updated.status(who.id);
          assert.equal(newStatus.policyRevision, receipt.revision);
          assert.equal(newStatus.policyHash, receipt.hash);
          assert.equal(newStatus.activeConfigFingerprint, candidate.configFingerprint);
          assert.equal(newStatus.configFingerprint, candidate.configFingerprint);
          assert.equal(newStatus.stopCode, null);
          assert.deepEqual(await updated.adoptReleasePolicy(admin.id, who.id, request), receipt);
          await assert.rejects(
            updated.adoptReleasePolicy(admin.id, who.id, {
              ...request,
              expectedHash: '0'.repeat(64),
            }),
            (e) => code(e) === 'IDEMPOTENCY_CONFLICT',
          );
          await assert.rejects(
            updated.adoptReleasePolicy(admin.id, who.id, { ...request, operationId: randomUUID() }),
            (e) => code(e) === 'GENERATION_POLICY_STALE',
          );
          assert.deepEqual(await financialSnapshot(who), before);
          const session = (
            await db.query('SELECT * FROM live_test_sessions WHERE id=$1', [review.authorizationId])
          ).rows[0];
          assert.equal(session.scope_id, review.scopeId);
          assert.equal(session.policy_revision, 2);
          assert.equal(session.config_hash, candidate.configFingerprint);
          const history = (
            await db.query(
              'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 ORDER BY revision',
              [review.authorizationId],
            )
          ).rows;
          assert.equal(history.filter((r) => r.operation_id === request.operationId).length, 1);
          assert.equal(history.at(-1).previous_hash, original.configFingerprint);
          assert.equal(history.at(-1).profile_snapshot.text.model, candidate.text.model);
          await assert.rejects(
            enqueue(newEngine, who, oldQuote),
            (e) => code(e) === 'GENERATION_POLICY_CHANGED',
          );
          const persistedReview = await updated.reviewReleasePolicy(admin.id, who.id);
          assert.equal(persistedReview.legacyProfileStatus, 'available');
          assert.equal(
            persistedReview.active.profile.aggregateCapMicros,
            profile.aggregateCapMicros,
          );
          assert.ok(persistedReview.proposed.blockers.includes('GENERATION_POLICY_UNCHANGED'));
          const changedAggregate = new GenerationAuthority(
            database,
            config({
              ...profile,
              aggregateCapMicros: profile.aggregateCapMicros + 1,
              text: { ...profile.text, model: candidate.text.model },
            }),
          );
          const aggregateReview = await changedAggregate.reviewReleasePolicy(admin.id, who.id);
          assert.equal(aggregateReview.proposed.canApply, false);
          assert.ok(
            aggregateReview.proposed.blockers.includes(
              'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
            ),
          );
          await assert.rejects(
            changedAggregate.adoptReleasePolicy(admin.id, who.id, input(aggregateReview)),
            (e) => code(e) === 'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
          );
          assert.deepEqual(await financialSnapshot(who), before);
          const fresh = await quote(newEngine, who);
          assert.equal(fresh.policyRevision, 2);
          assert.equal(fresh.policyHash, candidate.configFingerprint);
          // Both text and image clients require these exact status/quote identities.
          assert.equal(fresh.policyRevision, newStatus.policyRevision);
          assert.equal(fresh.policyHash, newStatus.policyHash);
          assert.notEqual(oldQuote.policyRevision, newStatus.policyRevision);
          assert.equal((await enqueue(newEngine, who, fresh)).policyRevision, 2);
          assert.equal(calls, 1, 'Review/adoption/quote/enqueue never dispatch a provider');
        },
      );
      await t.test(
        'a revised authorization without its matching immutable snapshot is blocked',
        async () => {
          const corrupt = await actor();
          await quote(oldEngine, corrupt);
          await db.query('UPDATE live_test_sessions SET policy_revision=2 WHERE owner_id=$1', [
            corrupt.id,
          ]);
          const before = await financialSnapshot(corrupt);
          const review = await updated.reviewReleasePolicy(admin.id, corrupt.id);
          assert.equal(review.proposed.canApply, false);
          assert.ok(review.proposed.blockers.includes('GENERATION_POLICY_CHANGED'));
          await assert.rejects(
            updated.adoptReleasePolicy(admin.id, corrupt.id, input(review)),
            (e) => code(e) === 'GENERATION_POLICY_CHANGED',
          );
          assert.deepEqual(await financialSnapshot(corrupt), before);
          assert.equal(
            (
              await db.query('SELECT policy_revision FROM live_test_sessions WHERE owner_id=$1', [
                corrupt.id,
              ])
            ).rows[0].policy_revision,
            2,
          );
        },
      );
      await t.test('unknown outcome remains blocked and accounting is unchanged', async () => {
        const other = await actor(),
          q = await quote(oldEngine, other);
        const job = await enqueue(oldEngine, other, q);
        await db.query(
          "UPDATE live_authoring_text_jobs SET status='unknown',error_code='PROVIDER_TIMEOUT' WHERE id=$1",
          [job.id],
        );
        const before = await financialSnapshot(other);
        const review = await updated.reviewReleasePolicy(admin.id, other.id);
        assert.equal(review.proposed.canApply, false);
        assert.ok(review.proposed.blockers.includes('LIVE_OUTCOME_UNRESOLVED'));
        await assert.rejects(
          updated.adoptReleasePolicy(admin.id, other.id, input(review)),
          (e) => code(e) === 'LIVE_OUTCOME_UNRESOLVED',
        );
        assert.deepEqual(await financialSnapshot(other), before);
        assert.equal(calls, 1);
      });
    } finally {
      await database.onApplicationShutdown();
      await db.end();
    }
  },
);
