/** Isolated service/SQL acceptance. New HTTP routes are not wired into main until the asset tranche. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput, authoredDraft } from '../game/support-authored.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const {
  eraseReusableAssets,
  exportReusableAssets,
} = require('../../apps/api/dist/assets/data-requests.js');
const database = new Db();
const service = new AssetReuseService(database);
const code = (v) => (e) => e?.getResponse?.().code === v;
const op = () => randomUUID();
const metadata = {
  title: 'Reusable painted courtyard',
  kind: 'background',
  style: 'drawn2D',
  camera: 'top-down',
  tags: ['courtyard', 'stone'],
  variant: 'day',
  provenance: { source: 'upload', reference: 'private-source-record' },
  rights: {
    basis: 'owned',
    licenseLabel: 'Author-attested rights',
    attribution: 'Fixture author',
    allowAuthorReuse: true,
    attested: true,
  },
};
const spec = {
  kind: 'background',
  style: 'drawn2D',
  camera: 'top-down',
  tags: ['stone'],
  minWidth: 32,
  minHeight: 32,
};
await test(
  'reusable drawn assets: immutable pins, explicit grants, private delivery and no generation',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const author = await client().register(),
        other = await client().register(),
        outsider = await client().register();
      const uploadId = op();
      await db.query(
        'INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,$4,64,64,100,$5)',
        [uploadId, author.user.id, `${uploadId}.webp`, 'image/webp', 'a'.repeat(64)],
      );
      let art, foreignStory, foreignVersion, grant, ownVersion;
      const version = async (c) => {
        const story = await c.request('/studio/adventures', storyInput());
        await c.request(
          `/studio/adventures/${story.id}/playable-draft`,
          { expectedRevision: 0, draft: authoredDraft() },
          'PUT',
        );
        const v = await c.request(`/studio/adventures/${story.id}/playable-versions`, {
          expectedRevision: 1,
        });
        return { storyId: story.id, versionId: v.versionId };
      };
      const bind = async (c, s, id, revision = 0) =>
        service.saveDraft(c.user.id, s, {
          operationId: op(),
          expectedRevision: revision,
          bindings: [{ slot: 'map:courtyard:background', revisionId: id }],
        });
      const pin = async (c, s) =>
        (
          await c.request(`/studio/adventures/${s}/playable-versions`, {
            expectedRevision: 1,
            expectedArtRevision: 1,
          })
        ).versionId;
      await t.test(
        'search reuses unrestricted-camera art and unrestricted query means any compatible camera',
        async () => {
          const c = await client().register(),
            id = op();
          await db.query(
            'INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,$4,64,64,100,$5)',
            [id, c.user.id, `${id}.webp`, 'image/webp', 'b'.repeat(64)],
          );
          const universal = await service.register(c.user.id, {
            operationId: op(),
            uploadId: id,
            metadata: { ...metadata, camera: 'unrestricted' },
          });
          const selected = await service.resolve(c.user.id, spec);
          assert.equal(selected.decision, 'reuse');
          assert.equal(selected.revision.id, universal.id);
          assert.equal(selected.providerCalls, 0);
          const side = await service.register(c.user.id, {
            operationId: op(),
            uploadId: id,
            metadata: { ...metadata, camera: 'side' },
          });
          const any = await service.search(c.user.id, { ...spec, camera: 'unrestricted' });
          assert.ok(any.some((r) => r.id === side.id));
          assert.ok(any.some((r) => r.id === universal.id));
          assert.ok(!(await service.search(c.user.id, spec)).some((r) => r.id === side.id));
        },
      );
      await t.test('registration is immutable, idempotent and upload-owner gated', async () => {
        const input = { operationId: op(), uploadId, metadata };
        art = await service.register(author.user.id, input);
        assert.deepEqual(await service.register(author.user.id, input), art);
        assert.equal(art.metadata.provenance.reference, undefined);
        assert.equal(art.uploadId, undefined);
        await assert.rejects(
          () => service.register(other.user.id, { ...input, operationId: op() }),
          code('ASSET_NOT_FOUND'),
        );
        await assert.rejects(() =>
          db.query('UPDATE art_asset_revisions SET width=1 WHERE id=$1', [art.id]),
        );
        await assert.rejects(() =>
          service.register(author.user.id, {
            operationId: op(),
            uploadId,
            metadata: { ...metadata, style: 'pixel' },
          }),
        );
      });
      await t.test('unrelated private assets never enter search or direct delivery', async () => {
        assert.deepEqual(await service.search(outsider.user.id, spec), []);
        await outsider.request(`/assets/${uploadId}/file`, undefined, 'GET', 404);
        await assert.rejects(
          () => service.fileDescriptor(outsider.user.id, art.id, {}),
          code('ASSET_NOT_FOUND'),
        );
        assert.equal((await service.search(author.user.id, spec))[0].id, art.id);
        assert.equal((await service.catalog(author.user.id))[0].owned, true);
      });
      await t.test(
        'search before generation returns a proposal only and never changes balances or uploads',
        async () => {
          const before = (await db.query('SELECT count(*) FROM assets')).rows[0].count;
          const wallets = (await db.query('SELECT user_id,balance FROM wallets ORDER BY user_id'))
            .rows;
          const found = await service.resolve(author.user.id, spec);
          assert.equal(found.decision, 'reuse');
          assert.equal(found.charge, 0);
          assert.equal(found.providerCalls, 0);
          const missing = await service.resolve(outsider.user.id, spec);
          assert.equal(missing.decision, 'propose_generation');
          assert.equal(missing.generation.requiresExplicitApproval, true);
          assert.equal((await db.query('SELECT count(*) FROM assets')).rows[0].count, before);
          assert.deepEqual(
            (await db.query('SELECT user_id,balance FROM wallets ORDER BY user_id')).rows,
            wallets,
          );
        },
      );
      await t.test(
        'own-author cross-story pins share one blob and independent campaigns',
        async () => {
          for (let n = 0; n < 2; n++) {
            const v = await version(author);
            await bind(author, v.storyId, art.id);
            v.versionId = await pin(author, v.storyId);
            const manifest = await service.manifest(author.user.id, v.versionId);
            assert.ok(JSON.stringify(manifest).includes(art.id));
            ownVersion = v;
          }
          const a = await author.request('/game/campaigns', {
            playableVersionId: ownVersion.versionId,
          });
          const b = await author.request('/game/campaigns', {
            playableVersionId: ownVersion.versionId,
          });
          assert.notEqual(a.campaignId, b.campaignId);
          assert.deepEqual(
            await service.fileDescriptor(author.user.id, art.id, { campaignId: a.campaignId }),
            await service.fileDescriptor(author.user.id, art.id, { campaignId: b.campaignId }),
          );
          assert.equal(
            (await db.query('SELECT count(*) FROM assets WHERE owner_id=$1', [author.user.id]))
              .rows[0].count,
            '1',
          );
        },
      );
      await t.test(
        'cross-author reuse requires explicit retained-pin consent and handle grant',
        async () => {
          ({ storyId: foreignStory, versionId: foreignVersion } = await version(other));
          await assert.rejects(() => bind(other, foreignStory, art.id), code('ASSET_NOT_FOUND'));
          await assert.rejects(() =>
            service.grant(author.user.id, art.id, {
              operationId: op(),
              granteeHandle: other.handle,
              consent: false,
              retainExistingPins: true,
            }),
          );
          grant = await service.grant(author.user.id, art.id, {
            operationId: op(),
            granteeHandle: other.handle,
            consent: true,
            retainExistingPins: true,
          });
          assert.equal((await service.search(other.user.id, spec))[0].id, art.id);
          await bind(other, foreignStory, art.id);
          foreignVersion = await pin(other, foreignStory);
          await assert.rejects(() => service.grants(other.user.id, art.id));
          assert.equal((await service.grants(author.user.id, art.id)).length, 1);
        },
      );
      await t.test(
        'copy-on-edit preserves published revisions and stale family CAS rejects',
        async () => {
          const updated = await service.register(author.user.id, {
            operationId: op(),
            uploadId,
            familyId: art.familyId,
            expectedFamilyRevision: 1,
            metadata: { ...metadata, title: 'Later edit' },
          });
          assert.equal(updated.revision, 2);
          assert.notEqual(updated.id, art.id);
          await assert.rejects(
            () =>
              service.register(author.user.id, {
                operationId: op(),
                uploadId,
                familyId: art.familyId,
                expectedFamilyRevision: 1,
                metadata,
              }),
            code('STALE_REVISION'),
          );
          const m = JSON.stringify(await service.manifest(other.user.id, foreignVersion));
          assert.ok(m.includes(art.id));
          assert.ok(!m.includes(updated.id));
        },
      );
      await t.test(
        'revocation stops future reuse while exact existing pins retain controlled delivery',
        async () => {
          await service.revoke(author.user.id, art.id, grant.id, op());
          assert.deepEqual(await service.search(other.user.id, spec), []);
          await assert.rejects(
            () => service.fileDescriptor(other.user.id, art.id, {}),
            code('ASSET_NOT_FOUND'),
          );
          assert.equal(
            (
              await service.fileDescriptor(other.user.id, art.id, {
                playableVersionId: foreignVersion,
              })
            ).sha256,
            art.sha256,
          );
          await assert.rejects(
            () =>
              service.fileDescriptor(outsider.user.id, art.id, {
                playableVersionId: foreignVersion,
              }),
            code('NOT_FOUND'),
          );
          const fresh = await version(other);
          await assert.rejects(() => bind(other, fresh.storyId, art.id), code('ASSET_NOT_FOUND'));
        },
      );
      await t.test(
        'takedown invalidates every pinned delivery without exposing original private URL',
        async () => {
          await service.takedown(author.user.id, art.id, op());
          await assert.rejects(
            () =>
              service.fileDescriptor(other.user.id, art.id, { playableVersionId: foreignVersion }),
            code('ASSET_NOT_FOUND'),
          );
          const manifest = JSON.stringify(await service.manifest(other.user.id, foreignVersion));
          assert.ok(manifest.includes('unavailable'));
          assert.ok(!manifest.includes(uploadId));
        },
      );
      await t.test(
        'confirmed erasure scrubs immutable metadata and pin rights without leaking old blobs',
        async () => {
          await assert.rejects(
            () => database.tx((c) => eraseReusableAssets(c, author.user.id)),
            /CONFIRMED_ERASURE_REQUIRED/,
          );
          const before = await database.tx((c) => exportReusableAssets(c, author.user.id));
          assert.equal(before.revisions.length, 2);
          await database.tx(async (c) => {
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [author.user.id]);
            await eraseReusableAssets(c, author.user.id);
            await c.query('DELETE FROM assets WHERE owner_id=$1', [author.user.id]);
          });
          const revisions = (
            await db.query(
              'SELECT r.metadata,r.upload_id FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE f.owner_id=$1',
              [author.user.id],
            )
          ).rows;
          assert.ok(revisions.every((r) => r.metadata.erased === true && r.upload_id === null));
          const m = JSON.stringify(await service.manifest(other.user.id, foreignVersion));
          assert.ok(m.includes('unavailable'));
          assert.ok(!m.includes('Fixture author'));
          assert.ok(
            !(await db.query('SELECT result FROM art_asset_operations')).rows.some((r) =>
              JSON.stringify(r.result).includes('private-source-record'),
            ),
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
