/** Existing local platform runner supplies a disposable DB and real HTTP API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { adventureSchema } from '../packages/contracts/dist/index.js';
import translationModule from '../apps/api/dist/translation/service.js';
const { CachedTranslations, PostgresTranslationCache } = translationModule;
const base = process.env.TEST_API_URL,
  connectionString = process.env.DATABASE_URL;
for (const value of [base, connectionString]) {
  assert.ok(value);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
}
const pool = new pg.Pool({ connectionString });
const db = {
  query: async (sql, values) => (await pool.query(sql, values)).rows,
  async tx(work) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
test('real HTTP checks permissions before cached translation and never translates drafts or stale published revisions', async () => {
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const registered = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: process.env.TEST_WEB_ORIGIN },
      body: JSON.stringify({
        email: `translation-${suffix}@example.test`,
        handle: `tr_${suffix}`,
        name: 'Synthetic author',
        password: `Synthetic-${randomUUID()}!`,
      }),
    });
    assert.equal(registered.status, 201);
    const user = (await registered.json()).user;
    const cookie = registered.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const id = randomUUID(),
      slug = 'translation-' + suffix;
    const data = adventureSchema.parse({
      title: 'Тихий лес',
      synopsis: 'История о лесе',
      sourceLanguage: 'ru',
      visibility: 'public',
    });
    await pool.query(
      `INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,visibility,data,published_snapshot) VALUES($1,$2,$3,$4,$5,$6,'published','public',$7,$7)`,
      [id, user.id, slug, data.title, data.synopsis, data.genre, JSON.stringify(data)],
    );
    const source = { ...data, id, status: 'published', sourceRevision: 1 };
    const synthetic = new CachedTranslations(new PostgresTranslationCache(db), {
      external: false,
      async translate(request) {
        return {
          translations: request.items.map((item) => ({
            id: item.id,
            text: item.maxLength === 120 ? 'Quiet forest' : 'A forest story',
          })),
        };
      },
    });
    await synthetic.localize(`/adventures/${slug}`, source, 'en', null);
    const publicResponse = await fetch(`${base}/adventures/${slug}?view=published`, {
      headers: { 'Accept-Language': 'en' },
    });
    assert.equal(publicResponse.status, 200);
    assert.match(publicResponse.headers.get('vary'), /Accept-Language/i);
    const localized = await publicResponse.json();
    assert.equal(localized.title, data.title);
    assert.equal(localized.translations.en.title, 'Quiet forest');
    assert.equal(localized.content.world, '');
    const otherLanguage = await (
      await fetch(`${base}/adventures/${slug}?view=published`, {
        headers: { 'Accept-Language': 'uk' },
      })
    ).json();
    assert.equal(otherLanguage.translations.en, undefined);
    const ownerDraft = await (
      await fetch(`${base}/studio/adventures/${id}`, {
        headers: { cookie, 'Accept-Language': 'en' },
      })
    ).json();
    assert.equal(ownerDraft.title, data.title);
    assert.equal(ownerDraft.translations.en, undefined);
    await pool.query(
      `UPDATE adventures SET published_snapshot=jsonb_set(published_snapshot,'{sourceRevision}','2'::jsonb) WHERE id=$1`,
      [id],
    );
    const changed = await (
      await fetch(`${base}/adventures/${slug}?view=published`, {
        headers: { 'Accept-Language': 'en' },
      })
    ).json();
    assert.equal(changed.sourceRevision, 2);
    assert.equal(changed.translations.en, undefined);
    await pool.query("UPDATE adventures SET status='archived' WHERE id=$1", [id]);
    const revoked = await fetch(`${base}/adventures/${slug}?view=published`, {
      headers: { 'Accept-Language': 'en' },
    });
    assert.equal(revoked.status, 404);
    assert.ok(!JSON.stringify(await revoked.json()).includes('Quiet forest'));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM content_translations')).rows[0].count,
      2,
      'read misses never start generation',
    );
  } finally {
    await pool.end();
  }
});
