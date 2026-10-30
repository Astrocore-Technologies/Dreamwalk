import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { selectAdventureTags } from '@dreamwalk/contracts';
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
  anonymous = client();
await test('localized controlled and custom tags preserve originals and moderation', async () => {
  try {
    const owner = (
      await author.call(
        'POST',
        '/auth/register',
        {
          email: `tags-${suffix}@example.test`,
          password: `Tags-${randomUUID()}`,
          name: 'Tags author',
          handle: `tags_${suffix}`,
        },
        201,
      )
    ).user;
    const registry = await anonymous.call('GET', '/tags');
    assert.ok(registry.some((tag) => tag.id === 'magic' && tag.labels.uk === 'Магія'));
    let story = await author.call(
      'POST',
      '/studio/adventures',
      {
        title: 'Tags original',
        synopsis: 'Original summary',
        tags: ['Магия', 'Мой тег'],
        visibility: 'public',
        content: {
          world: 'Original world',
          locations: [{ id: 'room', name: 'Room' }],
          scenes: [{ id: 'start', name: 'Start', locationId: 'room' }],
          startSceneId: 'start',
        },
      },
      201,
    );
    assert.deepEqual(selectAdventureTags(story, 'en', registry), ['Magic', 'Мой тег']);
    await author.call(
      'PATCH',
      `/studio/adventures/${story.id}/translations/en`,
      { expectedSourceRevision: story.sourceRevision, tags: { missing: 'Other' } },
      400,
    );
    await author.call(
      'PATCH',
      `/studio/adventures/${story.id}/translations/en`,
      { expectedSourceRevision: story.sourceRevision, tags: { Магия: 'Wrong override' } },
      400,
    );
    story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
      expectedSourceRevision: story.sourceRevision,
      tags: { 'Мой тег': 'My tag' },
    });
    assert.deepEqual(selectAdventureTags(story, 'en', registry), ['Magic', 'My tag']);
    await author.call('POST', `/studio/adventures/${story.id}/submit`, {}, 201);
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.id]);
    await author.call(
      'POST',
      `/admin/adventures/${story.id}/moderate`,
      { decision: 'approve', reason: 'Approve controlled custom tags' },
      201,
    );
    const approved = await anonymous.call('GET', `/adventures/${story.slug}`);
    assert.deepEqual(selectAdventureTags(approved, 'en', registry), ['Magic', 'My tag']);
    story = await author.call('PATCH', `/studio/adventures/${story.id}`, {
      tags: ['magic', 'Другой тег'],
    });
    assert.equal(story.sourceRevision, 2);
    assert.deepEqual(selectAdventureTags(story, 'en', registry), ['Magic', 'Другой тег']);
    assert.deepEqual(
      selectAdventureTags(await anonymous.call('GET', `/adventures/${story.slug}`), 'en', registry),
      ['Magic', 'My tag'],
    );
    await author.call(
      'PATCH',
      `/studio/adventures/${story.id}/translations/en`,
      { expectedSourceRevision: 1, tags: { 'Другой тег': 'Other' } },
      409,
    );
    story = await author.call('PATCH', `/studio/adventures/${story.id}/translations/en`, {
      expectedSourceRevision: 2,
      tags: { 'Другой тег': 'Other' },
    });
    assert.deepEqual(selectAdventureTags(story, 'en', registry), ['Magic', 'Other']);
    const taxonomy = await author.call('GET', '/admin/taxonomy');
    await author.call(
      'PATCH',
      '/admin/taxonomy',
      {
        ...taxonomy,
        tags: [
          ...taxonomy.tags,
          { id: 'collision', labels: { uk: 'x', en: 'x', ru: 'x' }, aliases: ['Магия'] },
        ],
      },
      400,
    );
    await author.call(
      'PATCH',
      '/admin/taxonomy',
      { ...taxonomy, tags: taxonomy.tags.filter((tag) => tag.id !== 'magic') },
      400,
    );
  } finally {
    await db.end();
  }
});
