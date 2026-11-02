/** End-to-end authority → authoring quote → durable job, local PG and injected provider only. */
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
const configured = readGenerationConfig({
  GENERATION_MODE: 'release',
  GENERATION_CONFIG_JSON: JSON.stringify({ ...ownerProfile(), aggregateCapMicros: 10000000 }),
});
const authority = new GenerationAuthority(database, configured);
const code = (value) => value?.getResponse?.().code ?? value?.message;
let calls = 0;
const definition = {
  version: 'release-fixture-v1',
  schema: { type: 'object' },
  instructions: 'Synthetic only',
  validateProposal: (proposal) => {
    assert.equal(proposal.title, 'Synthetic proposal');
    return proposal;
  },
};
const provider = {
  version: 'release-fixture-v1',
  generate: async () => {
    calls++;
    return {
      proposal: { title: 'Synthetic proposal' },
      requestId: `synthetic-${calls}`,
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
    };
  },
};
const engine = new AuthoringTextEngine(database, authority, provider, definition);
async function actor(enabled = true) {
  const id = randomUUID(),
    projectId = randomUUID(),
    sourceHash = digest(id),
    readsetHash = digest(projectId);
  const handle = `release_${id.replaceAll('-', '').slice(0, 12)}`;
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'synthetic-unusable-login','Fixture',$3)",
    [id, `${handle}@example.test`, handle],
  );
  await db.query(
    'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,$2,500000)',
    [id, enabled],
  );
  await db.query(
    "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
    [
      projectId,
      id,
      JSON.stringify({ name: 'Synthetic location', description: 'Fixture' }),
      sourceHash,
    ],
  );
  const binding = {
    projectId,
    projectRevision: 1,
    sourceHash,
    readsetHash,
    context: { brief: 'Synthetic location' },
  };
  const guard = async (c, b) => {
    const row = (
      await c.query(
        'SELECT id FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 AND revision=$3 AND source_hash=$4 FOR UPDATE',
        [b.projectId, id, b.projectRevision, b.sourceHash],
      )
    ).rows[0];
    assert.ok(row, 'Source ownership and revision must match');
    assert.equal(b.readsetHash, readsetHash);
  };
  return { id, binding, guard };
}
await test(
  'release ordinary authoring needs no manual claim and remains accountable per actor',
  { timeout: 45000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      const a = await actor(),
        b = await actor(),
        disabled = await actor(false);
      await t.test(
        'GET status has no financial writes and no test expiry/claim requirement',
        async () => {
          const before = (await db.query('SELECT count(*) AS n FROM live_test_sessions')).rows[0].n;
          const status = await authority.status(a.id);
          assert.equal(status.mode, 'release');
          assert.equal(status.state, 'active');
          assert.equal(status.authorizationId, null);
          assert.equal(status.expiresAt, null);
          assert.equal(status.remainingMicros, 500000);
          assert.equal(
            (await db.query('SELECT count(*) AS n FROM live_test_sessions')).rows[0].n,
            before,
          );
          assert.equal((await authority.status(disabled.id)).stopCode, 'SPARK_WALLET_NOT_ENABLED');
          await assert.rejects(
            authority.claim(a.id, { consent: true }),
            (e) => code(e) === 'RELEASE_CLAIM_NOT_REQUIRED',
          );
        },
      );
      await t.test('disabled wallet quote cannot persist a release grant', async () => {
        await assert.rejects(
          engine.quote(
            disabled.id,
            { ...disabled.binding, operationId: randomUUID() },
            disabled.guard,
          ),
          (e) => code(e) === 'SPARK_WALLET_NOT_ENABLED',
        );
        assert.equal(
          (
            await db.query(
              "SELECT id FROM live_test_sessions WHERE owner_id=$1 AND mode='release'",
              [disabled.id],
            )
          ).rowCount,
          0,
        );
      });
      const operationId = randomUUID();
      const qa = await engine.quote(a.id, { ...a.binding, operationId }, a.guard);
      const qb = await engine.quote(b.id, { ...b.binding, operationId: randomUUID() }, b.guard);
      await t.test(
        'first quote binds separate actor scopes; identical quote replay is free',
        async () => {
          assert.equal(calls, 0);
          assert.ok(qa.sparks.quoteId);
          assert.equal(
            (await engine.quote(a.id, { ...a.binding, operationId }, a.guard)).id,
            qa.id,
          );
          const sa = await authority.status(a.id),
            sb = await authority.status(b.id);
          assert.notEqual(sa.authorizationId, sb.authorizationId);
          assert.equal(sa.heldMicros, 0);
          await assert.rejects(
            database.tx((c) => authority.authorizeText(c, b.id, sa.authorizationId)),
            (e) => code(e) === 'GENERATION_AUTHORIZATION_FORBIDDEN',
          );
          await assert.rejects(
            engine.enqueue(
              b.id,
              { quoteId: qa.id, operationId: randomUUID(), consent: true },
              b.guard,
            ),
            (e) => code(e) === 'FORBIDDEN',
          );
        },
      );
      await t.test(
        'two users enqueue; one duplicate is one reservation; fake result captures once',
        async () => {
          const operation = randomUUID();
          const [ja, replay, jb] = await Promise.all([
            engine.enqueue(
              a.id,
              { quoteId: qa.id, operationId: operation, consent: true },
              a.guard,
            ),
            engine.enqueue(
              a.id,
              { quoteId: qa.id, operationId: operation, consent: true },
              a.guard,
            ),
            engine.enqueue(
              b.id,
              { quoteId: qb.id, operationId: randomUUID(), consent: true },
              b.guard,
            ),
          ]);
          assert.equal(ja.id, replay.id);
          assert.notEqual(ja.id, jb.id);
          assert.equal(calls, 0);
          const commit = async (_c, _binding, proposal) => ({ title: proposal.title });
          const [ra, rb] = await Promise.all([
            engine.run(a.id, ja.id, a.guard, commit),
            engine.run(b.id, jb.id, b.guard, commit),
          ]);
          assert.equal(ra.status, 'committed');
          assert.equal(rb.status, 'committed');
          assert.equal(calls, 2);
          await engine.run(a.id, ja.id, a.guard, commit);
          assert.equal(calls, 2);
          const wallet = (
            await db.query(
              'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
              [a.id],
            )
          ).rows[0];
          assert.deepEqual(wallet, { balance_subunits: '499970', held_subunits: '0' });
        },
      );
      await t.test(
        'first release image quote needs no test claim and one durable image settles once',
        async () => {
          const c = await actor(),
            adventureId = randomUUID();
          await db.query(
            "INSERT INTO adventures(id,owner_id,slug,title,genre,data) VALUES($1,$2,$3,'Synthetic image adventure','fantasy','{}')",
            [adventureId, c.id, `release-${adventureId}`],
          );
          const {
            ImageGenerationEngine,
          } = require('../../apps/api/dist/image-generation/service.js');
          const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
          const {
            createOwnerImageRuntime,
          } = require('../../apps/api/dist/image-generation/config.js');
          const sharp = require('sharp');
          let imageCalls = 0;
          const runtime = createOwnerImageRuntime(configured, {
            resolveApiKey: () => assert.fail('No real credential resolver in fixture'),
            fetchImpl: () => assert.fail('No external transport in fixture'),
          });
          const fakeImage = {
            id: runtime.provider.id,
            generate: async () => {
              imageCalls++;
              return {
                bytes: await sharp({
                  create: {
                    width: 1536,
                    height: 1024,
                    channels: 4,
                    background: { r: 75, g: 80, b: 120, alpha: 1 },
                  },
                })
                  .png()
                  .toBuffer(),
                mime: 'image/png',
                actualMicros: 100,
                costVerifiedForSparks: true,
                requestId: `synthetic-release-image-${imageCalls}`,
              };
            },
          };
          const images = new ImageGenerationEngine(
            database,
            new AssetReuseService(database),
            fakeImage,
            runtime.policy,
            runtime.capabilities,
          );
          images.setLiveAuthorizer((client, user, id, input) =>
            authority.authorizeImage(client, user, id, input),
          );
          const request = {
            adventureId,
            prompt: 'Synthetic release location',
            title: 'Synthetic location',
            kind: 'background',
            camera: 'top-down',
            tags: [],
            background: 'opaque',
            referenceRevisionIds: [],
            mode: 'external',
            declineReuse: true,
            rights: {
              basis: 'generated',
              licenseLabel: 'Synthetic fixture',
              attribution: '',
              allowAuthorReuse: false,
              attested: true,
            },
          };
          assert.equal((await authority.status(c.id)).authorizationId, null);
          const response = await images.quote(c.id, request);
          assert.equal(response.quote.generationMode, 'release');
          assert.ok(response.quote.sparks.quoteId);
          assert.equal(imageCalls, 0);
          const input = {
            quoteId: response.quote.id,
            operationId: randomUUID(),
            consent: true,
            estimateRiskConsent: true,
          };
          const job = await images.enqueue(c.id, input);
          assert.equal((await images.enqueue(c.id, input)).id, job.id);
          await images.workOnce();
          const result = await images.get(c.id, job.id);
          assert.equal(result.status, 'admitted');
          assert.ok(result.revisionId);
          assert.equal(imageCalls, 1);
          await images.workOnce();
          assert.equal(imageCalls, 1);
          assert.deepEqual(
            (
              await db.query(
                'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
                [c.id],
              )
            ).rows[0],
            { balance_subunits: '499900', held_subunits: '0' },
          );
        },
      );
      await t.test(
        'expired pricing blocks new dispatch, not historical job inspection or cancellation',
        async () => {
          const user = await actor();
          const q = await engine.quote(
            user.id,
            { ...user.binding, operationId: randomUUID() },
            user.guard,
          );
          const job = await engine.enqueue(
            user.id,
            { quoteId: q.id, operationId: randomUUID(), consent: true },
            user.guard,
          );
          const expired = structuredClone(configured);
          expired.text.pricing.validUntil = new Date(Date.now() - 1000).toISOString();
          expired.image.pricing.validUntil = new Date(Date.now() - 1000).toISOString();
          const historicalAuthority = new GenerationAuthority(database, expired);
          const historicalEngine = new AuthoringTextEngine(
            database,
            historicalAuthority,
            provider,
            definition,
          );
          const priorCalls = calls;
          assert.equal((await historicalEngine.get(user.id, job.id)).status, 'queued');
          await assert.rejects(
            historicalEngine.quote(
              user.id,
              { ...user.binding, operationId: randomUUID() },
              user.guard,
            ),
            (e) => code(e) === 'GENERATION_PRICING_EXPIRED',
          );
          await historicalEngine.cancel(user.id, job.id);
          assert.equal((await historicalEngine.get(user.id, job.id)).status, 'cancelled');
          assert.equal(calls, priorCalls);
          assert.deepEqual(
            (
              await db.query(
                'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
                [user.id],
              )
            ).rows[0],
            { balance_subunits: '500000', held_subunits: '0' },
          );
        },
      );
    } finally {
      await database.onApplicationShutdown();
      await db.end();
    }
  },
);
