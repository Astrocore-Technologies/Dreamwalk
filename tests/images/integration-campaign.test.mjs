/** Real PostgreSQL/HTTP campaign image consent; fixture raster only, no external transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client, until, path } from '../game/support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { prepareSceneMedia } = require('../../apps/api/dist/game/media-preparation.js');
const database = new Db(),
  assets = new AssetReuseService(database);
const rights = {
  basis: 'generated',
  licenseLabel: 'Synthetic fixture attestation',
  attribution: 'Local fixture',
  allowAuthorReuse: true,
  attested: true,
};
function input(source, campaign, prep) {
  const { style: _style, ...spec } = prep.spec;
  return {
    adventureId: source.id,
    ...spec,
    prompt: prep.prompt,
    title: (prep.grounding.subject?.label ?? prep.grounding.map.label).slice(0, 120),
    rights,
    mode: 'mock',
    declineReuse: true,
    campaignContext: {
      campaignId: campaign,
      expectedCanonRevision: prep.grounding.canonRevision,
      groundingHash: prep.groundingHash,
      kind: prep.spec.kind,
    },
  };
}
const code = (value) => (e) => e?.getResponse?.().code === value;
await test(
  'campaign host image generation uses confirmed public geometry and separate explicit binding',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const host = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const source = await host.request('/adventures/old-observatory?view=published');
      const { campaignId } = await host.request('/game/campaigns', {
        playableVersionId: source.playableVersionId,
      });
      await host.request(path(campaignId, 'invitations'), { username: guest.handle });
      await guest.request(path(campaignId, 'accept'), {});
      const sourceBefore = (
        await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
          source.playableVersionId,
        ])
      ).rows[0];
      let prep = await host.request(path(campaignId, 'media-preparation'), { kind: 'background' }),
        body = input(source, campaignId, prep);
      await t.test(
        'non-author host can quote; guest and outsider cannot, arbitrary title/prompt/spec/canon rejected',
        async () => {
          assert.equal(prep.canGenerate, true);
          for (const user of [guest, outsider])
            await user.request('/image-generation/quotes', body, 'POST', 404);
          for (const change of [
            { prompt: 'Invent a secret door' },
            { title: 'Invented map' },
            { tags: ['override'] },
            { background: 'transparent' },
            { campaignContext: { ...body.campaignContext, expectedCanonRevision: 99 } },
          ])
            await host.request('/image-generation/quotes', { ...body, ...change }, 'POST', 409);
          await host.request(
            '/image-generation/quotes',
            {
              ...body,
              campaignContext: {
                ...body.campaignContext,
                kind: 'portrait',
                entityId: 'hidden-off-map',
              },
            },
            'POST',
            404,
          );
          const before = (await db.query('SELECT count(*)::int n FROM image_generation_jobs'))
            .rows[0].n;
          const quote = await host.request('/image-generation/quotes', body);
          assert.equal(quote.decision, 'quote');
          assert.equal(quote.quote.upperMicros, 0);
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM image_generation_jobs')).rows[0].n,
            before,
          );
          await host.request(
            '/image-generation/jobs',
            { quoteId: quote.quote.id, operationId: randomUUID(), consent: false },
            'POST',
            400,
          );
        },
      );
      await t.test(
        'explicit mock consent admits requester-owned raster once; no auto bind or source mutation',
        async () => {
          prep = await host.request(path(campaignId, 'media-preparation'), { kind: 'background' });
          body = input(source, campaignId, prep);
          const quote = await host.request('/image-generation/quotes', body),
            operationId = randomUUID();
          const job = await host.request('/image-generation/jobs', {
            quoteId: quote.quote.id,
            operationId,
            consent: true,
          });
          const result = await until(
            async () => {
              const j = await host.request(`/image-generation/jobs/${job.id}`);
              return j.status === 'admitted' ? j : false;
            },
            (value) => Boolean(value),
            15000,
          );
          assert.equal(result.actualMicros, 0);
          assert.equal(result.operationId, operationId);
          const ownership = (
            await db.query(
              'SELECT f.owner_id FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE r.id=$1',
              [result.revisionId],
            )
          ).rows[0];
          assert.equal(ownership.owner_id, host.user.id);
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM art_campaign_pins WHERE campaign_id=$1', [
                campaignId,
              ])
            ).rows[0].n,
            0,
          );
          const recovered = await host.request(
            `/image-generation/jobs?adventureId=${source.id}&campaignId=${campaignId}`,
          );
          assert.ok(recovered.jobs.some((j) => j.operationId === operationId && j.id === job.id));
          await guest.request(
            `/image-generation/jobs?adventureId=${source.id}&campaignId=${campaignId}`,
            undefined,
            'GET',
            404,
          );
          await host.request(path(campaignId, 'media-bindings'), {
            operationId: randomUUID(),
            expectedCanonRevision: 0,
            expectedMapId: prep.grounding.mapId,
            kind: 'background',
            revisionId: result.revisionId,
          });
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM art_campaign_pins WHERE campaign_id=$1', [
                campaignId,
              ])
            ).rows[0].n,
            1,
          );
          assert.deepEqual(
            (
              await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
                source.playableVersionId,
              ])
            ).rows[0],
            sourceBefore,
          );
        },
      );
      await stopApi();
      const engine = new ImageGenerationEngine(database, assets);
      async function fresh() {
        const row = (
          await db.query(
            'SELECT c.state,c.source_version_id,m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE c.id=$1 AND m.user_id=$2',
            [campaignId, host.user.id],
          )
        ).rows[0];
        return input(
          source,
          campaignId,
          prepareSceneMedia(row.state, row.actor_id, row.source_version_id, { kind: 'background' }),
        );
      }
      await t.test(
        'stale canonical revision prevents dispatch without a provider attempt',
        async () => {
          const q = await engine.quote(host.user.id, await fresh()),
            j = await engine.enqueue(host.user.id, {
              quoteId: q.quote.id,
              operationId: randomUUID(),
              consent: true,
            });
          await db.query(
            'UPDATE game_campaigns SET state=jsonb_set(state,\'{narrativeCanon}\', \'{"revision":1,"turns":[]}\'::jsonb) WHERE id=$1',
            [campaignId],
          );
          await engine.workOnce();
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [j.id],
              )
            ).rows[0].n,
            0,
          );
          assert.notEqual((await engine.get(host.user.id, j.id)).status, 'admitted');
        },
      );
      await t.test(
        'membership revoke then restore permanently invalidates old quoted consent and queued job',
        async () => {
          const q = await engine.quote(host.user.id, await fresh()),
            j = await engine.enqueue(host.user.id, {
              quoteId: q.quote.id,
              operationId: randomUUID(),
              consent: true,
            });
          const unused = await engine.quote(host.user.id, await fresh());
          await db.query(
            "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, host.user.id],
          );
          await db.query(
            "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, host.user.id],
          );
          await assert.rejects(
            engine.enqueue(host.user.id, {
              quoteId: unused.quote.id,
              operationId: randomUUID(),
              consent: true,
            }),
            code('QUOTE_EXPIRED'),
          );
          await engine.workOnce();
          assert.equal((await engine.get(host.user.id, j.id)).status, 'cancelled');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [j.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'a completed mock raster is rejected when canonical geometry changes before admission',
        async () => {
          const {
            FixtureImageProvider,
          } = require('../../apps/api/dist/image-generation/provider.js');
          const fixture = new FixtureImageProvider();
          const delayed = new ImageGenerationEngine(database, assets, {
            id: fixture.id,
            generate: async (...args) => {
              const raster = await fixture.generate(...args);
              await db.query(
                "UPDATE game_campaigns SET state=jsonb_set(state,'{narrativeCanon,revision}','2'::jsonb) WHERE id=$1",
                [campaignId],
              );
              return raster;
            },
          });
          const q = await delayed.quote(host.user.id, await fresh());
          const j = await delayed.enqueue(host.user.id, {
            quoteId: q.quote.id,
            operationId: randomUUID(),
            consent: true,
          });
          await delayed.workOnce();
          const result = await delayed.get(host.user.id, j.id);
          assert.equal(result.status, 'rejected');
          assert.equal(result.revisionId, undefined);
          assert.equal(result.actualMicros, 0);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM assets WHERE id=(SELECT upload_id FROM image_generation_jobs WHERE id=$1)',
                [j.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'source withdrawal while raster is in flight blocks admission and consent cannot revive',
        async () => {
          const {
            FixtureImageProvider,
          } = require('../../apps/api/dist/image-generation/provider.js');
          const fixture = new FixtureImageProvider();
          const prior = (await db.query('SELECT status FROM adventures WHERE id=$1', [source.id]))
            .rows[0].status;
          const delayed = new ImageGenerationEngine(database, assets, {
            id: fixture.id,
            generate: async (...args) => {
              const raster = await fixture.generate(...args);
              await db.query("UPDATE adventures SET status='archived' WHERE id=$1", [source.id]);
              await db.query('UPDATE adventures SET status=$2 WHERE id=$1', [source.id, prior]);
              return raster;
            },
          });
          const q = await delayed.quote(host.user.id, await fresh());
          const j = await delayed.enqueue(host.user.id, {
            quoteId: q.quote.id,
            operationId: randomUUID(),
            consent: true,
          });
          await delayed.workOnce();
          const result = await delayed.get(host.user.id, j.id);
          assert.notEqual(result.status, 'admitted');
          assert.equal(result.revisionId, undefined);
          assert.equal(
            (
              await db.query('SELECT cancel_requested FROM image_generation_jobs WHERE id=$1', [
                j.id,
              ])
            ).rows[0].cancel_requested,
            true,
          );
        },
      );
      await t.test(
        'image authorization ignores stale hot prose after a newer authoritative checkpoint',
        async () => {
          const before = (
            await db.query(
              'SELECT state,revision,source_version_id FROM game_campaigns WHERE id=$1',
              [campaignId],
            )
          ).rows[0];
          const actorId = (
            await db.query(
              'SELECT actor_id FROM game_members WHERE campaign_id=$1 AND user_id=$2',
              [campaignId, host.user.id],
            )
          ).rows[0].actor_id;
          const stale = structuredClone(before.state);
          stale.narrativePremise = {
            title: 'ERASED_PRIVATE_TITLE',
            summary: 'ERASED_PRIVATE_CANON',
            world: 'ERASED_PRIVATE_WORLD',
          };
          const staleBody = input(
            source,
            campaignId,
            prepareSceneMedia(stale, actorId, before.source_version_id, { kind: 'background' }),
          );
          await db.query('UPDATE game_campaigns SET revision=revision+1 WHERE id=$1', [campaignId]);
          engine.attachRuntimeStateReader(() => ({
            state: stale,
            dbRevision: Number(before.revision),
          }));
          await assert.rejects(engine.quote(host.user.id, staleBody), code('MEDIA_CONTEXT_STALE'));
          const safe = await engine.quote(host.user.id, await fresh());
          const stored = (
            await db.query('SELECT input FROM image_generation_quotes WHERE id=$1', [safe.quote.id])
          ).rows[0].input;
          assert.equal(JSON.stringify(stored).includes('ERASED_PRIVATE'), false);
          // On an exact revision, a live position change must still affect current-map visibility.
          const current = (
            await db.query('SELECT state,revision FROM game_campaigns WHERE id=$1', [campaignId])
          ).rows[0];
          const live = structuredClone(current.state);
          live.entities[actorId].mapId = 'roof';
          live.entities[actorId].x = 2;
          live.entities[actorId].y = 3;
          engine.attachRuntimeStateReader(() => ({
            state: live,
            dbRevision: Number(current.revision),
          }));
          await assert.rejects(
            engine.quote(host.user.id, await fresh()),
            code('MEDIA_CONTEXT_STALE'),
          );
          engine.attachRuntimeStateReader(() => undefined);
        },
      );
      await t.test(
        'confirmed member erasure redacts other payer campaign prompts and tombstones derived raster without forgiving liability',
        async () => {
          const {
            eraseImageGeneration,
          } = require('../../apps/api/dist/image-generation/data-requests.js');
          await assert.rejects(
            database.tx((c) => eraseImageGeneration(c, guest.user.id)),
            /CONFIRMED_ERASURE_REQUIRED/,
          );
          const q = await engine.quote(host.user.id, await fresh());
          const pending = await engine.enqueue(host.user.id, {
            quoteId: q.quote.id,
            operationId: randomUUID(),
            consent: true,
          });
          await db.query("UPDATE image_generation_jobs SET status='unknown' WHERE id=$1", [
            pending.id,
          ]);
          const ledgerBefore = (
            await db.query(
              'SELECT r.* FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [pending.id],
            )
          ).rows[0];
          await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
          const cleanup = await database.tx(async (c) => {
            await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
            return eraseImageGeneration(c, guest.user.id);
          });
          assert.ok(cleanup.derivedRasterFilenames.length >= 1);
          assert.ok(cleanup.derivedRasterFilenames.every((f) => /^[a-f0-9-]{36}\.webp$/.test(f)));
          const pendingAfter = (
            await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [pending.id])
          ).rows[0];
          assert.deepEqual(pendingAfter.input, {});
          assert.equal(pendingAfter.cancel_requested, true);
          assert.equal(pendingAfter.status, 'unknown');
          const ledgerAfter = (
            await db.query(
              'SELECT r.* FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [pending.id],
            )
          ).rows[0];
          assert.deepEqual(ledgerAfter, ledgerBefore);
          const related = (
            await db.query('SELECT input FROM image_generation_jobs WHERE actor_id=$1', [
              host.user.id,
            ])
          ).rows;
          assert.ok(related.every((j) => Object.keys(j.input).length === 0));
          assert.ok(
            (
              await db.query(
                "SELECT r.id FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE t.reason_code='erasure' AND r.metadata='{\"erased\":true}' AND r.upload_id IS NULL",
              )
            ).rowCount >= 1,
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
