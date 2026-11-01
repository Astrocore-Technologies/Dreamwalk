/** Fresh disposable DB only. Fake image transport/key; committed rows prove real concurrent transactions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput } from '../game/support-authored.mjs';
import { fixturePng, uploadFixture, failureCode } from './support.mjs';
import { requestEstimateOwnerProfile, ownerEnvironment } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url),
  sharp = require('sharp');
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const {
  GenerationAuthority,
  GENERATION_SCOPE_ID,
} = require('../../apps/api/dist/generation/service.js');
const database = new Db();
const rights = {
  basis: 'generated',
  licenseLabel: 'Synthetic estimator fixture',
  attribution: 'Synthetic only',
  allowAuthorReuse: false,
  attested: true,
};
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const hash = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
await test(
  'request-specific owner image reserves share one budget, survive policy changes, and retain uncertain liability',
  { timeout: 120000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const story = await owner.request('/studio/adventures', storyInput());
      const foreign = await uploadFixture(other);
      await stopApi();
      const rawA = requestEstimateOwnerProfile(),
        cfgA = readOwnerGenerationConfig(ownerEnvironment(rawA, owner.handle));
      let calls = 0,
        reads = 0,
        outcome = 'ok',
        usageOutput = 100;
      const png = await sharp(await fixturePng())
        .resize(1536, 1024)
        .png()
        .toBuffer();
      const transport = async (url, init) => {
        calls++;
        let refs = 0;
        if (init.body instanceof FormData) {
          refs = init.body.getAll('image[]').length;
          assert.match(url, /\/images\/edits$/);
        } else {
          const body = JSON.parse(init.body);
          assert.equal(body.n, 1);
          assert.equal(body.size, '1536x1024');
          assert.match(url, /\/images\/generations$/);
        }
        if (outcome === '403')
          return new Response(
            JSON.stringify({
              error: { code: 'insufficient_permissions', message: 'PRIVATE_PROVIDER_ECHO' },
            }),
            { status: 403, headers: { 'x-request-id': `req_synthetic_${calls}` } },
          );
        const usage =
          outcome === 'unknown'
            ? undefined
            : {
                input_tokens_details: { text_tokens: 100, image_tokens: refs ? 100 : 0 },
                output_tokens: outcome === 'overrun' ? 400000 : usageOutput,
              };
        return new Response(
          JSON.stringify({
            data: [{ b64_json: png.toString('base64') }],
            ...(usage ? { usage } : {}),
          }),
          { headers: { 'x-request-id': `req_synthetic_${calls}` } },
        );
      };
      const make = (config, store = database) => {
        const authority = new GenerationAuthority(store, config),
          runtime = createOwnerImageRuntime(config, {
            resolveApiKey: () => {
              reads++;
              return 'synthetic-fake-key';
            },
            fetchImpl: transport,
          });
        const engine = new ImageGenerationEngine(
          store,
          new AssetReuseService(store),
          runtime.provider,
          runtime.policy,
          runtime.capabilities,
        );
        engine.setLiveAuthorizer((c, user, id) => authority.authorizeImage(c, user, id));
        return { engine, authority, runtime };
      };
      const a = make(cfgA);
      await a.authority.claim(owner.user.id, {
        consent: true,
        candidateFingerprint: cfgA.configFingerprint,
      });
      const input = (prompt = 'hello', referenceRevisionIds = []) => ({
        adventureId: story.id,
        prompt,
        title: 'Synthetic per-request image',
        kind: 'background',
        camera: 'top-down',
        tags: [],
        background: 'opaque',
        referenceRevisionIds,
        mode: 'external',
        declineReuse: true,
        rights,
      });
      const consent = (q) => ({
        quoteId: q.quote.id,
        operationId: randomUUID(),
        consent: true,
        estimateRiskConsent: true,
      });
      let firstBody, firstDone;
      await t.test(
        'actual prompts yield distinct small reserves; exact concurrent commands reserve/dispatch once',
        async () => {
          const small = await a.engine.quote(owner.user.id, input()),
            large = await a.engine.quote(owner.user.id, input('x'.repeat(1024)));
          assert.equal(small.quote.reserveMicros, 4797);
          assert.ok(large.quote.reserveMicros > small.quote.reserveMicros);
          assert.ok(large.quote.reserveMicros < cfgA.totalCapMicros);
          assert.equal(small.quote.estimateSnapshotHash, small.quote.estimateSnapshot.fingerprint);
          assert.equal(
            small.quote.pricingProfileHash,
            small.quote.pricingProfileSnapshot.fingerprint,
          );
          assert.equal(small.quote.policyRevision, 1);
          assert.match(small.quote.policyHash, /^[a-f0-9]{64}$/);
          firstBody = consent(small);
          await assert.rejects(
            a.engine.enqueue(owner.user.id, { ...firstBody, estimateRiskConsent: undefined }),
            failureCode('IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'),
          );
          const duplicated = await Promise.all([
            a.engine.enqueue(owner.user.id, firstBody),
            a.engine.enqueue(owner.user.id, firstBody),
          ]);
          assert.equal(duplicated[0].id, duplicated[1].id);
          const held = (
            await db.query(
              "SELECT * FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
              [GENERATION_SCOPE_ID],
            )
          ).rows;
          assert.equal(held.length, 1);
          assert.equal(Number(held[0].upper_micros), small.quote.reserveMicros);
          await assert.rejects(
            a.engine.enqueue(owner.user.id, consent(large)),
            failureCode('GENERATION_OUTSTANDING_REQUEST'),
          );
          await Promise.all([a.engine.workOnce(), a.engine.workOnce()]);
          firstDone = await a.engine.get(owner.user.id, duplicated[0].id);
          assert.equal(firstDone.status, 'admitted');
          assert.equal(calls, 1);
          assert.equal(firstDone.actualMicros, 400);
        },
      );
      let secondDone;
      await t.test(
        'multiple sequential image jobs and explicit reference uncertainty fit the same cumulative USD1',
        async () => {
          const q = await a.engine.quote(owner.user.id, input('another request'));
          const job = await a.engine.enqueue(owner.user.id, consent(q));
          await a.engine.workOnce();
          secondDone = await a.engine.get(owner.user.id, job.id);
          assert.equal(secondDone.status, 'admitted');
          const ref = await a.engine.quote(
            owner.user.id,
            input('with an owned reference', [firstDone.revisionId]),
          );
          assert.equal(ref.quote.estimateSnapshot.referenceCount, 1);
          assert.equal(ref.quote.estimateSnapshot.uncertainReferences, true);
          assert.equal(ref.quote.estimateSnapshot.referenceAllowanceMicros, 10000);
          assert.ok(ref.quote.reserveMicros > q.quote.reserveMicros);
          assert.ok(!JSON.stringify(ref.quote.estimateSnapshot).includes(firstDone.revisionId));
          assert.ok(
            !JSON.stringify(ref.quote.pricingProfileSnapshot).includes('with an owned reference'),
          );
          const referenced = await a.engine.enqueue(owner.user.id, consent(ref));
          await a.engine.workOnce();
          assert.equal((await a.engine.get(owner.user.id, referenced.id)).status, 'admitted');
          assert.equal(calls, 3);
          assert.equal(reads, calls);
          const money = (
            await db.query(
              "SELECT sum(actual_micros) spent,count(*) n FROM generation_budget_reservations WHERE scope_id=$1 AND status='settled'",
              [GENERATION_SCOPE_ID],
            )
          ).rows[0];
          assert.equal(Number(money.spent), 1400);
          assert.equal(Number(money.n), 3);
          await assert.rejects(
            a.engine.quote(owner.user.id, input('foreign', [foreign.id])),
            failureCode('DERIVATIVE_REFERENCE_FORBIDDEN'),
          );
        },
      );
      for (const scenario of ['unknown', '403', 'overrun'])
        await t.test(
          `${scenario} keeps original request reserve/rates, stops further calls, and never retries`,
          async () => {
            // This rollback confines synthetic failure data; it is not an application liability reset/reconciliation path.
            const sql = await db.connect();
            await sql.query('BEGIN');
            let savepoint = 0;
            const store = {
              query: async (q, args = []) => (await sql.query(q, args)).rows,
              tx: async (work) => {
                const name = `estimate_case_${++savepoint}`;
                await sql.query(`SAVEPOINT ${name}`);
                try {
                  const value = await work(sql);
                  await sql.query(`RELEASE SAVEPOINT ${name}`);
                  return value;
                } catch (error) {
                  await sql.query(`ROLLBACK TO SAVEPOINT ${name}`);
                  await sql.query(`RELEASE SAVEPOINT ${name}`);
                  throw error;
                }
              },
            };
            try {
              const fixture = make(cfgA, store),
                q = await fixture.engine.quote(owner.user.id, input(`synthetic ${scenario}`)),
                job = await fixture.engine.enqueue(owner.user.id, consent(q));
              const before = calls;
              outcome = scenario;
              await fixture.engine.workOnce();
              let result = await fixture.engine.get(owner.user.id, job.id);
              assert.equal(calls, before + 1);
              await fixture.engine.workOnce();
              assert.equal(calls, before + 1);
              assert.equal(result.pricingProfileSnapshot.outputImageMicrosPerMillion, 3000000);
              const reservation = (
                await sql.query(
                  'SELECT * FROM generation_budget_reservations WHERE operation_key=$1',
                  [job.id],
                )
              ).rows[0];
              if (scenario === 'overrun') {
                assert.equal(reservation.status, 'settled');
                assert.equal(Number(reservation.actual_micros), 1200100);
                assert.ok(Number(reservation.actual_micros) > q.quote.reserveMicros);
              } else {
                assert.equal(reservation.status, 'held');
                assert.equal(Number(reservation.upper_micros), q.quote.reserveMicros);
              }
              const stopped = (
                await sql.query(
                  'SELECT s.state,b.blocked FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE s.scope_id=$1',
                  [GENERATION_SCOPE_ID],
                )
              ).rows[0];
              if (scenario === 'overrun') assert.equal(stopped.blocked, true);
              else assert.equal(stopped.state, 'stopped');
              await assert.rejects(fixture.engine.quote(owner.user.id, input('must stop')));
              if (scenario === 'unknown') {
                const row = (
                  await sql.query(
                    'SELECT provider_request_id FROM image_generation_jobs WHERE id=$1',
                    [job.id],
                  )
                ).rows[0];
                await fixture.engine.recordResult(job.id, {
                  bytes: png,
                  mime: 'image/png',
                  requestId: row.provider_request_id,
                  actualMicros: 400,
                });
                result = await fixture.engine.get(owner.user.id, job.id);
                assert.equal(result.actualMicros, 400);
                assert.equal(result.pricingProfileSnapshot.outputImageMicrosPerMillion, 3000000);
                assert.equal(
                  (
                    await sql.query('SELECT state FROM live_test_sessions WHERE scope_id=$1', [
                      GENERATION_SCOPE_ID,
                    ])
                  ).rows[0].state,
                  'stopped',
                );
              }
            } finally {
              outcome = 'ok';
              await sql.query('ROLLBACK');
              sql.release();
            }
          },
        );
      await t.test(
        'policy changes invalidate unused/NULL revision work; old POST/GET receipts retain original prices',
        async () => {
          const stale = await a.engine.quote(owner.user.id, input('old unused quote'));
          const rawB = structuredClone(rawA);
          rawB.totalCapMicros = 8000;
          rawB.textCapMicros = 7000;
          rawB.imageCapMicros = 8000;
          rawB.image.outputImageMicrosPerMillion = 4000000;
          const cfgB = readOwnerGenerationConfig(ownerEnvironment(rawB, owner.handle)),
            b = make(cfgB);
          const state = (
            await db.query(
              'SELECT policy_revision,policy_hash FROM live_test_sessions WHERE scope_id=$1',
              [GENERATION_SCOPE_ID],
            )
          ).rows[0];
          await b.authority.amendPolicy(owner.user.id, {
            operationId: randomUUID(),
            expectedRevision: state.policy_revision,
            expectedHash: state.policy_hash,
            candidateFingerprint: cfgB.configFingerprint,
            consent: true,
          });
          await assert.rejects(a.engine.enqueue(owner.user.id, consent(stale)), (error) =>
            ['GENERATION_POLICY_STALE', 'GENERATION_CONFIG_IMMUTABLE'].includes(
              error?.getResponse?.().code,
            ),
          );
          const recovered = await b.engine.enqueue(owner.user.id, firstBody);
          assert.equal(recovered.id, firstDone.id);
          assert.equal(recovered.pricingProfileSnapshot.outputImageMicrosPerMillion, 3000000);
          assert.equal(recovered.actualMicros, 400);
          assert.equal(recovered.policyRevision, 1);
          const current = await b.engine.quote(owner.user.id, input('legacy-null'));
          const stored = (
            await db.query('SELECT * FROM image_generation_quotes WHERE id=$1', [current.quote.id])
          ).rows[0];
          const historicalHash = hash({
            input: stored.input,
            refs: stored.reference_hashes,
            policy: stored.policy_version,
            provider: b.runtime.provider.id,
            upper: Number(stored.upper_micros),
            estimateSnapshotHash: stored.estimate_snapshot.fingerprint,
            pricingProfileHash: stored.pricing_profile_snapshot.fingerprint,
          });
          await db.query(
            'UPDATE image_generation_quotes SET generation_policy_revision=NULL,generation_policy_hash=NULL,request_hash=$2 WHERE id=$1',
            [current.quote.id, historicalHash],
          );
          await assert.rejects(
            b.engine.enqueue(owner.user.id, consent(current)),
            failureCode('GENERATION_POLICY_STALE'),
          );
          const dispatch = await b.engine.quote(owner.user.id, input('null job'));
          const job = await b.engine.enqueue(owner.user.id, consent(dispatch));
          const jobRow = (
            await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id])
          ).rows[0];
          await db.query(
            'UPDATE image_generation_jobs SET generation_policy_revision=NULL,generation_policy_hash=NULL,request_hash=$2 WHERE id=$1',
            [
              job.id,
              hash({
                ...{
                  input: jobRow.input,
                  refs: jobRow.reference_hashes,
                  policy: jobRow.policy_version,
                  provider: b.runtime.provider.id,
                  upper: Number(jobRow.upper_micros),
                },
                estimateSnapshotHash: jobRow.estimate_snapshot.fingerprint,
                pricingProfileHash: jobRow.pricing_profile_snapshot.fingerprint,
              }),
            ],
          );
          const before = calls;
          await b.engine.workOnce();
          assert.equal(calls, before);
          assert.equal((await b.engine.get(owner.user.id, job.id)).status, 'rejected');
          const expensive = await b.engine.quote(owner.user.id, input('known cost'));
          usageOutput = 1000;
          const known = await b.engine.enqueue(owner.user.id, consent(expensive));
          await b.engine.workOnce();
          assert.equal((await b.engine.get(owner.user.id, known.id)).actualMicros, 4100);
          usageOutput = 100;
          const insufficient = await b.engine.quote(owner.user.id, input());
          assert.equal(insufficient.quote.reserveMicros, 6047);
          await assert.rejects(
            b.engine.enqueue(owner.user.id, consent(insufficient)),
            failureCode('GENERATION_BUDGET_EXCEEDED'),
          );
          assert.equal(
            (await b.engine.get(owner.user.id, firstDone.id)).reserveMicros,
            firstDone.reserveMicros,
          );
        },
      );
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
