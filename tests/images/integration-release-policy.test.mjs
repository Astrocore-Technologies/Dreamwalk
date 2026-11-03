/** Isolated local PostgreSQL; injected synthetic provider only, never network transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { db } from '../game/support-runtime.mjs';
import { ownerProfile } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const {
  registerReleaseDeployment,
  activateRegisteredReleaseDeployment,
  currentReleaseDeployment,
  ReleaseDeploymentReadiness,
} = require('../../apps/api/dist/generation/release-deployment.js');
const { providerMicrosToSparkSubunits } = require('../../packages/contracts/dist');
const database = new Db();
const activate = (config) => database.tx((c) => activateReleaseDeployment(c, config));
const profile = { ...ownerProfile(), aggregateCapMicros: 10000000 };
const config = (value) =>
  readGenerationConfig({
    GENERATION_MODE: 'release',
    GENERATION_CONFIG_JSON: JSON.stringify(value),
  });
const original = config(profile);
const candidate = config({
  ...profile,
  text: {
    ...profile.text,
    model: 'synthetic-updated-text',
    outputMicrosPerMillion: profile.text.outputMicrosPerMillion + 1000000,
  },
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
  'server profile refresh is automatic and preserves financial history',
  { timeout: 45000 },
  async (t) => {
    const session = async (who) =>
      (await db.query('SELECT * FROM live_test_sessions WHERE owner_id=$1', [who.id])).rows[0];
    const history = async (who) =>
      (
        await db.query(
          'SELECT r.* FROM generation_policy_revisions r JOIN live_test_sessions s ON s.id=r.authorization_id WHERE s.owner_id=$1 ORDER BY revision',
          [who.id],
        )
      ).rows;
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      await t.test(
        'ordinary user quote automatically appends one revision; status is read-only and predicts it',
        async () => {
          await activate(original);
          const who = await actor();
          const stale = await quote(oldEngine, who);
          const before = await financialSnapshot(who);
          const oldSession = await session(who);
          await activate(candidate);
          const status = await updated.status(who.id);
          assert.equal(status.stopCode, null);
          assert.equal(status.policyRevision, 2);
          assert.equal(status.policyHash, candidate.configFingerprint);
          assert.deepEqual(await session(who), oldSession);
          const [first, second] = await Promise.all([quote(newEngine, who), quote(newEngine, who)]);
          assert.equal(first.policyRevision, 2);
          assert.equal(second.policyRevision, 2);
          assert.equal(first.policyHash, status.policyHash);
          assert.deepEqual(await financialSnapshot(who), before);
          const revisions = await history(who);
          assert.deepEqual(
            revisions.map((r) => r.revision),
            [1, 2],
          );
          assert.equal(revisions[1].previous_hash, original.configFingerprint);
          assert.equal(revisions[1].profile_snapshot.text.model, candidate.text.model);
          assert.equal((await session(who)).scope_id, oldSession.scope_id);
          assert.equal((await updated.status(who.id)).policyRevision, 2);
          await assert.rejects(
            enqueue(newEngine, who, stale),
            (e) => code(e) === 'GENERATION_POLICY_CHANGED',
          );
          assert.deepEqual(await financialSnapshot(who), before);
          await assert.rejects(
            quote(oldEngine, who),
            (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
          );
          assert.equal((await history(who)).length, 2);
          await assert.rejects(
            db.query('UPDATE generation_policy_revisions SET profile_snapshot=$2 WHERE id=$1', [
              revisions[1].id,
              '{}',
            ]),
            /Immutable/,
          );
          const operationId = randomUUID();
          const q = await newEngine.quote(who.id, { ...who.binding, operationId }, who.guard);
          const replay = await newEngine.quote(who.id, { ...who.binding, operationId }, who.guard);
          assert.equal(replay.id, q.id);
          assert.equal((await history(who)).length, 2);
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'dispatched old revision settles original receipt after refresh without re-dispatch or hold rewrite',
        async () => {
          await activate(original);
          const who = await actor();
          let deliver, started;
          const ready = new Promise((r) => {
            started = r;
          });
          const work = new Promise((r) => {
            deliver = r;
          });
          let dispatched = 0;
          const waiting = new AuthoringTextEngine(
            database,
            initial,
            {
              ...provider,
              generate: async () => {
                dispatched++;
                started();
                return work;
              },
            },
            definition,
          );
          const q = await quote(waiting, who);
          const request = { quoteId: q.id, operationId: randomUUID(), consent: true };
          const job = await waiting.enqueue(who.id, request, who.guard);
          const running = waiting.run(who.id, job.id, who.guard, async () =>
            assert.fail('Failed proposal cannot commit'),
          );
          await ready;
          const before = await financialSnapshot(who);
          assert.equal(before.jobs[0].status, 'dispatched');
          await activate(candidate);
          const fresh = await quote(newEngine, who);
          assert.equal(fresh.policyRevision, 2);
          assert.deepEqual(await financialSnapshot(who), before);
          deliver({
            proposal: null,
            requestId: 'synthetic-old-receipt',
            failureCode: 'PROVIDER_INCOMPLETE',
            usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
          });
          const result = await running;
          assert.equal(result.status, 'failed');
          const after = await financialSnapshot(who);
          assert.equal(after.reservations[0].actual_micros, '30');
          assert.equal(after.reservations[0].status, 'settled');
          assert.equal(after.jobs[0].generation_policy_hash, original.configFingerprint);
          assert.equal(after.jobs[0].generation_policy_revision, 1);
          assert.equal(after.jobs[0].provider_request_id, 'synthetic-old-receipt');
          assert.equal(after.holds[0].status, 'pending');
          assert.equal(after.holds[0].captured_subunits, null);
          assert.equal(after.holds[0].reserved_subunits, before.holds[0].reserved_subunits);
          const replay = await newEngine.enqueue(who.id, request, who.guard);
          assert.equal(replay.id, job.id);
          await newEngine.run(who.id, job.id, who.guard, async () =>
            assert.fail('Cannot replay failed result'),
          );
          assert.equal(dispatched, 1);
          assert.equal((await session(who)).config_hash, candidate.configFingerprint);
          assert.deepEqual(await financialSnapshot(who), after);
          await assert.rejects(
            newEngine.enqueue(who.id, { ...request, quoteId: fresh.id }, who.guard),
            (e) => code(e) === 'IDEMPOTENCY_CONFLICT',
          );
        },
      );
      await t.test(
        'successful old revision commits and captures original cost after refresh exactly once',
        async () => {
          await activate(original);
          const who = await actor();
          let deliver, started;
          const ready = new Promise((r) => {
            started = r;
          });
          const work = new Promise((r) => {
            deliver = r;
          });
          let dispatched = 0;
          const waiting = new AuthoringTextEngine(
            database,
            initial,
            {
              ...provider,
              generate: async () => {
                dispatched++;
                started();
                return work;
              },
            },
            definition,
          );
          const q = await quote(waiting, who);
          const request = { quoteId: q.id, operationId: randomUUID(), consent: true };
          const job = await waiting.enqueue(who.id, request, who.guard);
          let commits = 0;
          const running = waiting.run(who.id, job.id, who.guard, async () => {
            commits++;
            return { committed: true };
          });
          await ready;
          const before = await financialSnapshot(who);
          assert.equal(before.jobs[0].status, 'dispatched');
          await activate(candidate);
          const fresh = await quote(newEngine, who);
          assert.equal(fresh.policyRevision, 2);
          assert.deepEqual(await financialSnapshot(who), before);
          deliver({
            proposal: null,
            requestId: 'synthetic-old-receipt',

            usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
          });
          const result = await running;
          assert.equal(result.status, 'committed');
          const after = await financialSnapshot(who);
          assert.equal(after.reservations[0].actual_micros, '30');
          assert.equal(after.reservations[0].status, 'settled');
          assert.equal(after.jobs[0].generation_policy_hash, original.configFingerprint);
          assert.equal(after.jobs[0].generation_policy_revision, 1);
          assert.equal(after.jobs[0].provider_request_id, 'synthetic-old-receipt');
          assert.equal(after.holds[0].status, 'settled');
          assert.equal(after.holds[0].captured_subunits, providerMicrosToSparkSubunits('30'));
          assert.equal(after.holds[0].reserved_subunits, before.holds[0].reserved_subunits);
          const replay = await newEngine.enqueue(who.id, request, who.guard);
          assert.equal(replay.id, job.id);
          await newEngine.run(who.id, job.id, who.guard, async () =>
            assert.fail('Cannot replay failed result'),
          );
          assert.equal(dispatched, 1);
          assert.equal(commits, 1);
          assert.equal((await session(who)).config_hash, candidate.configFingerprint);
          assert.deepEqual(await financialSnapshot(who), after);
          await assert.rejects(
            newEngine.enqueue(who.id, { ...request, quoteId: fresh.id }, who.guard),
            (e) => code(e) === 'IDEMPOTENCY_CONFLICT',
          );
        },
      );
      await t.test(
        'restart validates stored result under current parser, preserves original cost and rejects incompatible schema',
        async () => {
          for (const compatible of [true, false]) {
            await activate(original);
            const who = await actor();
            let sent = 0;
            const paused = new AuthoringTextEngine(
              database,
              initial,
              {
                ...provider,
                version: 'old-profile-envelope',
                generate: async () => {
                  sent++;
                  return {
                    proposal: { ok: true },
                    requestId: `restart-${who.id}`,
                    usage: {
                      inputTokens: 10,
                      outputTokens: 10,
                      costMicros: 30,
                      costEvidence: 'reported',
                    },
                  };
                },
              },
              definition,
            );
            // Simulate the durable receipt checkpoint before a process exits prior to semantic commit.
            paused.resumeGenerated = async () => {};
            const job = await enqueue(paused, who, await quote(paused, who));
            assert.equal(
              (await paused.run(who.id, job.id, who.guard, async () => assert.fail('paused')))
                .status,
              'generated',
            );
            await activate(candidate);
            await quote(newEngine, who);
            let validations = 0,
              commits = 0;
            const restarted = new AuthoringTextEngine(
              database,
              updated,
              {
                ...provider,
                version: 'new-profile-envelope',
                generate: async () => assert.fail('Never regenerate persisted result'),
              },
              {
                ...definition,
                validateProposal: (value) => {
                  validations++;
                  assert.deepEqual(value, { ok: true });
                  if (!compatible) throw Error('incompatible schema');
                  return value;
                },
              },
            );
            const result = await restarted.run(
              who.id,
              job.id,
              who.guard,
              async (_c, _binding, value) => {
                assert.deepEqual(value, { ok: true });
                commits++;
                return { applied: true };
              },
            );
            assert.equal(result.status, compatible ? 'committed' : 'stale');
            assert.equal(sent, 1);
            assert.equal(validations, 1);
            assert.equal(commits, compatible ? 1 : 0);
            const after = await financialSnapshot(who);
            assert.equal(after.reservations[0].actual_micros, '30');
            assert.equal(after.jobs[0].provider_version, 'old-profile-envelope');
            assert.equal(after.jobs[0].generation_policy_hash, original.configFingerprint);
            assert.equal(after.holds[0].status, compatible ? 'settled' : 'pending');
            assert.equal(
              after.holds[0].captured_subunits,
              compatible ? providerMicrosToSparkSubunits('30') : null,
            );
          }
        },
      );
      await t.test(
        'old queued work cannot dispatch or be re-priced after refresh; original unused hold releases normally',
        async () => {
          await activate(original);
          const who = await actor();
          const job = await enqueue(oldEngine, who, await quote(oldEngine, who));
          await activate(candidate);
          await quote(newEngine, who);
          const result = await oldEngine.run(who.id, job.id, who.guard, async () =>
            assert.fail('Stale job cannot commit'),
          );
          assert.equal(result.status, 'failed');
          assert.equal(result.errorCode, 'GENERATION_POLICY_CHANGED');
          const after = await financialSnapshot(who);
          assert.equal(after.reservations[0].status, 'settled');
          assert.equal(after.reservations[0].actual_micros, '0');
          assert.equal(after.holds[0].status, 'released');
          assert.equal(after.jobs[0].generation_policy_hash, original.configFingerprint);
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'account, wallet, pricing and unchanged allowance constraints cannot be bypassed',
        async () => {
          for (const [sql, expected] of [
            [
              "UPDATE live_test_sessions SET state='stopped',stop_code='SYNTHETIC_UNKNOWN' WHERE owner_id=$1",
              'GENERATION_ACCOUNT_REVIEW_REQUIRED',
            ],
            [
              "UPDATE generation_budget_scopes SET blocked=true WHERE id='release:' || $1::text",
              'GENERATION_ACCOUNT_REVIEW_REQUIRED',
            ],
            [
              'UPDATE spark_wallets SET enabled=false WHERE owner_id=$1',
              'SPARK_WALLET_NOT_ENABLED',
            ],
            ['UPDATE users SET deleted_at=now() WHERE id=$1', 'FORBIDDEN'],
          ]) {
            await activate(original);
            const who = await actor();
            await quote(oldEngine, who);
            await db.query(sql, [who.id]);
            const before = await financialSnapshot(who),
              prior = await session(who);
            await activate(candidate);
            await assert.rejects(quote(newEngine, who), (e) => code(e) === expected);
            assert.deepEqual(await financialSnapshot(who), before);
            assert.deepEqual(await session(who), prior);
          }
          await activate(original);
          const who = await actor();
          await quote(oldEngine, who);
          for (const patch of [
            { totalCapMicros: profile.totalCapMicros + 1 },
            { textCapMicros: profile.textCapMicros + 1 },
            { imageCapMicros: profile.imageCapMicros + 1 },
            { aggregateCapMicros: profile.aggregateCapMicros + 1 },
          ]) {
            const changedConfig = config({ ...profile, ...patch });
            await activate(changedConfig);
            const changed = engine(new GenerationAuthority(database, changedConfig));
            await assert.rejects(
              quote(changed, who),
              (e) => code(e) === 'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
            );
          }
          const expired = new GenerationAuthority(database, {
            ...candidate,
            text: {
              ...candidate.text,
              pricing: { ...candidate.text.pricing, validUntil: '2020-01-01T00:00:00Z' },
            },
          });
          await assert.rejects(
            quote(engine(expired), who),
            (e) => code(e) === 'GENERATION_PRICING_EXPIRED',
          );
          assert.equal((await session(who)).policy_revision, 1);
        },
      );
      await t.test(
        'compiled production migration registers a candidate without changing the active profile',
        async () => {
          await activate(original);
          const deployProfile = {
            ...profile,
            text: { ...profile.text, model: 'synthetic-predeploy' },
          };
          const deployConfig = config(deployProfile);
          const deploymentId = randomUUID();
          const run = () =>
            spawnSync(process.execPath, ['apps/api/dist/migrate.js', '--production'], {
              cwd: process.cwd(),
              encoding: 'utf8',
              timeout: 10000,
              env: {
                ...process.env,
                GENERATION_MODE: 'release',
                RAILWAY_DEPLOYMENT_ID: deploymentId,
                GENERATION_CONFIG_JSON: JSON.stringify(deployProfile),
              },
            });
          const first = run();
          assert.equal(first.status, 0, first.stderr);
          const active = (
            await db.query(
              'SELECT * FROM generation_release_deployments ORDER BY epoch DESC LIMIT 1',
            )
          ).rows[0];
          assert.equal(active.config_fingerprint, deployConfig.configFingerprint);
          assert.ok(await database.tx((c) => currentReleaseDeployment(c, original)));
          await assert.rejects(
            database.tx((c) => currentReleaseDeployment(c, deployConfig)),
            (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
          );
          assert.equal(run().status, 0);
          assert.deepEqual(
            (
              await db.query(
                'SELECT * FROM generation_release_deployments ORDER BY epoch DESC LIMIT 1',
              )
            ).rows[0],
            active,
          );
        },
      );
      await t.test(
        'failed startup leaves old profile active and only the latest exact registered runtime becomes ready',
        async () => {
          await activate(original);
          const aEpoch = await database.tx((c) => currentReleaseDeployment(c, original));
          const bId = randomUUID();
          await database.tx((c) => registerReleaseDeployment(c, candidate, bId));
          const notReady = new ReleaseDeploymentReadiness(true);
          await assert.rejects(
            notReady.activate(async () => {
              throw Error('startup failed');
            }),
            /startup failed/,
          );
          assert.equal(notReady.ready, false);
          assert.equal(await database.tx((c) => currentReleaseDeployment(c, original)), aEpoch);
          await assert.rejects(
            database.tx((c) => activateRegisteredReleaseDeployment(c, candidate, randomUUID())),
            (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_REGISTERED',
          );
          await assert.rejects(
            database.tx((c) => activateRegisteredReleaseDeployment(c, original, bId)),
            (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_REGISTERED',
          );
          await assert.rejects(
            notReady.activate(() =>
              database.tx(async (c) => {
                await activateRegisteredReleaseDeployment(c, candidate, bId);
                throw Error('activation transaction failed');
              }),
            ),
            /activation transaction failed/,
          );
          assert.equal(notReady.ready, false);
          assert.equal(await database.tx((c) => currentReleaseDeployment(c, original)), aEpoch);
          const cId = randomUUID();
          await database.tx((c) => registerReleaseDeployment(c, candidate, cId));
          await assert.rejects(
            notReady.activate(() =>
              database.tx((c) => activateRegisteredReleaseDeployment(c, candidate, bId)),
            ),
            (e) => code(e) === 'GENERATION_RELEASE_DEPLOYMENT_SUPERSEDED',
          );
          assert.equal(notReady.ready, false);
          assert.equal(await database.tx((c) => currentReleaseDeployment(c, original)), aEpoch);
          const ready = new ReleaseDeploymentReadiness(true);
          await ready.activate(async () => {
            const epochs = await Promise.all([
              database.tx((c) => activateRegisteredReleaseDeployment(c, candidate, cId)),
              database.tx((c) => activateRegisteredReleaseDeployment(c, candidate, cId)),
            ]);
            assert.equal(epochs[0], epochs[1]);
          });
          assert.equal(ready.ready, true);
          const rollbackId = randomUUID();
          await database.tx((c) => registerReleaseDeployment(c, original, rollbackId));
          await database.tx((c) => activateRegisteredReleaseDeployment(c, original, rollbackId));
          assert.ok(
            BigInt(await database.tx((c) => currentReleaseDeployment(c, original))) >
              BigInt(aEpoch),
          );
          await assert.rejects(
            database.tx((c) => activateRegisteredReleaseDeployment(c, candidate, cId)),
            (e) => code(e) === 'GENERATION_RELEASE_DEPLOYMENT_SUPERSEDED',
          );
        },
      );
      await t.test(
        'global deployment epochs reject unseen obsolete processes and support legitimate rollback',
        async () => {
          const epochA = await activate(original);
          await assert.rejects(
            database.tx(async (c) => {
              await activateReleaseDeployment(c, candidate);
              throw Error('synthetic deployment rollback');
            }),
            /synthetic deployment rollback/,
          );
          assert.equal(
            (
              await db.query(
                'SELECT epoch FROM generation_release_deployments ORDER BY epoch DESC LIMIT 1',
              )
            ).rows[0].epoch,
            epochA,
          );
          const whoA = await actor();
          const oldQuote = await quote(oldEngine, whoA);
          const [epochB, concurrentEpoch] = await Promise.all([
            activate(candidate),
            activate(candidate),
          ]);
          assert.equal(concurrentEpoch, epochB);
          assert.ok(BigInt(epochB) > BigInt(epochA));
          const whoB = await actor();
          await quote(newEngine, whoB);
          const unregistered = await actor();
          const before = await financialSnapshot(whoB);
          for (const who of [whoA, whoB, unregistered])
            await assert.rejects(
              quote(oldEngine, who),
              (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
            );
          assert.equal(await session(unregistered), undefined);
          assert.deepEqual(await financialSnapshot(whoB), before);
          const epochs = (
            await db.query('SELECT * FROM generation_release_deployments ORDER BY epoch')
          ).rows;
          assert.equal(await activate(candidate), epochB);
          assert.deepEqual(
            (await db.query('SELECT * FROM generation_release_deployments ORDER BY epoch')).rows,
            epochs,
          );
          const rollback = await activate(original);
          assert.ok(BigInt(rollback) > BigInt(epochB));
          // A skipped B, but its old A quote is still invalid after the new deployment epoch.
          const current = await quote(oldEngine, whoA);
          assert.equal(current.policyRevision, 2);
          assert.equal(current.policyHash, original.configFingerprint);
          await assert.rejects(
            enqueue(oldEngine, whoA, oldQuote),
            (e) => code(e) === 'GENERATION_POLICY_CHANGED',
          );
          const reverted = await quote(oldEngine, whoB);
          assert.equal(reverted.policyRevision, 2);
          assert.equal((await session(whoB)).release_profile_epoch, rollback);
          await assert.rejects(
            quote(newEngine, whoB),
            (e) => code(e) === 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
          );
          await assert.rejects(
            db.query('DELETE FROM generation_release_deployments WHERE epoch=$1', [rollback]),
            /Immutable/,
          );
        },
      );
      await t.test('legacy first revision can refresh without inventing old prices', async () => {
        await activate(original);
        const who = await actor();
        const scope = `release:${who.id}`,
          id = randomUUID();
        await db.query(
          'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,serialize_outstanding) VALUES($1,true,$2,$3,$4,true)',
          [scope, original.totalCapMicros, original.textCapMicros, original.imageCapMicros],
        );
        await db.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,text_cap_micros,image_cap_micros,policy_revision,policy_hash) VALUES($1,$2,$3,NULL,$4,'active','release',$5,$6,$7,1,$5)",
          [
            id,
            who.id,
            scope,
            original.totalCapMicros,
            original.configFingerprint,
            original.textCapMicros,
            original.imageCapMicros,
          ],
        );
        await activate(candidate);
        const fresh = await quote(newEngine, who);
        assert.equal(fresh.policyRevision, 2);
        const rows = await history(who);
        assert.deepEqual(
          rows.map((r) => r.revision),
          [2],
        );
        assert.equal(rows[0].previous_hash, original.configFingerprint);
      });
    } finally {
      await db.end();
    }
  },
);
