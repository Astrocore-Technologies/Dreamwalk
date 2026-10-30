import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { selectAdventureText } from '@dreamwalk/contracts';
const run = promisify(execFile);
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
  reader = client(),
  anonymous = client();
await test('localized adventure metadata remains original, revision-bound and moderated', async (t) => {
  try {
    const owner = (
      await author.call(
        'POST',
        '/auth/register',
        {
          email: `metadata-${suffix}@example.test`,
          password: `Metadata-${randomUUID()}`,
          name: 'Metadata author',
          handle: `meta_${suffix}`,
        },
        201,
      )
    ).user;
    const recipient = (
      await reader.call(
        'POST',
        '/auth/register',
        {
          email: `metareader-${suffix}@example.test`,
          password: `Reader-${randomUUID()}`,
          name: 'Metadata reader',
          handle: `mr_${suffix}`,
        },
        201,
      )
    ).user;
    await author.call('PATCH', '/account/settings', { language: 'uk' });
    let story = await author.call(
      'POST',
      '/studio/adventures',
      {
        title: `Оригінал-${suffix}`,
        synopsis: 'Початковий авторський опис',
        visibility: 'private',
        content: {
          world: 'Original world',
          locations: [{ id: 'room', name: 'Room' }],
          scenes: [{ id: 'start', name: 'Start', locationId: 'room' }],
          startSceneId: 'start',
        },
      },
      201,
    );
    await t.test(
      'write-once draft defaults source language and has no automatic translation',
      async () => {
        assert.equal(story.sourceLanguage, 'uk');
        assert.equal(story.sourceRevision, 1);
        assert.deepEqual(story.translations, {});
        assert.equal(selectAdventureText(story, 'en').translationStatus, 'disabled');
        assert.equal(selectAdventureText(story, 'en').title, story.title);
        await anonymous.call('GET', `/adventures/${story.slug}`, undefined, 404);
      },
    );
    await t.test(
      'optional correction persists and private ACL protects even translated metadata',
      async () => {
        story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
          title: `English-${suffix}`,
          expectedSourceRevision: 1,
        });
        assert.equal(story.title, `Оригінал-${suffix}`);
        assert.equal(selectAdventureText(story, 'en').title, `English-${suffix}`);
        assert.equal(selectAdventureText(story, 'en').synopsis, story.synopsis);
        await reader.call(
          'PATCH',
          `/studio/adventures/${story.id}/translations/en`,
          { title: 'No access', expectedSourceRevision: 1 },
          404,
        );
        const invite = await author.call(
          'POST',
          `/studio/adventures/${story.id}/invitations`,
          { handle: recipient.handle },
          201,
        );
        await reader.call('POST', `/invitations/${invite.id}/respond`, { decision: 'accept' }, 201);
        const shared = await reader.call('GET', `/adventures/${story.slug}`);
        assert.equal(selectAdventureText(shared, 'en').title, `English-${suffix}`);
        assert.equal(
          selectAdventureText(
            (await reader.call('GET', '/library')).shared.find((a) => a.id === story.id),
            'en',
          ).title,
          `English-${suffix}`,
        );
      },
    );
    await t.test(
      'source changes stale every translation and normal full-form save cannot reconfirm',
      async () => {
        story = await author.call('PATCH', `/studio/adventures/${story.id}`, {
          title: `Новий-${suffix}`,
        });
        assert.equal(story.sourceRevision, 2);
        assert.equal(story.translations.en.sourceRevision, 1);
        let shared = await reader.call('GET', `/adventures/${story.slug}`);
        assert.equal(selectAdventureText(shared, 'en').title, `Новий-${suffix}`);
        assert.equal(selectAdventureText(shared, 'en').translationStatus, 'stale');
        assert.ok(!JSON.stringify(shared).includes(`English-${suffix}`));
        story = await author.call('PATCH', `/studio/adventures/${story.id}`, {
          sourceRevision: 999,
          translations: { en: { title: 'FORGED_AUTO_RECONFIRM', sourceRevision: 2 } },
        });
        assert.equal(story.sourceRevision, 2);
        assert.equal(story.translations.en.sourceRevision, 1);
        assert.equal(story.translations.en.title, `English-${suffix}`);
        const error = await author.call(
          'PATCH',
          `/studio/adventures/${story.id}/translations/en`,
          { title: 'STALE_SAVE', expectedSourceRevision: 1 },
          409,
        );
        assert.equal(error.code, 'SOURCE_REVISION_CONFLICT');
        story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
          title: `Updated-English-${suffix}`,
          synopsis: '',
          expectedSourceRevision: 2,
        });
        assert.equal(selectAdventureText(story, 'en').synopsis, story.synopsis);
        story = await author.call('PATCH', `/studio/adventures/${story.id}`, {
          sourceLanguage: 'ru',
        });
        assert.equal(story.sourceRevision, 3);
        assert.equal(selectAdventureText(story, 'en').translationStatus, 'stale');
        story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
          title: `Approved-English-${suffix}`,
          synopsis: 'Approved translated summary',
          expectedSourceRevision: 3,
        });
      },
    );
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.id]);
    await author.call('PATCH', `/studio/adventures/${story.id}`, { visibility: 'public' });
    await author.call('POST', `/studio/adventures/${story.id}/submit`, {}, 201);
    await author.call(
      'POST',
      `/admin/adventures/${story.id}/moderate`,
      { decision: 'approve', reason: 'Approve localized metadata fixture' },
      201,
    );
    const versionBefore = await author.call('GET', `/studio/adventures/${story.id}/versions`);
    await t.test(
      'unapproved translated edits never leak into public detail or search',
      async () => {
        assert.equal(
          selectAdventureText(await anonymous.call('GET', `/adventures/${story.slug}`), 'en').title,
          `Approved-English-${suffix}`,
        );
        assert.equal(
          (await anonymous.call('GET', `/adventures?q=Approved-English-${suffix}`)).length,
          1,
        );
        story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
          title: `PENDING-English-${suffix}`,
          expectedSourceRevision: 3,
        });
        assert.equal(story.status, 'draft');
        assert.equal(
          selectAdventureText(await anonymous.call('GET', `/adventures/${story.slug}`), 'en').title,
          `Approved-English-${suffix}`,
        );
        assert.equal(
          (await anonymous.call('GET', `/adventures?q=PENDING-English-${suffix}`)).length,
          0,
        );
        await author.call('POST', `/studio/adventures/${story.id}/submit`, {}, 201);
        assert.equal(
          selectAdventureText(await anonymous.call('GET', `/adventures/${story.slug}`), 'en').title,
          `Approved-English-${suffix}`,
        );
        assert.deepEqual(
          await author.call('GET', `/studio/adventures/${story.id}/versions`),
          versionBefore,
        );
        await author.call(
          'POST',
          `/admin/adventures/${story.id}/moderate`,
          { decision: 'approve', reason: 'Approve revised translation' },
          201,
        );
        assert.equal(
          selectAdventureText(await anonymous.call('GET', `/adventures/${story.slug}`), 'en').title,
          `PENDING-English-${suffix}`,
        );
        const after = await author.call('GET', `/studio/adventures/${story.id}/versions`);
        assert.deepEqual(
          after.find((v) => v.id === versionBefore[0].id),
          versionBefore[0],
        );
      },
    );
    await t.test(
      'new approved source with stale translations falls back and stale search is suppressed',
      async () => {
        story = await author.call('PATCH', `/studio/adventures/${story.id}`, {
          synopsis: `Новий опис-${suffix}`,
        });
        assert.equal(story.sourceRevision, 4);
        await author.call('POST', `/studio/adventures/${story.id}/submit`, {}, 201);
        await author.call(
          'POST',
          `/admin/adventures/${story.id}/moderate`,
          { decision: 'approve', reason: 'Approve original source changes' },
          201,
        );
        const detail = await anonymous.call('GET', `/adventures/${story.slug}`);
        assert.equal(selectAdventureText(detail, 'en').title, story.title);
        assert.equal(selectAdventureText(detail, 'en').synopsis, `Новий опис-${suffix}`);
        assert.equal(selectAdventureText(detail, 'en').translationStatus, 'stale');
        assert.ok(!JSON.stringify(detail).includes(`PENDING-English-${suffix}`));
        assert.equal(
          (await anonymous.call('GET', `/adventures?q=PENDING-English-${suffix}`)).length,
          0,
        );
      },
    );
    await t.test(
      'curated seed translations upgrade append-only versions exactly once',
      async () => {
        const seed = (await db.query("SELECT * FROM adventures WHERE slug='old-observatory'"))
          .rows[0];
        assert.ok(seed);
        const before = (
          await db.query(
            'SELECT id,version,snapshot FROM adventure_versions WHERE adventure_id=$1 ORDER BY version',
            [seed.id],
          )
        ).rows;
        await db.query(
          "UPDATE adventures SET data=data-'translations',published_snapshot=published_snapshot-'translations' WHERE id=$1",
          [seed.id],
        );
        await run(process.execPath, ['--import', 'tsx', 'apps/api/src/seed.ts'], {
          cwd: process.cwd(),
          env: process.env,
        });
        const upgraded = (
          await db.query(
            'SELECT id,version,snapshot FROM adventure_versions WHERE adventure_id=$1 ORDER BY version',
            [seed.id],
          )
        ).rows;
        assert.equal(upgraded.length, before.length + 1);
        assert.deepEqual(upgraded.slice(0, before.length), before);
        await run(process.execPath, ['--import', 'tsx', 'apps/api/src/seed.ts'], {
          cwd: process.cwd(),
          env: process.env,
        });
        assert.deepEqual(
          (
            await db.query(
              'SELECT id,version,snapshot FROM adventure_versions WHERE adventure_id=$1 ORDER BY version',
              [seed.id],
            )
          ).rows,
          upgraded,
        );
        const seedDetail = await anonymous.call('GET', '/adventures/old-observatory');
        assert.equal(selectAdventureText(seedDetail, 'uk').title, 'Таємниця старої обсерваторії');
        assert.equal(selectAdventureText(seedDetail, 'en').title, 'Mystery of the Old Observatory');
      },
    );
  } finally {
    await db.end();
  }
});
