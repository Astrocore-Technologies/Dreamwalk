// Complete authoring dispatch on disposable PostgreSQL with an injected provider only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile, mkdtemp, rm } = require('node:fs/promises');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');
test(
  'Sparks enabled authoring admission, settlement and independent provider controls',
  { timeout: 90000 },
  async (t) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = `spark-dispatch-${randomUUID()}`;
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const cluster = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const assetDir = await mkdtemp('/tmp/sparks-dispatch-assets-');
    const configModule = require.resolve('../../apps/api/dist/config');
    require.cache[configModule] = {
      id: configModule,
      filename: configModule,
      loaded: true,
      exports: {
        config: { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, ASSET_DIR: assetDir },
      },
    };
    const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
    const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text');
    const { digest } = require('../../apps/api/dist/ai/context');
    const { ProviderFailure } = require('../../apps/api/dist/ai/types');
    const db = {
      query: async (sql, p) => (await pool.query(sql, p)).rows,
      tx: async (f) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const v = await f(c);
          await c.query('COMMIT');
          return v;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
    try {
      for (const file of (await readdir('packages/db/migrations'))
        .filter((x) => x.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(`packages/db/migrations/${file}`, 'utf8'));
      const owner = randomUUID(),
        sessionId = randomUUID(),
        projectId = randomUUID();
      await pool.query(
        'INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)',
        [owner, `${owner}@example.test`, 'fixture', 'Synthetic', 's_' + owner.slice(0, 20)],
      );
      const sourceHash = digest('source'),
        readsetHash = digest('readset');
      await pool.query(
        "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
        [
          projectId,
          owner,
          JSON.stringify({ name: 'Fixture', description: 'Fixture only' }),
          sourceHash,
        ],
      );
      const live = new GenerationAuthority(db, {
        enabled: true,
        sessionId,
        ownerId: owner,
        expiresAt: new Date(Date.now() + 3600000),
      });
      await live.claim(owner, { consent: true });
      let calls = 0,
        mode = 'success';
      const provider = {
        version: 'synthetic-authoring-v1',
        generate: async () => {
          calls++;
          if (mode === 'unknown') throw new ProviderFailure('PROVIDER_OUTCOME_UNKNOWN', true);
          if (mode === 'failure') throw new ProviderFailure('PROVIDER_BAD_RESPONSE', false);
          return {
            proposal: { title: 'Fixture' },
            requestId: `fixture-${calls}`,
            usage: { inputTokens: 1, outputTokens: 1, costMicros: 7, costEvidence: 'reported' },
          };
        },
      };
      const definition = {
        version: 'fixture',
        schema: { type: 'object' },
        instructions: 'Synthetic',
        validateProposal: (p) => p,
      };
      const engine = new AuthoringTextEngine(db, live, provider, definition, 5000);
      const guard = async (c, b) => {
        assert.equal(b.projectId, projectId);
        await c.query('SELECT id FROM visual_authoring_projects WHERE id=$1 FOR UPDATE', [
          projectId,
        ]);
      };
      const binding = { sessionId, projectId, projectRevision: 1, sourceHash, readsetHash };
      const quote = () =>
        engine.quote(
          owner,
          { ...binding, operationId: randomUUID(), context: { fixture: true } },
          guard,
        );
      const enqueue = (q, operationId = randomUUID()) =>
        engine.enqueue(owner, { quoteId: q.id, operationId, consent: true }, guard);
      const hold = async (id) =>
        (
          await pool.query(
            'SELECT h.* FROM spark_holds h JOIN live_authoring_text_jobs j ON j.spark_quote_id=h.id WHERE j.id=$1',
            [id],
          )
        ).rows[0];
      const run = (j) => engine.run(owner, j.id, guard, async () => ({ committed: true }));
      await t.test(
        'disabled quote retains equivalent behavior without creating/funding wallet',
        async () => {
          const q = await quote();
          assert.equal(q.sparks, undefined);
          assert.equal((await pool.query('SELECT * FROM spark_wallets')).rowCount, 0);
        },
      );
      // Explicit fixture-only activation/funding in this brand-new database, never an app endpoint.
      await pool.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,2000000)',
        [owner],
      );
      await t.test('insufficient quote and atomic admission never dispatch', async () => {
        await pool.query('UPDATE spark_wallets SET balance_subunits=1 WHERE owner_id=$1', [owner]);
        await assert.rejects(quote(), (e) => e.getResponse?.().code === 'INSUFFICIENT_SPARKS');
        assert.equal(calls, 0);
        await pool.query('UPDATE spark_wallets SET balance_subunits=2000000 WHERE owner_id=$1', [
          owner,
        ]);
        const q = await quote();
        assert.equal(q.sparks.walletCharging, true);
        assert.equal(q.sparks.rateVersion, 'api-cent-2-sparks-v2');
        await pool.query('UPDATE spark_wallets SET balance_subunits=1 WHERE owner_id=$1', [owner]);
        await assert.rejects(enqueue(q), /INSUFFICIENT_SPARKS/);
        assert.equal(calls, 0);
        assert.equal((await pool.query('SELECT * FROM live_authoring_text_jobs')).rowCount, 0);
        assert.equal(
          (await pool.query('SELECT * FROM generation_budget_reservations')).rowCount,
          0,
        );
        await pool.query('UPDATE spark_wallets SET balance_subunits=2000000 WHERE owner_id=$1', [
          owner,
        ]);
      });
      await t.test(
        'concurrent same operation has one hold, dispatch and exact microcapture',
        async () => {
          const q = await quote(),
            op = randomUUID();
          const [a, b] = await Promise.all([enqueue(q, op), enqueue(q, op)]);
          assert.equal(a.id, b.id);
          assert.equal((await hold(a.id)).status, 'held');
          await Promise.all([run(a), run(a)]);
          assert.equal(calls, 1);
          const h = await hold(a.id);
          assert.equal(h.status, 'settled');
          assert.equal(h.captured_subunits, '14');
          assert.equal((await engine.get(owner, a.id)).status, 'committed');
          await run(a);
          assert.equal(calls, 1);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) n FROM spark_ledger WHERE hold_id=$1 AND kind='capture'",
                [h.id],
              )
            ).rows[0].n,
            '1',
          );
          const snapshot = (
            await pool.query('SELECT price_snapshot FROM spark_quotes WHERE id=$1', [h.id])
          ).rows[0].price_snapshot;
          assert.equal(snapshot.providerQuote.providerVersion, 'synthetic-authoring-v1');
          assert.equal(snapshot.tariff.subunitsPerSpark, '10000');
        },
      );
      await t.test(
        'confirmed undispatched cancellation releases and invalid commit retains failure hold',
        async () => {
          const a = await enqueue(await quote());
          await engine.cancel(owner, a.id);
          assert.equal((await hold(a.id)).status, 'released');
          const {
            settleReservationSparks,
          } = require('../../apps/api/dist/generation/sparks-hooks');
          const releasedReservation = (
            await pool.query('SELECT reservation_id FROM live_authoring_text_jobs WHERE id=$1', [
              a.id,
            ])
          ).rows[0].reservation_id;
          await db.tx((c) =>
            settleReservationSparks(c, releasedReservation, {
              outcome: 'success',
              actualMicros: '0',
              evidence: 'configured_rates',
              receiptId: 'later-semantic-finalize',
            }),
          );
          await db.tx((c) =>
            settleReservationSparks(c, releasedReservation, {
              outcome: 'failure_policy_pending',
              receiptId: 'later-cancel-finalize',
            }),
          );
          assert.equal((await hold(a.id)).status, 'released');
          assert.equal(calls, 1);
          const b = await enqueue(await quote());
          await engine.run(owner, b.id, guard, async () => {
            throw Error('synthetic commit failure');
          });
          assert.equal((await hold(b.id)).status, 'pending');
          assert.equal((await engine.get(owner, b.id)).status, 'stale');
        },
      );
      await t.test(
        'known technical provider failure retains Spark liability without inventing charge',
        async () => {
          mode = 'failure';
          const j = await enqueue(await quote());
          await run(j);
          const h = await hold(j.id);
          assert.equal(h.status, 'pending');
          assert.equal(h.captured_subunits, null);
          const spend = (
            await pool.query(
              'SELECT r.* FROM generation_budget_reservations r JOIN live_authoring_text_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [j.id],
            )
          ).rows[0];
          assert.equal(spend.actual_micros, '0');
        },
      );
      await t.test(
        'paid token-count endpoint binds immutable fixed price and settles once',
        async () => {
          const { LIVE_TEXT } = require('../../apps/api/dist/live-test/config');
          const counter = new GenerationAuthority(db, {
            enabled: true,
            sessionId,
            ownerId: owner,
            expiresAt: live.config.expiresAt,
          });
          // Stub only authorization/turn ports to isolate count admission; real financial
          // scopes, count rows, provider adapter port and both ledgers remain exercised.
          const policy = await db.tx((c) => live.effectivePolicy(c));
          const active = { revision: 1, hash: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) };
          counter.ownerConfig = {
            text: {
              ...LIVE_TEXT,
              contextBudgetTokens: 100000,
              contextTokens: 100000,
              counting: { microsPerRequest: 17 },
            },
          };
          counter.owner = async () => {};
          counter.resolveAuthorizationId = async () => sessionId;
          counter.assertActivePolicy = async () => active;
          counter.effectivePolicy = async () => policy;
          counter.countGate = () => null;
          const campaignId = randomUUID(),
            requestId = randomUUID(),
            turnFence = { roundId: 'count-round', phaseEpoch: 1, rulesetVersion: 1 };
          const turn = { roundId: 'count-round', phaseEpoch: 1, ruleset: { version: 1 } };
          counter.campaign = async () => turn;
          const context = { turnFence };
          await pool.query(
            'INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,$3,$4)',
            [campaignId, owner, 'synthetic', JSON.stringify({ turnController: turn })],
          );
          await pool.query(
            "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,'fixture','speech',$3,$4,$5)",
            [requestId, campaignId, requestId, owner, JSON.stringify(context)],
          );
          let countCalls = 0;
          counter.configureTextCountAdapter({
            version: 'fixture-count-v1',
            countBody: () => JSON.stringify(context),
            count: async () => {
              countCalls++;
              return 10;
            },
          });
          const input = {
            operationId: randomUUID(),
            turnFence,
            policyRevision: 1,
            policyHash: active.hash,
            candidateFingerprint: digest(counter.countCandidate(context)),
            consent: true,
          };
          const receipt = await counter.preflightCount(owner, campaignId, requestId, input);
          assert.equal(receipt.status, 'succeeded');
          await counter.preflightCount(owner, campaignId, requestId, input);
          assert.equal(countCalls, 1);
          const h = (
            await pool.query(
              'SELECT h.*,q.price_snapshot FROM generation_text_counts j JOIN spark_holds h ON h.id=j.spark_quote_id JOIN spark_quotes q ON q.id=h.id WHERE j.id=$1',
              [receipt.id],
            )
          ).rows[0];
          assert.equal(h.captured_subunits, '34');
          assert.equal(h.status, 'settled');
          assert.equal(h.price_snapshot.providerQuote.pricing.microsPerRequest, 17);
        },
      );
      await t.test(
        'manual text permit reserves once, receipt defers capture until semantic commit, cache releases',
        async () => {
          const campaignId = randomUUID();
          await pool.query(
            'INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,$3,$4)',
            [campaignId, owner, 'synthetic', JSON.stringify({})],
          );
          const turn = { roundId: 'fixture-round', phaseEpoch: 1, ruleset: { version: 1 } };
          const originalCampaign = live.campaign;
          live.campaign = async () => turn;
          try {
            const make = async () => {
              const requestId = randomUUID(),
                jobId = randomUUID();
              const context = { turnFence: { roundId: turn.roundId, phaseEpoch: 1 } };
              await pool.query(
                "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,$3,'speech',$4,$5,$6)",
                [requestId, campaignId, jobId, requestId, owner, JSON.stringify(context)],
              );
              const input = {
                sessionId,
                operationId: randomUUID(),
                turnFence: { roundId: turn.roundId, phaseEpoch: 1, rulesetVersion: 1 },
                consent: true,
              };
              const p = await live.consent(owner, campaignId, requestId, input);
              assert.equal(p.sparks.walletCharging, true);
              const replay = await live.consent(owner, campaignId, requestId, input);
              assert.equal(replay.id, p.id);
              assert.deepEqual(replay.sparks, p.sparks);
              await pool.query(
                "INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,request_meta,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at) VALUES($1,$2,$3,$4,'fixture',$5,'system','speech',$6,$7,'fixture','fixture','fixture','running',now()+interval '1 hour')",
                [
                  jobId,
                  campaignId,
                  jobId,
                  randomUUID(),
                  JSON.stringify({ runtimeRequestId: requestId }),
                  digest(context),
                  JSON.stringify(context),
                ],
              );
              return { p, jobId, context };
            };
            const { p, jobId, context } = await make();
            await live.begin({ jobId, context });
            await live.complete(p.id, 9, 'PROVIDER_RESULT', 'fixture-receipt');
            let h = (await pool.query('SELECT * FROM spark_holds WHERE id=$1', [p.sparks.quoteId]))
              .rows[0];
            assert.equal(h.status, 'held');
            await db.tx((c) => live.finalizeNpcSparks(c, jobId, true, 9));
            await db.tx((c) => live.finalizeNpcSparks(c, jobId, true, 9));
            h = (await pool.query('SELECT * FROM spark_holds WHERE id=$1', [p.sparks.quoteId]))
              .rows[0];
            assert.equal(h.status, 'settled');
            assert.equal(h.captured_subunits, '18');
            await pool.query("UPDATE npc_ai_jobs SET status='committed' WHERE id=$1", [jobId]);
            const cached = await make();
            await db.tx(async (c) => {
              await live.settleJob(c, cached.jobId, 0, false);
              await live.finalizeNpcSparks(c, cached.jobId, true, 0);
            });
            assert.equal(
              (
                await pool.query('SELECT status FROM spark_holds WHERE id=$1', [
                  cached.p.sparks.quoteId,
                ])
              ).rows[0].status,
              'released',
            );
            await pool.query("UPDATE npc_ai_jobs SET status='committed' WHERE id=$1", [
              cached.jobId,
            ]);
          } finally {
            live.campaign = originalCampaign;
          }
        },
      );
      await t.test(
        'image quote/admission captures actual only after valid raster; invalid and unknown stay pending',
        async () => {
          const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service');
          const { FixtureImageProvider } = require('../../apps/api/dist/image-generation/provider');
          const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
          const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts');
          // Only the content authorization port is fixture-stubbed; provider scope/caps, queue,
          // raster admission, immutable quote and both ledgers are the real implementations.
          const profile = {
            model: 'fixture-image',
            size: '64x64',
            quality: 'low',
            outputs: 1,
            format: 'png',
            maxPromptUtf8Bytes: 2000,
            maxReferenceImages: 0,
            inputTextMicrosPerMillion: 100,
            inputImageMicrosPerMillion: 200,
            outputImageMicrosPerMillion: 300,
            estimatedTotalMicros: 20,
            reserveMicros: 100,
            estimateRiskAccepted: true,
          };
          const policy = {
            ...defaultImagePolicy,
            generationMode: 'owner',
            ownerImageProfile: profile,
            version: 'fixture-image-policy',
            scopeId: 'fixture-image-sparks',
            approved: true,
            externalEnabled: true,
            costBasis: 'approved_estimate',
            estimatedTotalMicros: 20,
            operationalReserveMicros: 100,
            generationPolicyRevision: 1,
            generationPolicyHash: 'f'.repeat(64),
          };
          let imageCalls = 0,
            imageMode = 'success';
          const raster = new FixtureImageProvider();
          const imageProvider = {
            id: 'fixture-image-v1',
            generate: async (request, id) => {
              imageCalls++;
              if (imageMode === 'unknown') throw Error('fixture unknown');
              const result = await raster.generate(request, id);
              return {
                ...result,
                actualMicros: 13,
                ...(imageMode === 'omitted' ? {} : { costVerifiedForSparks: true }),
                ...(imageMode === 'invalid' ? { bytes: Buffer.from('invalid image') } : {}),
                ...(imageMode === 'unpriced' ? { costVerifiedForSparks: false } : {}),
              };
            },
          };
          class FixtureEngine extends ImageGenerationEngine {
            async authorize() {
              return { hashes: {}, refs: [], livePolicy: policy };
            }
          }
          const images = new FixtureEngine(db, new AssetReuseService(db), imageProvider, policy, {
            requestProfile: { size: '64x64', maxReferenceImages: 0 },
          });
          const input = {
            authoringContext: {
              projectId,
              expectedProjectRevision: 1,
              sourceHash,
              stage: 'concept',
              role: 'concept',
            },
            mode: 'external',
            prompt: 'Fixture raster',
            title: 'Fixture raster',
            kind: 'background',
            camera: 'top-down',
            tags: [],
            background: 'opaque',
            declineReuse: true,
            rights: {
              basis: 'generated',
              licenseLabel: 'Synthetic fixture',
              attribution: '',
              allowAuthorReuse: false,
              attested: true,
            },
          };
          const { OpenAiImageProvider } = require('../../apps/api/dist/image-generation/provider');
          for (const cache of [0, 2, -1, 'malformed', {}, { text_tokens: 0, image_tokens: 3 }]) {
            const adapter = new OpenAiImageProvider({
              enabled: true,
              networkApproved: true,
              apiKey: 'synthetic-only',
              model: 'gpt-image-2.5-sunburst-2026-09-08',
              verifiedUpperMicros: 100,
              inputTextMicrosPerMillion: 100,
              inputImageMicrosPerMillion: 200,
              outputImageMicrosPerMillion: 300,
              fetchImpl: async () =>
                new Response(
                  JSON.stringify({
                    data: [{ b64_json: Buffer.from('fixture').toString('base64') }],
                    usage: {
                      input_tokens: 12,
                      output_tokens: 3,
                      total_tokens: 15,
                      input_tokens_details: {
                        text_tokens: 10,
                        image_tokens: 2,
                        cached_tokens: cache,
                      },
                    },
                  }),
                  { status: 200 },
                ),
            });
            const result = await adapter.generate(input, randomUUID(), []);
            assert.equal(result.actualMicros, 1);
            assert.equal(result.costVerifiedForSparks, cache === 0);
          }
          const imageQuote = async () => (await images.quote(owner, input)).quote;
          const imageEnqueue = (q) =>
            images.enqueue(owner, {
              quoteId: q.id,
              operationId: randomUUID(),
              consent: true,
              estimateRiskConsent: true,
            });
          const q = await imageQuote();
          assert.equal(q.sparks.walletCharging, true);
          assert.equal(q.sparks.rateVersion, 'api-cent-2-sparks-v2');
          const j = await imageEnqueue(q);
          assert.equal(imageCalls, 0);
          await images.workOnce();
          const done = await images.get(owner, j.id);
          assert.equal(done.status, 'admitted');
          assert.equal(done.sparkStatus, 'settled');
          assert.equal(done.sparkCapturedSubunits, '26');
          assert.equal(q.reserveMicros, profile.estimatedTotalMicros);
          assert.equal(q.sparks.reserveSubunits, '40');
          assert.equal(done.sparkReservedSubunits, q.sparks.reserveSubunits);
          const cancelled = await imageEnqueue(await imageQuote());
          await images.cancel(owner, cancelled.id);
          assert.equal((await images.get(owner, cancelled.id)).sparkStatus, 'released');
          assert.equal(imageCalls, 1);
          imageMode = 'invalid';
          const invalid = await imageEnqueue(await imageQuote());
          await images.workOnce();
          const rejected = await images.get(owner, invalid.id);
          assert.equal(rejected.status, 'rejected');
          assert.equal(rejected.sparkStatus, 'pending');
          assert.equal(rejected.sparkCapturedSubunits, null);
          imageMode = 'unpriced';
          const unpriced = await imageEnqueue(await imageQuote());
          await images.workOnce();
          assert.equal((await images.get(owner, unpriced.id)).sparkStatus, 'pending');
          assert.equal(
            (
              await pool.query(
                'SELECT spark_cost_verified FROM image_generation_jobs WHERE id=$1',
                [unpriced.id],
              )
            ).rows[0].spark_cost_verified,
            false,
          );
          imageMode = 'omitted';
          const omittedQuote = await imageQuote();
          const omitted = await imageEnqueue(omittedQuote);
          const originalReserve = (
            await pool.query(
              'SELECT r.id,r.scope_id,r.actor_id,r.operation_key,r.upper_micros,r.spark_quote_id FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [omitted.id],
            )
          ).rows[0];
          await images.workOnce();
          const omittedResult = await images.get(owner, omitted.id);
          assert.equal(omittedResult.status, 'admitted');
          assert.equal(omittedResult.sparkStatus, 'pending');
          assert.equal(omittedResult.sparkCapturedSubunits, null);
          assert.equal(omittedResult.sparkReservedSubunits, omittedQuote.sparks.reserveSubunits);
          assert.equal(
            (
              await pool.query(
                'SELECT spark_cost_verified FROM image_generation_jobs WHERE id=$1',
                [omitted.id],
              )
            ).rows[0].spark_cost_verified,
            false,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT r.id,r.scope_id,r.actor_id,r.operation_key,r.upper_micros,r.spark_quote_id FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
                [omitted.id],
              )
            ).rows[0],
            originalReserve,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM spark_ledger WHERE hold_id=$1 AND kind='capture'",
                [originalReserve.spark_quote_id],
              )
            ).rows[0].n,
            0,
          );
          imageMode = 'unknown';
          const unknown = await imageEnqueue(await imageQuote());
          await images.workOnce();
          const unresolved = await images.get(owner, unknown.id);
          assert.equal(unresolved.status, 'unknown');
          assert.equal(unresolved.sparkStatus, 'pending');
        },
      );
      await t.test(
        'unknown provider result retains both independent liabilities and stops admission',
        async () => {
          mode = 'unknown';
          const j = await enqueue(await quote());
          await run(j);
          assert.equal((await hold(j.id)).status, 'pending');
          const spend = (
            await pool.query(
              'SELECT r.* FROM generation_budget_reservations r JOIN live_authoring_text_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [j.id],
            )
          ).rows[0];
          assert.equal(spend.status, 'held');
          assert.equal(spend.actual_micros, null);
          await assert.rejects(quote());
        },
      );
    } finally {
      await rm(assetDir, { recursive: true, force: true });
      await pool.end();
      await cluster.stop();
    }
  },
);
