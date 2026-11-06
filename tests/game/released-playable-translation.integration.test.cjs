const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = require('@dreamwalk/game-core');
const { digest } = require('../../apps/api/dist/ai/context');
const {
  PlayableContentSource,
} = require('../../apps/api/dist/translation/playable-content-source');

test(
  'PostgreSQL released playable reads fence membership, source lifetime and concurrent access without source writes',
  { timeout: 90000 },
  async () => {
    const net = require('node:net');
    const { once } = require('node:events');
    const { Pool } = require('pg');
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = 'playable-trans-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const database = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ends = [];
    pool.on('connect', (client) =>
      ends.push(new Promise((resolve) => client.once('end', resolve))),
    );
    const owner = randomUUID(),
      viewer = randomUUID(),
      outsider = randomUUID(),
      adventure = randomUUID(),
      version = randomUUID(),
      campaign = randomUUID();
    const compiled = core.compilePlayableDraft(core.createCompleteObservatoryDraft()).playable;
    const state = core.createStateFromPlayable(compiled, ['alice', 'bob']);
    const map = state.entities.alice.mapId;
    Object.assign(state.entities.alice, { x: 5, y: 5 });
    Object.assign(state.entities.keeper, { x: 6, y: 5 });
    state.maps[map].blocked = [];
    const pkg = { schemaVersion: 1, compiled };
    const adapter = new PlayableContentSource();
    const source = { kind: 'playable', id: version };
    const access = { kind: 'viewer', userId: viewer, campaignId: campaign };
    const tx = async (work) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const value = await work(c);
        await c.query('COMMIT');
        return value;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    };
    try {
      // Exact adapter-facing columns and constraints. This is SQL/lock evidence,
      // not a replacement for the full migration069 integration gate.
      await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE adventures(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),deleted_at timestamptz,status text NOT NULL,visibility text NOT NULL,published_snapshot jsonb,private_release_id uuid,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE game_playable_versions(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),package jsonb NOT NULL,checksum text NOT NULL,audience text NOT NULL);
      CREATE TABLE game_playable_approvals(playable_version_id uuid PRIMARY KEY REFERENCES game_playable_versions(id));
      CREATE TABLE adventure_private_releases(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),playable_version_id uuid NOT NULL REFERENCES game_playable_versions(id),snapshot jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE adventure_invitations(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),recipient_id uuid NOT NULL REFERENCES users(id),status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(adventure_id,recipient_id));
      CREATE TABLE game_campaigns(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),source_version_id uuid NOT NULL REFERENCES game_playable_versions(id),state jsonb NOT NULL,status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE game_snapshots(campaign_id uuid PRIMARY KEY REFERENCES game_campaigns(id),state jsonb NOT NULL,checksum text NOT NULL);
      CREATE TABLE game_members(campaign_id uuid NOT NULL REFERENCES game_campaigns(id),user_id uuid NOT NULL REFERENCES users(id),actor_id text NOT NULL,status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid(),PRIMARY KEY(campaign_id,user_id));
    `);
      await pool.query('INSERT INTO users(id) VALUES($1),($2),($3)', [owner, viewer, outsider]);
      await pool.query(
        "INSERT INTO adventures(id,owner_id,status,visibility,published_snapshot) VALUES($1,$2,'published','public','{}')",
        [adventure, owner],
      );
      await pool.query("INSERT INTO game_playable_versions VALUES($1,$2,$3,$4,'review')", [
        version,
        adventure,
        JSON.parse(JSON.stringify(pkg)),
        digest(pkg),
      ]);
      await pool.query(
        "INSERT INTO game_campaigns(id,owner_id,source_version_id,state,status) VALUES($1,$2,$3,$4,'active')",
        [campaign, viewer, version, state],
      );
      await pool.query('INSERT INTO game_snapshots VALUES($1,$2,$3)', [
        campaign,
        state,
        digest(state),
      ]);
      await pool.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'alice','accepted')",
        [campaign, viewer],
      );
      assert.deepEqual(
        await tx((c) => adapter.load(c, source, { kind: 'system' })),
        [],
        'public draft/test version without approval is excluded',
      );
      await pool.query('INSERT INTO game_playable_approvals VALUES($1)', [version]);
      const initial = (await tx((c) => adapter.load(c, source, access)))[0];
      assert.ok(initial.fields.some((f) => f.path === 'entity/keeper/label'));
      assert.deepEqual(
        await tx((c) => adapter.load(c, source, { ...access, userId: outsider })),
        [],
      );
      assert.deepEqual(
        await tx((c) => adapter.load(c, source, { ...access, campaignId: randomUUID() })),
        [],
      );
      const reader = await pool.connect(),
        writer = await pool.connect();
      try {
        await reader.query('BEGIN');
        assert.equal((await adapter.load(reader, source, access)).length, 1);
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout='50ms'");
        await assert.rejects(
          writer.query(
            "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
            [campaign, viewer],
          ),
          { code: '55P03' },
        );
        await writer.query('ROLLBACK');
        await reader.query('ROLLBACK');
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE game_members SET status='revoked',translation_epoch=gen_random_uuid() WHERE campaign_id=$1 AND user_id=$2",
          [campaign, viewer],
        );
        await assert.rejects(
          tx((c) => adapter.load(c, source, access)),
          { code: '55P03' },
        );
        await writer.query('COMMIT');
        assert.deepEqual(await tx((c) => adapter.load(c, source, access)), []);
        await pool.query(
          "UPDATE game_members SET status='accepted',translation_epoch=gen_random_uuid() WHERE campaign_id=$1 AND user_id=$2",
          [campaign, viewer],
        );
        const rejoined = (await tx((c) => adapter.load(c, source, access)))[0];
        assert.notEqual(initial.authority, rejoined.authority);
        assert.equal(initial.fields[0].cachePartition, rejoined.fields[0].cachePartition);
      } finally {
        await reader.query('ROLLBACK');
        await writer.query('ROLLBACK');
        reader.release();
        writer.release();
      }
      await pool.query(
        "UPDATE adventures SET visibility='private',published_snapshot=NULL,translation_epoch=gen_random_uuid() WHERE id=$1",
        [adventure],
      );
      await pool.query("UPDATE game_playable_versions SET audience='private' WHERE id=$1", [
        version,
      ]);
      assert.deepEqual(
        await tx((c) => adapter.load(c, source, { kind: 'system' })),
        [],
        'a frozen private test is not a private release',
      );
      const release = randomUUID();
      await pool.query(
        'INSERT INTO adventure_private_releases(id,adventure_id,playable_version_id) VALUES($1,$2,$3)',
        [release, adventure, version],
      );
      await pool.query('UPDATE adventures SET private_release_id=$2 WHERE id=$1', [
        adventure,
        release,
      ]);
      assert.equal((await tx((c) => adapter.load(c, source, { kind: 'system' }))).length, 1);
      assert.deepEqual(
        await tx((c) => adapter.load(c, source, access)),
        [],
        'campaign membership alone cannot grant access to a private source',
      );
      await pool.query(
        "INSERT INTO adventure_invitations(id,adventure_id,recipient_id,status) VALUES($1,$2,$3,'accepted')",
        [randomUUID(), adventure, viewer],
      );
      assert.equal((await tx((c) => adapter.load(c, source, access))).length, 1);
      await pool.query(
        "UPDATE adventure_invitations SET status='revoked',translation_epoch=gen_random_uuid() WHERE adventure_id=$1",
        [adventure],
      );
      assert.deepEqual(await tx((c) => adapter.load(c, source, access)), []);
      await pool.query(
        'UPDATE users SET deleted_at=now(),translation_epoch=gen_random_uuid() WHERE id=$1',
        [owner],
      );
      assert.deepEqual(await tx((c) => adapter.load(c, source, { kind: 'system' })), []);
      assert.equal(
        (await pool.query('SELECT checksum FROM game_snapshots WHERE campaign_id=$1', [campaign]))
          .rows[0].checksum,
        digest(state),
      );
      assert.deepEqual(
        (await pool.query('SELECT package FROM game_playable_versions WHERE id=$1', [version]))
          .rows[0].package,
        JSON.parse(JSON.stringify(pkg)),
      );
    } finally {
      await pool.end();
      await Promise.all(ends);
      await database.stop();
    }
  },
);
