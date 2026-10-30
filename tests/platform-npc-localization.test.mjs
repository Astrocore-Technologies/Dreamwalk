import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { selectNpcText } from '@dreamwalk/contracts';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:4000/api/v1';
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
for (const url of [base, process.env.DATABASE_URL])
  assert.ok(
    url && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
    'Only disposable local services are allowed',
  );
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
function client() {
  let cookie = '';
  return {
    async call(method, path, body, status = 200) {
      const r = await fetch(base + path, {
        method,
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.headers.getSetCookie().length)
        cookie = r.headers
          .getSetCookie()
          .map((v) => v.split(';')[0])
          .join('; ');
      const result = await r.json();
      assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
      return result;
    },
  };
}
const author = client(),
  other = client(),
  anon = client();
await test('NPC original metadata translations stay revision-bound, owned and snapshot-pinned', async (t) => {
  try {
    const owner = (
      await author.call(
        'POST',
        '/auth/register',
        {
          email: `npc-${suffix}@example.test`,
          password: `Npc-${randomUUID()}`,
          name: 'NPC author',
          handle: `npc_${suffix}`,
        },
        201,
      )
    ).user;
    await other.call(
      'POST',
      '/auth/register',
      {
        email: `npco-${suffix}@example.test`,
        password: `Npc-${randomUUID()}`,
        name: 'Other',
        handle: `npco_${suffix}`,
      },
      201,
    );
    await author.call('PATCH', '/account/settings', { language: 'uk' });
    let npc = await author.call(
      'POST',
      '/npcs',
      {
        name: 'Лада',
        description: 'Оригінальний опис',
        greeting: 'Вітаю',
        secrets: 'SECRET',
        biography: 'PRIVATE',
      },
      201,
    );
    await t.test(
      'original language defaults once and optional public-only correction persists',
      async () => {
        assert.equal(npc.sourceLanguage, 'uk');
        assert.deepEqual(npc.translations, {});
        npc = await author.call('PATCH', `/npcs/${npc.id}/translations/en`, {
          name: 'Lada',
          description: 'English description',
          greeting: 'Hello',
          expectedSourceRevision: 1,
        });
        assert.equal(selectNpcText(npc, 'en').name, 'Lada');
        await other.call(
          'PATCH',
          `/npcs/${npc.id}/translations/en`,
          { name: 'Intruder', expectedSourceRevision: 1 },
          404,
        );
        await author.call(
          'PATCH',
          `/npcs/${npc.id}/translations/en`,
          { secrets: 'FORBIDDEN', expectedSourceRevision: 1 },
          400,
        );
        assert.equal((await author.call('GET', `/npcs/${npc.id}`)).translations.en.name, 'Lada');
      },
    );
    let story = await author.call(
      'POST',
      '/studio/adventures',
      {
        title: `NPC story ${suffix}`,
        synopsis: 'A valid original synopsis',
        visibility: 'public',
        content: {
          world: 'Original world',
          npcIds: [npc.id],
          locations: [{ id: 'room', name: 'Room' }],
          scenes: [{ id: 'start', name: 'Start', locationId: 'room' }],
          startSceneId: 'start',
        },
      },
      201,
    );
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.id]);
    await author.call('POST', `/studio/adventures/${story.id}/submit`, undefined, 201);
    await author.call(
      'POST',
      `/admin/adventures/${story.id}/moderate`,
      { decision: 'approve', reason: 'Synthetic test' },
      201,
    );
    await t.test(
      'approved NPC variants contain no private data and do not change with live NPC edits',
      async () => {
        const published = await anon.call('GET', `/adventures/${story.slug}`);
        assert.equal(selectNpcText(published.npcs[0], 'en').description, 'English description');
        assert.equal(JSON.stringify(published).includes('SECRET'), false);
        assert.equal(JSON.stringify(published).includes('PRIVATE'), false);
        npc = await author.call('PATCH', `/npcs/${npc.id}`, {
          description: 'Змінений опис',
          sourceRevision: 999,
          translations: { en: { name: 'FORGED', sourceRevision: 999 } },
        });
        assert.equal(npc.sourceRevision, 2);
        assert.equal(selectNpcText(npc, 'en').description, 'Змінений опис');
        assert.equal(selectNpcText(npc, 'en').isFallback, true);
        assert.equal(
          selectNpcText((await anon.call('GET', `/adventures/${story.slug}`)).npcs[0], 'en')
            .description,
          'English description',
        );
        await author.call(
          'PATCH',
          `/npcs/${npc.id}/translations/en`,
          { name: 'Old revision', expectedSourceRevision: 1 },
          409,
        );
      },
    );
    await t.test(
      'fresh approval strips stale text while historical versions retain approved variants',
      async () => {
        await author.call('PATCH', `/studio/adventures/${story.id}`, {
          synopsis: 'Changed synopsis for renewed approval',
        });
        await author.call('POST', `/studio/adventures/${story.id}/submit`, undefined, 201);
        await author.call(
          'POST',
          `/admin/adventures/${story.id}/moderate`,
          { decision: 'approve', reason: 'Synthetic second approval' },
          201,
        );
        const published = await anon.call('GET', `/adventures/${story.slug}`);
        assert.equal(published.npcs[0].translations.en.description, undefined);
        assert.equal(selectNpcText(published.npcs[0], 'en').name, 'Лада');
        const old = (
          await db.query(
            'SELECT snapshot FROM adventure_versions WHERE adventure_id=$1 AND version=1',
            [story.id],
          )
        ).rows[0].snapshot;
        assert.equal(old.publicNpcs[0].translations.en.description, 'English description');
      },
    );
    await t.test('curated seed NPC public fields render English and Ukrainian', async () => {
      const seed = await anon.call('GET', '/adventures/old-observatory');
      assert.equal(selectNpcText(seed.npcs[0], 'en').name, 'Elias');
      assert.equal(selectNpcText(seed.npcs[0], 'uk').name, 'Еліас');
    });
  } finally {
    await db.end();
  }
});
