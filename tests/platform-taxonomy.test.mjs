import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:4000/api/v1';
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
for (const url of [base, process.env.DATABASE_URL])
  assert.ok(
    url && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname),
    'Disposable local services required',
  );
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let cookie = '';
async function call(path, body, status = 200, auth = true) {
  const response = await fetch(base + path, {
    method: body ? 'PATCH' : 'GET',
    headers: { origin, 'content-type': 'application/json', ...(auth ? { cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
await test('additive localized genres preserve legacy values and serialize guarded updates', async () => {
  let old;
  try {
    const id = randomUUID().replaceAll('-', '').slice(0, 16);
    const response = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Taxonomy QA',
        handle: 'tax_' + id,
        email: id + '@example.test',
        password: 'Synthetic-' + id,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    await pool.query("UPDATE users SET role='admin' WHERE handle=$1", ['tax_' + id]);
    old = await call('/admin/taxonomy');
    const custom = 'Custom ' + id;
    const initial = await call('/admin/taxonomy', {
      genres: [...old.genres, custom],
      tags: old.tags,
    });
    const def = initial.genreDefinitions.find((g) => g.value === custom);
    assert.match(def.id, /^legacy-/);
    assert.deepEqual(def.labels, { uk: custom, en: custom, ru: custom });
    assert.deepEqual(await call('/genres', undefined, 200, false), initial.genres);
    const translated = {
      ...initial,
      expectedRevision: initial.revision,
      genreDefinitions: initial.genreDefinitions.map((g) =>
        g.id === def.id ? { ...g, labels: { uk: 'Власний', en: 'Custom label', ru: 'Свой' } } : g,
      ),
    };
    const updated = await call('/admin/taxonomy', translated);
    assert.equal(
      (await call('/taxonomy', undefined, 200, false)).genreDefinitions.find((g) => g.id === def.id)
        .labels.en,
      'Custom label',
    );
    await call('/admin/taxonomy', initial, 409);
    await call(
      '/admin/taxonomy',
      { genres: updated.genres, tags: updated.tags, genreDefinitions: updated.genreDefinitions },
      400,
    );
    assert.deepEqual((await call('/admin/taxonomy')).genreDefinitions, updated.genreDefinitions);
    const legacy = await call('/admin/taxonomy', { genres: updated.genres, tags: updated.tags });
    assert.deepEqual(legacy.genreDefinitions, updated.genreDefinitions);
    await call(
      '/admin/taxonomy',
      { ...legacy, genreDefinitions: [...legacy.genreDefinitions, legacy.genreDefinitions[0]] },
      400,
    );
    await call(
      '/admin/taxonomy',
      {
        ...legacy,
        genreDefinitions: legacy.genreDefinitions.map((g, i) =>
          i ? g : { ...g, labels: { ...g.labels, en: '' } },
        ),
      },
      400,
    );
    await call(
      '/admin/taxonomy',
      {
        ...legacy,
        genreDefinitions: legacy.genreDefinitions.map((g, i) =>
          i ? g : { ...g, value: 'changed-value' },
        ),
      },
      400,
    );
    await call('/admin/taxonomy', { genres: legacy.genres, tags: legacy.tags }, 401, false);
    const attempt = { ...legacy, expectedRevision: legacy.revision };
    const statuses = await Promise.all(
      [1, 2].map(
        async () =>
          (
            await fetch(base + '/admin/taxonomy', {
              method: 'PATCH',
              headers: { origin, cookie, 'content-type': 'application/json' },
              body: JSON.stringify(attempt),
            })
          ).status,
      ),
    );
    assert.deepEqual(statuses.sort(), [200, 409]);
    const latest = await call('/admin/taxonomy');
    const removed = await call('/admin/taxonomy', {
      genres: old.genres,
      tags: latest.tags,
      expectedRevision: latest.revision,
    });
    assert.ok(
      removed.genreDefinitions.some((g) => g.id === def.id),
      'historical definition is retained',
    );
  } finally {
    if (old) await call('/admin/taxonomy', { genres: old.genres, tags: old.tags });
    await pool.end();
  }
});
