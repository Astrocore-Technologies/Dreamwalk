// Real disposable PostgreSQL only. No existing app, data, credentials or provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile, mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');
const code = (expected) => (error) => error.getResponse?.().code === expected;

test(
  'private publication and scoped authoring against a fresh real PostgreSQL schema',
  { timeout: 90000 },
  async (t) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = `release-${randomUUID()}`;
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const cluster = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-release-fixture-'));
    const configModule = require.resolve('../../apps/api/dist/config.js');
    require.cache[configModule] = {
      id: configModule,
      filename: configModule,
      loaded: true,
      exports: {
        config: {
          DATABASE_URL: process.env.DATABASE_URL,
          ASSET_DIR: assetDir,
          NODE_ENV: 'test',
          WEB_ORIGIN: 'http://localhost',
        },
      },
    };
    const {
      PrivateReleaseService,
    } = require('../../apps/api/dist/story-authoring/private-release.js');
    const { StoryNpcService } = require('../../apps/api/dist/story-authoring/npcs.js');
    const {
      Content,
      ContentController,
      adventureSelect,
      publicAdventureSql,
    } = require('../../apps/api/dist/content.js');
    const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
    const { sourceAccessSql } = require('../../apps/api/dist/game/source-access.js');
    const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
    const { AssetsController } = require('../../apps/api/dist/assets.js');
    const { AdminController } = require('../../apps/api/dist/admin.js');
    const { adventureSchema, npcSchema } = require('../../packages/contracts/dist');
    const { createAuthoredDraft } = require('../../packages/game-core/dist');
    const db = {
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      tx: async (work) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const result = await work(c);
          await c.query('COMMIT');
          return result;
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        } finally {
          c.release();
        }
      },
    };
    const owner = randomUUID(),
      invited = randomUUID(),
      outsider = randomUUID();
    const auth = {
      require: async (req) => req.user,
      admin: async (req) => {
        assert.equal(req.user.role, 'admin');
        return req.user;
      },
      current: async (req) => req.user ?? null,
      viewer: async (req) =>
        req.user?.emailVerificationRequired && !req.user.emailVerified ? null : (req.user ?? null),
      ownedAsset: async (user, id) => {
        if (
          id &&
          !(await db.query('SELECT id FROM assets WHERE id=$1 AND owner_id=$2', [id, user])).length
        )
          throw Error('not owned');
      },
    };
    const playable = new PlayableService(db, auth, new AssetReuseService(db));
    const releases = new PrivateReleaseService(db, playable),
      content = new Content(db, auth);
    const controller = new ContentController(db, auth, content, playable),
      assets = new AssetsController(db, auth);
    const storyNpcs = new StoryNpcService(db);
    const admin = new AdminController(db, auth, content, {}, new AssetReuseService(db));
    const adminRequest = (id) => ({ user: { id, role: 'admin' } });
    const request = (id) => ({ user: { id, role: 'user' } });
    const storyId = randomUUID(),
      secondStory = randomUUID(),
      templateId = randomUUID();
    const coverId = randomUUID(),
      laterCoverId = randomUUID();
    let release, privateTest, source;
    const story = async () => (await db.query(adventureSelect + ' WHERE a.id=$1', [storyId]))[0];
    const access = async (id, version) =>
      (
        await db.query(
          `SELECT ${sourceAccessSql('$1')} AS allowed FROM (SELECT $2::uuid AS source_version_id)c`,
          [id, version],
        )
      )[0].allowed;
    const file = async (id, viewer) => {
      let bytes;
      const headers = {};
      await assets.file(id, request(viewer), {
        setHeader: (key, value) => {
          headers[key] = value;
        },
        send: (value) => {
          bytes = value;
        },
      });
      return { bytes, headers };
    };
    try {
      for (const name of (await readdir('packages/db/migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(join('packages/db/migrations', name), 'utf8'));
      for (const id of [owner, invited, outsider])
        await pool.query(
          'INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)',
          [id, `${id}@example.invalid`, 'synthetic-not-a-password', 'Fixture user', id],
        );
      for (const id of [coverId, laterCoverId]) {
        await writeFile(join(assetDir, `${id}.webp`), 'synthetic ACL fixture');
        await pool.query(
          'INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,$4,1,1,21,$5)',
          [id, owner, `${id}.webp`, 'image/webp', 'synthetic'],
        );
      }
      await pool.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3)', [
        templateId,
        owner,
        JSON.stringify(
          npcSchema.parse({
            name: 'Fixture keeper',
            biography: 'PRIVATE BIOGRAPHY',
            secrets: 'PRIVATE SECRET',
            portraitAssetId: coverId,
          }),
        ),
      ]);
      source = adventureSchema.parse({
        title: 'Private opening',
        synopsis: 'Synthetic opening',
        coverAssetId: coverId,
        content: {
          world: 'Fixture world',
          locations: [
            { id: 'author-location', name: 'Courtyard', description: 'A synthetic space' },
          ],
          npcIds: [templateId],
        },
      });
      for (const id of [storyId, secondStory])
        await pool.query(
          'INSERT INTO adventures(id,owner_id,slug,title,genre,data) VALUES($1,$2,$3,$4,$5,$6)',
          [id, owner, id, source.title, source.genre, JSON.stringify(source)],
        );
      const draft = createAuthoredDraft('courtyard');
      draft.maps[0].sourceLocationId = 'author-location';
      draft.npcs[0].sourceNpcId = templateId;
      await pool.query('INSERT INTO adventure_game_drafts(adventure_id,draft) VALUES($1,$2)', [
        storyId,
        JSON.stringify(draft),
      ]);
      await pool.query(
        "INSERT INTO adventure_invitations(adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,'accepted')",
        [storyId, owner, invited],
      );
      await t.test(
        'owner private test is not a published release or invitation grant',
        async () => {
          privateTest = (
            await playable.compilePrivate(request(owner), storyId, {
              expectedRevision: 1,
              expectedArtRevision: 0,
            })
          ).versionId;
          assert.equal(await content.access(await story(), request(owner).user), 'owner');
          assert.equal(await content.access(await story(), request(invited).user), null);
          assert.ok(!(await admin.adventures(adminRequest(invited))).some((a) => a.id === storyId));
          assert.ok(!(await admin.npcs(adminRequest(invited))).some((n) => n.id === templateId));
          assert.equal(await access(owner, privateTest), true);
          assert.equal(await access(invited, privateTest), false);
          await assert.rejects(playable.versions(request(invited), storyId), code('NOT_FOUND'));
          await assert.rejects(controller.detail(storyId, request(invited)), code('NOT_FOUND'));
          await assert.rejects(file(coverId, invited), code('NOT_FOUND'));
          assert.equal((await file(coverId, owner)).headers['Cache-Control'], 'no-store');
        },
      );
      await t.test(
        'explicit publication is CAS-protected, idempotent, immutable and private',
        async () => {
          const next = { ...source, title: 'Released opening' };
          await pool.query('UPDATE adventures SET title=$2,data=$3 WHERE id=$1', [
            storyId,
            next.title,
            JSON.stringify(next),
          ]);
          const input = {
            operationId: randomUUID(),
            expectedEditRevision: Number((await story()).edit_revision),
            expectedGameRevision: 1,
            expectedArtRevision: 0,
          };
          await assert.rejects(releases.publish(outsider, storyId, input), code('NOT_FOUND'));
          await assert.rejects(
            releases.publish(owner, storyId, { ...input, expectedEditRevision: 1 }),
            code('STALE_STATE'),
          );
          const results = await Promise.all([
            releases.publish(owner, storyId, input),
            releases.publish(owner, storyId, input),
          ]);
          assert.deepEqual(results[0], results[1]);
          release = results[0];
          assert.notEqual(release.playableVersionId, privateTest);
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM adventure_private_releases'))[0].n,
            1,
          );
          await assert.rejects(
            releases.publish(owner, storyId, { ...input, expectedGameRevision: 2 }),
            code('IDEMPOTENCY_CONFLICT'),
          );
          await assert.rejects(
            pool.query("UPDATE adventure_private_releases SET snapshot='{}' WHERE id=$1", [
              release.releaseId,
            ]),
            /immutable/i,
          );
          assert.equal(
            (
              await db.query(`SELECT count(*)::int n FROM adventures a WHERE ${publicAdventureSql}`)
            )[0].n,
            0,
          );
        },
      );
      await t.test(
        'invited reader sees only released snapshot/package and safe NPC fields',
        async () => {
          const detail = await controller.detail(storyId, request(invited));
          assert.equal(detail.title, 'Released opening');
          assert.equal(detail.status, 'published');
          assert.equal(detail.playableVersionId, release.playableVersionId);
          assert.equal(detail.npcs[0].secrets, undefined);
          assert.equal(detail.npcs[0].biography, undefined);
          const versions = await playable.versions(request(invited), storyId);
          assert.deepEqual(
            versions.versions.map((v) => v.id),
            [release.playableVersionId],
          );
          assert.equal(await access(invited, release.playableVersionId), true);
          assert.equal(await access(invited, privateTest), false);
          assert.equal(await access(outsider, release.playableVersionId), false);
          await assert.rejects(controller.detail(storyId, request(outsider)), code('NOT_FOUND'));
          await assert.rejects(
            controller.detail(storyId, {
              user: {
                id: invited,
                role: 'user',
                emailVerificationRequired: true,
                emailVerified: false,
              },
            }),
            code('NOT_FOUND'),
          );
          await assert.rejects(
            db.tx((c) => playable.resolveForStart(c, invited, privateTest, randomUUID(), 1)),
            code('FORBIDDEN'),
          );
          const state = await db.tx((c) =>
            playable.resolveForStart(c, invited, release.playableVersionId, randomUUID(), 1),
          );
          assert.equal(state.narrativeSource.versionId, release.playableVersionId);
        },
      );
      await t.test('draft edits do not leak through detail or raw asset ACL', async () => {
        await pool.query(
          "UPDATE adventures SET title='Unreleased changes',status='draft',data=jsonb_set(jsonb_set(data,'{title}','\"Unreleased changes\"'),'{coverAssetId}',to_jsonb($2::text)) WHERE id=$1",
          [storyId, laterCoverId],
        );
        assert.equal(
          (await controller.detail(storyId, request(invited))).title,
          'Released opening',
        );
        assert.equal(
          (await controller.detail(storyId, request(owner))).title,
          'Unreleased changes',
        );
        assert.equal((await file(coverId, invited)).bytes.toString(), 'synthetic ACL fixture');
        await assert.rejects(file(laterCoverId, invited), code('NOT_FOUND'));
        await assert.rejects(file(coverId, outsider), code('NOT_FOUND'));
      });
      await t.test(
        'invited admin reads frozen private release and NPCs, never live private drafts',
        async () => {
          await pool.query("UPDATE users SET role='admin' WHERE id=$1", [invited]);
          const unreleasedNpc = randomUUID();
          await pool.query(
            `UPDATE npcs SET data=jsonb_set(jsonb_set(data,'{name}','"Unreleased keeper"'),'{portraitAssetId}',to_jsonb($2::text)) WHERE id=$1`,
            [templateId, laterCoverId],
          );
          await pool.query('INSERT INTO npcs(id,owner_id,data,story_id) VALUES($1,$2,$3,$4)', [
            unreleasedNpc,
            owner,
            JSON.stringify(
              npcSchema.parse({
                name: 'Unreleased stranger',
                biography: 'UNRELEASED BIO',
                secrets: 'UNRELEASED SECRET',
              }),
            ),
            storyId,
          ]);
          await pool.query(
            "UPDATE adventures SET data=jsonb_set(data,'{content,npcIds}',$2::jsonb) WHERE id=$1",
            [storyId, JSON.stringify([unreleasedNpc])],
          );
          const listed = (await admin.adventures(adminRequest(invited))).find(
            (a) => a.id === storyId,
          );
          assert.equal(listed.title, 'Released opening');
          assert.equal(listed.status, 'published');
          assert.equal(listed.coverAssetId, coverId);
          assert.equal(listed.editRevision, undefined);
          assert.deepEqual(listed.content.npcIds, [templateId]);
          assert.ok(
            (await admin.adventures(adminRequest(invited), 'published')).some(
              (a) => a.id === storyId,
            ),
          );
          assert.ok(
            !(await admin.adventures(adminRequest(invited), 'draft')).some((a) => a.id === storyId),
          );
          const listedNpcs = await admin.npcs(adminRequest(invited)),
            releasedNpc = listedNpcs.find((n) => n.id === templateId);
          assert.equal(releasedNpc.name, 'Fixture keeper');
          assert.equal(releasedNpc.portraitAssetId, coverId);
          assert.equal(releasedNpc.secrets, undefined);
          assert.equal(releasedNpc.biography, undefined);
          assert.ok(!listedNpcs.some((n) => n.id === unreleasedNpc));
          assert.ok(
            !(await admin.adventures(adminRequest(outsider))).some((a) => a.id === storyId),
          );
          assert.ok(
            !(await admin.npcs(adminRequest(outsider))).some(
              (n) => n.id === templateId || n.id === unreleasedNpc,
            ),
          );
          assert.equal(
            (await admin.adventures(adminRequest(owner))).find((a) => a.id === storyId).title,
            'Unreleased changes',
          );
          assert.ok((await admin.npcs(adminRequest(owner))).some((n) => n.id === unreleasedNpc));
          // Existing public moderation still sees submitted content; this is not private access.
          const publicId = randomUUID(),
            publicNpc = randomUUID();
          await pool.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3)', [
            publicNpc,
            owner,
            JSON.stringify(
              npcSchema.parse({
                name: 'Public review NPC',
                secrets: 'MODERATION SECRET',
                biography: 'MODERATION BIO',
              }),
            ),
          ]);
          const publicData = adventureSchema.parse({
            ...source,
            title: 'Public review',
            visibility: 'public',
            content: { ...source.content, npcIds: [publicNpc] },
          });
          await pool.query(
            "INSERT INTO adventures(id,owner_id,slug,title,genre,visibility,status,data) VALUES($1,$2,$3,$4,$5,'public','pending_review',$6)",
            [
              publicId,
              owner,
              publicId,
              publicData.title,
              publicData.genre,
              JSON.stringify(publicData),
            ],
          );
          assert.ok(
            (await admin.adventures(adminRequest(invited), 'pending_review')).some(
              (a) => a.id === publicId,
            ),
          );
          const publicRow = (await admin.npcs(adminRequest(invited))).find(
            (n) => n.id === publicNpc,
          );
          assert.equal(publicRow.name, 'Public review NPC');
          assert.equal(publicRow.secrets, undefined);
        },
      );
      await t.test(
        'cross-story NPC references and edits are rejected in real transactions',
        async () => {
          const created = await storyNpcs.create(owner, secondStory, {
            requestId: randomUUID(),
            expectedStoryRevision: 1,
            npc: { name: 'Other story only' },
          });
          await assert.rejects(
            content.validateReferences(
              owner,
              { ...source, content: { ...source.content, npcIds: [created.npc.id] } },
              false,
              storyId,
            ),
            code('FORBIDDEN'),
          );
          await assert.rejects(
            storyNpcs.update(owner, storyId, created.npc.id, {
              requestId: randomUUID(),
              expectedStoryRevision: Number((await story()).edit_revision),
              expectedNpcRevision: 1,
              patch: { name: 'Wrong story edit' },
            }),
            code('NOT_FOUND'),
          );
          const wrong = structuredClone(draft);
          wrong.npcs[0].sourceNpcId = created.npc.id;
          await assert.rejects(
            playable.save(request(owner), storyId, { expectedRevision: 1, draft: wrong }),
            code('FORBIDDEN'),
          );
        },
      );
      await t.test(
        'revocation removes released content, asset, version and campaign-source access',
        async () => {
          await pool.query(
            "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1 AND recipient_id=$2",
            [storyId, invited],
          );
          assert.equal(await access(invited, release.playableVersionId), false);
          assert.ok(!(await admin.adventures(adminRequest(invited))).some((a) => a.id === storyId));
          assert.ok(!(await admin.npcs(adminRequest(invited))).some((n) => n.id === templateId));
          assert.equal(await access(owner, release.playableVersionId), true);
          await assert.rejects(controller.detail(storyId, request(invited)), code('NOT_FOUND'));
          await assert.rejects(playable.versions(request(invited), storyId), code('NOT_FOUND'));
          await assert.rejects(file(coverId, invited), code('NOT_FOUND'));
        },
      );
    } finally {
      await pool.end();
      await cluster.stop();
      await rm(assetDir, { recursive: true, force: true });
    }
  },
);
