// Disposable synthetic PostgreSQL fixtures only. Never touches an existing server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');
const code = (expected) => (error) => error.getResponse?.().code === expected;

test(
  'recoverable admin deletion preserves saves, privacy and replay safety',
  { timeout: 90000 },
  async (t) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.LOCAL_POSTGRES_PORT = String(server.address().port);
    await new Promise((resolve) => server.close(resolve));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = `admin-delete-${randomUUID()}`;
    delete process.env.DATABASE_URL;
    const { forceMockNpcTestEnvironment } = await import('../../scripts/mock-npc-test-env.mjs');
    forceMockNpcTestEnvironment();
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const cluster = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ended = [];
    pool.on('connect', (client) =>
      ended.push(new Promise((resolve) => client.once('end', resolve))),
    );
    const configModule = require.resolve('../../apps/api/dist/config.js');
    require.cache[configModule] = {
      id: configModule,
      filename: configModule,
      loaded: true,
      exports: {
        config: {
          DATABASE_URL: process.env.DATABASE_URL,
          NODE_ENV: 'test',
          WEB_ORIGIN: 'http://localhost',
        },
      },
    };
    const { AdminController } = require('../../apps/api/dist/admin.js');
    const {
      Content,
      ContentController,
      adventureSelect,
    } = require('../../apps/api/dist/content.js');
    const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
    const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
    const { sourceAccessSql, sourceLiveSql } = require('../../apps/api/dist/game/source-access.js');
    const { fail } = require('../../apps/api/dist/errors.js');
    const { adventureSchema } = require('../../packages/contracts/dist');
    const db = {
      query: async (sql, values) => (await pool.query(sql, values)).rows,
      tx: async (work) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const owner = randomUUID(),
      adminId = randomUUID(),
      otherAdmin = randomUUID(),
      invited = randomUUID();
    const req = (id, role = 'user') => ({ user: { id, role } });
    const adminReq = req(adminId, 'admin');
    const auth = {
      require: async (request) => request.user,
      current: async (request) => request.user ?? null,
      viewer: async (request) => request.user ?? null,
      admin: async (request) => {
        if (request.user?.role !== 'admin') fail(403, 'FORBIDDEN', 'FORBIDDEN');
        return request.user;
      },
    };
    const content = new Content(db, auth),
      art = new AssetReuseService(db);
    const playable = new PlayableService(db, auth, art);
    const controller = new ContentController(db, auth, content, playable);
    const admin = new AdminController(db, auth, content, {}, art);
    const story = async (id) => (await db.query(adventureSelect + ' WHERE a.id=$1', [id]))[0];
    const input = async (id) => ({
      operationId: randomUUID(),
      expectedRevision: (
        await db.query(
          "SELECT md5(a.xmin::text || ':' || a.updated_at::text || ':' || a.id::text) AS revision FROM adventures a WHERE a.id=$1",
          [id],
        )
      )[0].revision,
    });
    const create = async (visibility = 'public', status = 'published', author = owner) => {
      const id = randomUUID();
      const data = adventureSchema.parse({
        title: `Synthetic ${id}`,
        genre: 'Тайна',
        visibility,
        status,
        content: { world: 'PRIVATE DRAFT MARKER' },
      });
      const published =
        status === 'published' && visibility === 'public'
          ? { ...data, title: 'Released title', content: { world: '' } }
          : null;
      await pool.query(
        'INSERT INTO adventures(id,owner_id,slug,title,genre,status,visibility,data,published_snapshot) VALUES($1::uuid,$2,($1::uuid)::text,$3,$4,$5,$6,$7,$8)',
        [id, author, data.title, data.genre, status, visibility, data, published],
      );
      return id;
    };
    let id, operation, version, campaign;
    try {
      for (const name of (await readdir('packages/db/migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(join('packages/db/migrations', name), 'utf8'));
      for (const user of [owner, adminId, otherAdmin, invited])
        await pool.query(
          'INSERT INTO users(id,email,password_hash,name,handle) VALUES($1::uuid,$2,$3,$4,($1::uuid)::text)',
          [user, `${user}@example.invalid`, 'synthetic', 'Fixture'],
        );

      await t.test(
        'only admins can remove, restore and list trash; foreign private drafts stay hidden',
        async () => {
          const privateId = await create('private', 'draft');
          const body = await input(privateId);
          await assert.rejects(
            admin.removeAdventure(privateId, body, req(owner)),
            code('FORBIDDEN'),
          );
          await assert.rejects(
            admin.restoreAdventure(privateId, { deletionId: body.operationId }, req(owner)),
            code('FORBIDDEN'),
          );
          await assert.rejects(admin.deletedAdventures(req(owner)), code('FORBIDDEN'));
          await assert.rejects(admin.removeAdventure(privateId, body, adminReq), code('NOT_FOUND'));
          assert.equal((await story(privateId)).deleted_at, null);
        },
      );

      await t.test(
        'stale deletion has no side effects and malformed input is rejected',
        async () => {
          id = await create();
          operation = await input(id);
          await pool.query(
            "UPDATE adventures SET updated_at=updated_at+interval '1 second' WHERE id=$1",
            [id],
          );
          await assert.rejects(admin.removeAdventure(id, operation, adminReq), code('STALE_STATE'));
          await assert.rejects(
            admin.removeAdventure(id, { ...operation, unexpected: true }, adminReq),
          );
          assert.equal((await db.query('SELECT * FROM adventure_deletion_operations')).length, 0);
          operation = await input(id);
        },
      );

      await t.test(
        'concurrent deletion preserves immutable versions and saves while closing every story route',
        async () => {
          version = randomUUID();
          campaign = randomUUID();
          await pool.query(
            "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'private',$3,'fixture')",
            [version, id, { saved: 'immutable' }],
          );
          await pool.query(
            "INSERT INTO game_campaigns(id,owner_id,playable_version,source_version_id,state) VALUES($1,$2,'fixture',$3,$4)",
            [campaign, owner, version, { progress: 'KEEP PLAYER SAVE' }],
          );
          await pool.query(
            "INSERT INTO adventure_invitations(adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,'accepted')",
            [id, owner, invited],
          );
          await pool.query(
            "INSERT INTO npc_ai_jobs(campaign_id,npc_id,operation_id,request_hash,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at) VALUES($1,'fixture-npc',$2,'fixture','system','plan','fixture','{}','mock','fixture','fixture','queued',now()+interval '1 hour')",
            [campaign, randomUUID()],
          );
          await pool.query(
            "INSERT INTO npc_ai_sponsors(campaign_id,payer_user_id,operation_id,request_hash,total_credits,per_operation_credits,max_operations,total_provider_micros,per_operation_provider_micros,purposes,provider_id,provider_version,policy_version,expires_at) VALUES($1,$2,$3,'fixture',0,0,1,0,0,ARRAY['plan'],'mock','fixture','fixture',now()+interval '1 hour')",
            [campaign, owner, randomUUID()],
          );
          const responses = await Promise.all([
            admin.removeAdventure(id, operation, adminReq),
            admin.removeAdventure(id, operation, adminReq),
          ]);
          assert.ok(responses.every((response) => response.deleted));
          assert.equal((await story(id)).status, 'archived');
          assert.equal(
            (
              await db.query('SELECT cancel_requested FROM npc_ai_jobs WHERE campaign_id=$1', [
                campaign,
              ])
            )[0].cancel_requested,
            true,
          );
          assert.ok(
            (
              await db.query('SELECT revoked_at FROM npc_ai_sponsors WHERE campaign_id=$1', [
                campaign,
              ])
            )[0].revoked_at,
          );

          assert.equal(
            (
              await db.query(
                "SELECT * FROM audit WHERE target_id=$1 AND action='adventure.delete'",
                [id],
              )
            ).length,
            1,
          );
          assert.equal(
            (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaign]))[0].state
              .progress,
            'KEEP PLAYER SAVE',
          );
          assert.equal(
            (await db.query('SELECT package FROM game_playable_versions WHERE id=$1', [version]))[0]
              .package.saved,
            'immutable',
          );
          assert.equal(
            (
              await db.query('SELECT status FROM adventure_invitations WHERE adventure_id=$1', [id])
            )[0].status,
            'revoked',
          );
          for (const request of [req(owner), req(invited), adminReq, {}])
            await assert.rejects(controller.detail(id, request), code('NOT_FOUND'));
          await assert.rejects(content.own(id, owner), code('NOT_FOUND'));
          await assert.rejects(content.save(id, owner, { title: 'Resurrect' }), code('NOT_FOUND'));
          await assert.rejects(controller.duplicate(id, req(owner)), code('NOT_FOUND'));
          await assert.rejects(controller.submit(id, req(owner)), code('NOT_FOUND'));
          await assert.rejects(controller.versions(id, req(owner)), code('NOT_FOUND'));
          await assert.rejects(playable.draft(req(owner), id), code('NOT_FOUND'));
          await assert.rejects(
            admin.moderate(id, { decision: 'reject', reason: 'fixture' }, adminReq),
            code('NOT_FOUND'),
          );
          assert.ok(!(await controller.studio(req(owner))).some((story) => story.id === id));
          assert.ok(
            !(await controller.library(req(owner))).drafts.some((story) => story.id === id),
          );
          assert.ok(!(await admin.adventures(adminReq, '')).some((story) => story.id === id));
          const access = (
            await db.query(
              `SELECT ${sourceAccessSql('$1')} AS access,${sourceLiveSql()} AS live FROM game_campaigns c WHERE c.id=$2`,
              [owner, campaign],
            )
          )[0];
          assert.deepEqual(access, { access: false, live: false });
          await assert.rejects(
            pool.query("UPDATE adventures SET status='draft' WHERE id=$1", [id]),
            /deleted_adventure_is_archived/,
          );
        },
      );

      await t.test(
        'trash is metadata-only and restore returns a draft without publication or old invites',
        async () => {
          const trash = await admin.deletedAdventures(req(otherAdmin, 'admin'));
          assert.equal(trash.find((story) => story.id === id).title, 'Released title');
          assert.ok(!JSON.stringify(trash).includes('PRIVATE DRAFT MARKER'));
          assert.deepEqual(Object.keys(trash.find((story) => story.id === id)).sort(), [
            'deletedAt',
            'deletionId',
            'id',
            'title',
          ]);
          const body = { deletionId: operation.operationId };
          await admin.restoreAdventure(id, body, req(otherAdmin, 'admin'));
          await admin.restoreAdventure(id, body, req(otherAdmin, 'admin'));
          const restored = await story(id);
          assert.equal(
            (
              await db.query('SELECT cancel_requested FROM npc_ai_jobs WHERE campaign_id=$1', [
                campaign,
              ])
            )[0].cancel_requested,
            true,
          );
          assert.ok(
            (
              await db.query('SELECT revoked_at FROM npc_ai_sponsors WHERE campaign_id=$1', [
                campaign,
              ])
            )[0].revoked_at,
          );

          assert.equal(restored.deleted_at, null);
          assert.equal(restored.status, 'draft');
          assert.equal(restored.published_snapshot, null);
          assert.equal(restored.private_release_id, null);
          assert.equal(restored.submitted_game_version_id, null);
          assert.equal(
            (
              await db.query('SELECT status FROM adventure_invitations WHERE adventure_id=$1', [id])
            )[0].status,
            'revoked',
          );
          assert.equal(
            (
              await db.query(
                "SELECT * FROM audit WHERE target_id=$1 AND action='adventure.restore'",
                [id],
              )
            ).length,
            1,
          );
          assert.equal((await admin.removeAdventure(id, operation, adminReq)).deleted, false);
          assert.equal((await story(id)).deleted_at, null);
        },
      );

      await t.test(
        'old requests cannot re-delete after a second restore or bind to another story',
        async () => {
          const request = req(owner, 'admin');
          const second = await input(id);
          await admin.removeAdventure(id, second, request);
          await assert.rejects(
            admin.restoreAdventure(id, { deletionId: operation.operationId }, request),
            code('STALE_STATE'),
          );
          await admin.restoreAdventure(id, { deletionId: second.operationId }, request);
          await admin.removeAdventure(id, operation, adminReq);
          assert.equal((await story(id)).deleted_at, null);
          const other = await create();
          await assert.rejects(
            admin.removeAdventure(
              other,
              { ...operation, expectedRevision: (await input(other)).expectedRevision },
              adminReq,
            ),
            code('IDEMPOTENCY_CONFLICT'),
          );
          assert.equal((await story(other)).deleted_at, null);
        },
      );

      await t.test(
        'a deleted author cannot be restored; own private trash is not exposed to other admins',
        async () => {
          const ownId = await create('private', 'draft', adminId);
          const ownInput = await input(ownId);
          await admin.removeAdventure(ownId, ownInput, adminReq);
          assert.ok(
            !(await admin.deletedAdventures(req(otherAdmin, 'admin'))).some(
              (story) => story.id === ownId,
            ),
          );
          await assert.rejects(
            admin.restoreAdventure(
              ownId,
              { deletionId: ownInput.operationId },
              req(otherAdmin, 'admin'),
            ),
            code('NOT_FOUND'),
          );
          await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [adminId]);
          await assert.rejects(
            admin.restoreAdventure(ownId, { deletionId: ownInput.operationId }, adminReq),
            code('UNAUTHORIZED'),
          );
          assert.ok((await story(ownId)).deleted_at);
        },
      );
    } finally {
      await pool.end();
      await Promise.all(ended);
      await cluster.stop();
      await rm(join('.local', process.env.LOCAL_POSTGRES_CLUSTER), {
        recursive: true,
        force: true,
      });
    }
  },
);
