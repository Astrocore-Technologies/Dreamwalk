const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const {
  CachedTranslations,
  PostgresTranslationCache,
} = require('../../apps/api/dist/translation/service');
test(
  'PostgreSQL translation cache survives restart, isolates readers, prevents duplicate generation and cascades erasure',
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
    process.env.LOCAL_POSTGRES_CLUSTER = 'translations-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const database = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = {
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      async tx(work) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    };
    const reader = randomUUID(),
      other = randomUUID(),
      adventure = randomUUID(),
      campaign = randomUUID();
    const source = {
      id: adventure,
      title: 'Лес',
      synopsis: 'Тихий лес',
      status: 'published',
      sourceLanguage: 'ru',
      sourceRevision: 1,
      translations: {},
    };
    const calls = [];
    const dispatcher = {
      external: false,
      async translate(request) {
        calls.push(request);
        return {
          translations: request.items.map((item) => ({
            id: item.id,
            text: 'Translated ' + item.text,
          })),
        };
      },
    };
    try {
      await pool.query(
        'CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE adventures(id uuid PRIMARY KEY,owner_id uuid); CREATE TABLE game_campaigns(id uuid PRIMARY KEY,owner_id uuid,source_version_id uuid); CREATE TABLE game_members(campaign_id uuid,user_id uuid); CREATE TABLE game_playable_versions(id uuid PRIMARY KEY,adventure_id uuid)',
      );
      await pool.query(
        await readFile('packages/db/migrations/055_content_translations.sql', 'utf8'),
      );
      await pool.query('INSERT INTO users VALUES($1),($2)', [reader, other]);
      await pool.query('INSERT INTO adventures(id) VALUES($1)', [adventure]);
      await pool.query('INSERT INTO game_campaigns(id) VALUES($1)', [campaign]);
      const store = new PostgresTranslationCache(db);
      const first = new CachedTranslations(store, dispatcher),
        second = new CachedTranslations(new PostgresTranslationCache(db), dispatcher);
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? first : second).localize('/adventures/forest', source, 'en', reader),
        ),
      );
      assert.equal(calls.length, 1, 'durable unique claim spans service replicas');
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM content_translations')).rows[0].count,
        2,
      );
      const restarted = new CachedTranslations(new PostgresTranslationCache(db));
      const saved = await restarted.localize('/adventures/forest', source, 'en', reader);
      assert.equal(saved.translations.en.title, 'Translated Лес');
      assert.deepEqual(await restarted.localize('/adventures/forest', source, 'en', other), source);
      assert.deepEqual(await restarted.localize('/adventures/forest', source, 'en', null), source);
      assert.deepEqual(
        await restarted.localize(
          '/adventures/forest',
          { ...source, sourceRevision: 2 },
          'en',
          reader,
        ),
        { ...source, sourceRevision: 2 },
      );
      const feed = { entries: [{ text: 'Приватная реплика' }], turns: [] };
      await first.localize(`/game/campaigns/${campaign}/turns/feed`, feed, 'uk', reader);
      const persisted = JSON.stringify(
        (await pool.query('SELECT * FROM content_translations')).rows,
      );
      assert.ok(!persisted.includes('source_text'));
      assert.ok(!persisted.includes('Тихий лес') || persisted.includes('Translated Тихий лес'));
      const erasedAuthor = randomUUID(),
        sourceVersion = randomUUID();
      await pool.query('INSERT INTO users VALUES($1)', [erasedAuthor]);
      await pool.query('UPDATE adventures SET owner_id=$2 WHERE id=$1', [adventure, erasedAuthor]);
      await pool.query('INSERT INTO game_playable_versions VALUES($1,$2)', [
        sourceVersion,
        adventure,
      ]);
      await pool.query('UPDATE game_campaigns SET owner_id=$2,source_version_id=$3 WHERE id=$1', [
        campaign,
        other,
        sourceVersion,
      ]);
      const { eraseTranslations } = await import('../../scripts/translation-data-requests.mjs');
      await eraseTranslations(pool, erasedAuthor);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM content_translations')).rows[0].count,
        0,
        'erased source author never joined this other-player campaign, but its derived translations must be cleared',
      );
      await first.localize('/adventures/forest', source, 'en', reader);
      await first.localize(`/game/campaigns/${campaign}/turns/feed`, feed, 'uk', reader);
      await pool.query('DELETE FROM users WHERE id=$1', [reader]);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM content_translations')).rows[0].count,
        0,
      );
      await first.localize('/adventures/forest', source, 'en', null);
      await pool.query('DELETE FROM adventures WHERE id=$1', [adventure]);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM content_translations')).rows[0].count,
        0,
      );
    } finally {
      await pool.end();
      await database.stop();
    }
  },
);
