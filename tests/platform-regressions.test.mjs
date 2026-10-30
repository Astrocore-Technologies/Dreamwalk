import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:4000/api/v1';
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
for (const url of [base, process.env.DATABASE_URL])
  assert.ok(
    url && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname),
    'Local services required',
  );
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
let cookie = '';
async function request(method, path, body, expected = 200, authenticated = true) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      origin,
      ...(authenticated && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (authenticated && r.headers.getSetCookie().length)
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  const data = await r.json();
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function upload() {
  const form = new FormData();
  form.append(
    'file',
    new Blob(
      [
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPwi1rwH4QZYAwATVwJHR723W0AAAAASUVORK5CYII=',
          'base64',
        ),
      ],
      { type: 'image/png' },
    ),
    'pixel.png',
  );
  const r = await fetch(base + '/assets', {
    method: 'POST',
    headers: { origin, cookie },
    body: form,
  });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
async function assetStatus(id) {
  return (await fetch(base + `/assets/${id}/file`)).status;
}
await test('public snapshots, media visibility and taxonomy regressions', async (t) => {
  try {
    const user = (
      await request(
        'POST',
        '/auth/register',
        {
          email: `regression-${suffix}@example.test`,
          password: `Regression-${randomUUID()}`,
          name: 'Regression Author',
          handle: `reg_${suffix}`,
        },
        201,
      )
    ).user;
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [user.id]);
    const cover = await upload(),
      portrait = await upload();
    const npc = await request(
      'POST',
      '/npcs',
      {
        name: 'Approved NPC',
        portraitAssetId: portrait.id,
        secrets: 'SENSITIVE_NPC_SECRET',
        biography: 'PRIVATE_BIO',
        greeting: 'Approved greeting',
      },
      201,
    );
    let adventure = await request(
      'POST',
      '/studio/adventures',
      {
        title: `Approved-${suffix}`,
        visibility: 'public',
        synopsis: 'Approved synopsis',
        genre: 'Тайна',
        coverAssetId: cover.id,
        content: {
          world: 'Approved world',
          locations: [{ id: 'place', name: 'Place' }],
          npcIds: [npc.id],
          scenes: [{ id: 'start', name: 'Start', locationId: 'place' }],
          startSceneId: 'start',
        },
      },
      201,
    );
    await request('POST', `/studio/adventures/${adventure.id}/submit`, {}, 201);
    adventure = await request(
      'POST',
      `/admin/adventures/${adventure.id}/moderate`,
      { decision: 'approve', reason: 'Regression approval' },
      201,
    );
    await t.test(
      'explicit withdrawal directly from published preserves private status',
      async () => {
        const hidden = await request('PATCH', `/studio/adventures/${adventure.id}`, {
          visibility: 'private',
        });
        assert.equal(hidden.visibility, 'private');
        await request('GET', `/adventures/${adventure.slug}`, undefined, 404, false);
        assert.equal(await assetStatus(cover.id), 404);
        await request('PATCH', `/studio/adventures/${adventure.id}`, { visibility: 'public' });
        await request('POST', `/studio/adventures/${adventure.id}/submit`, {}, 201);
        await request(
          'POST',
          `/admin/adventures/${adventure.id}/moderate`,
          { decision: 'approve', reason: 'Restore after withdrawal test' },
          201,
        );
      },
    );
    await t.test('approved cover and snapshot NPC portrait are public', async () => {
      assert.equal(await assetStatus(cover.id), 200);
      assert.equal(await assetStatus(portrait.id), 200);
    });
    await t.test('private NPC edits cannot change public approved preview', async () => {
      await request('PATCH', `/npcs/${npc.id}`, {
        name: 'Unpublished NPC',
        greeting: 'PRIVATE_GREETING',
      });
      const detail = await request('GET', `/adventures/${adventure.slug}`, undefined, 200, false);
      assert.equal(detail.npcs[0].name, 'Approved NPC');
      assert.equal(detail.npcs[0].greeting, 'Approved greeting');
      assert.ok(!JSON.stringify(detail).includes('SENSITIVE_NPC_SECRET'));
      assert.ok(!JSON.stringify(detail).includes('PRIVATE_GREETING'));
      assert.ok(!JSON.stringify(detail).includes('PRIVATE_BIO'));
    });
    await t.test('public search and genre filtering never inspect draft metadata', async () => {
      await request('PATCH', `/studio/adventures/${adventure.id}`, {
        title: `SECRET-DRAFT-${suffix}`,
        synopsis: `SECRET-SYNOPSIS-${suffix}`,
        genre: `SECRET-GENRE-${suffix}`,
      });
      assert.equal(
        (await request('GET', `/adventures?q=SECRET-DRAFT-${suffix}`, undefined, 200, false))
          .length,
        0,
      );
      assert.equal(
        (await request('GET', `/adventures?q=SECRET-SYNOPSIS-${suffix}`, undefined, 200, false))
          .length,
        0,
      );
      assert.equal(
        (await request('GET', `/adventures?genre=SECRET-GENRE-${suffix}`, undefined, 200, false))
          .length,
        0,
      );
      const found = await request('GET', `/adventures?q=Approved-${suffix}`, undefined, 200, false);
      assert.equal(found.length, 1);
      assert.equal(found[0].title, `Approved-${suffix}`);
    });
    await t.test('published to private revokes both cover and NPC portrait access', async () => {
      await request('PATCH', `/studio/adventures/${adventure.id}`, { visibility: 'private' });
      await request('GET', `/adventures/${adventure.slug}`, undefined, 404, false);
      assert.equal(await assetStatus(cover.id), 404);
      assert.equal(await assetStatus(portrait.id), 404);
    });
    await t.test(
      'link-only visibility is rejected and re-publication requires new approval',
      async () => {
        await request(
          'PATCH',
          `/studio/adventures/${adventure.id}`,
          { visibility: 'unlisted' },
          400,
        );
        await request('PATCH', `/studio/adventures/${adventure.id}`, { status: 'unlisted' }, 400);
        await request('PATCH', `/studio/adventures/${adventure.id}`, { visibility: 'public' });
        await request('GET', `/adventures/${adventure.slug}`, undefined, 404, false);
        assert.equal(await assetStatus(cover.id), 404);
        await request('POST', `/studio/adventures/${adventure.id}/submit`, {}, 201);
        await request(
          'POST',
          `/admin/adventures/${adventure.id}/moderate`,
          { decision: 'approve', reason: 'Approve explicit public visibility' },
          201,
        );
        const detail = await request('GET', `/adventures/${adventure.slug}`, undefined, 200, false);
        assert.equal(detail.title, `SECRET-DRAFT-${suffix}`);
        assert.equal(await assetStatus(cover.id), 200);
      },
    );
    await t.test('validated session activity refreshes no more than once per minute', async () => {
      await pool.query(
        "UPDATE sessions SET last_seen_at=now()-interval '5 minutes' WHERE user_id=$1",
        [user.id],
      );
      const since = Date.now();
      await request('GET', '/auth/me');
      const first = (await request('GET', '/account/sessions')).find((s) => s.current);
      assert.ok(new Date(first.lastSeenAt).getTime() >= since - 1000);
      await request('GET', '/auth/me');
      const second = (await request('GET', '/account/sessions')).find((s) => s.current);
      assert.equal(second.lastSeenAt, first.lastSeenAt);
    });
    await t.test(
      'malformed UUID is a validation response, never internal server error',
      async () => {
        await request('GET', '/studio/adventures/not-a-uuid', undefined, 400);
        await request('GET', '/assets/not-a-uuid/file', undefined, 400);
      },
    );
    await t.test(
      'taxonomy persists, validates unique names and rejects anonymous writes',
      async () => {
        const old = await request('GET', '/admin/taxonomy');
        try {
          const changed = {
            genres: [...old.genres, `Test ${suffix}`],
            tags: [...old.tags, `Tag ${suffix}`],
          };
          await request('PATCH', '/admin/taxonomy', changed);
          assert.deepEqual(await request('GET', '/genres', undefined, 200, false), changed.genres);
          assert.deepEqual(await request('GET', '/tags', undefined, 200, false), changed.tags);
          await request(
            'PATCH',
            '/admin/taxonomy',
            { genres: ['Duplicate', 'Duplicate'], tags: [] },
            400,
          );
          await request('PATCH', '/admin/taxonomy', old, 401, false);
        } finally {
          await request('PATCH', '/admin/taxonomy', old);
        }
      },
    );
    await t.test(
      'private invitations enforce acceptance, read-only access and immediate revocation',
      async () => {
        const ownerCookie = cookie;
        const recipient = (
          await request(
            'POST',
            '/auth/register',
            {
              email: `invite-${suffix}@example.test`,
              password: `Invite-${randomUUID()}`,
              name: 'Invited reader',
              handle: `invite_${suffix}`,
            },
            201,
          )
        ).user;
        const recipientCookie = cookie;
        const stranger = (
          await request(
            'POST',
            '/auth/register',
            {
              email: `stranger-${suffix}@example.test`,
              password: `Stranger-${randomUUID()}`,
              name: 'Uninvited admin',
              handle: `stranger_${suffix}`,
            },
            201,
          )
        ).user;
        const strangerCookie = cookie;
        await pool.query("UPDATE users SET role='admin' WHERE id=$1", [stranger.id]);
        cookie = ownerCookie;
        const privateCover = await upload(),
          privatePortrait = await upload();
        const privateNpc = await request(
          'POST',
          '/npcs',
          {
            name: 'Private NPC',
            portraitAssetId: privatePortrait.id,
            secrets: 'INVITED_MUST_NOT_SEE_SECRET',
            biography: 'HIDDEN_PRIVATE_BIO',
          },
          201,
        );
        const story = await request(
          'POST',
          '/studio/adventures',
          {
            title: `Private-${suffix}`,
            visibility: 'private',
            synopsis: 'Private invitation-only world',
            coverAssetId: privateCover.id,
            content: {
              world: 'Private world',
              locations: [{ id: 'room', name: 'Room' }],
              npcIds: [privateNpc.id],
              scenes: [{ id: 'arrival', name: 'Arrival', locationId: 'room' }],
              startSceneId: 'arrival',
            },
          },
          201,
        );
        await request('POST', `/studio/adventures/${story.id}/submit`, {}, 400);
        await request('GET', `/adventures/${story.slug}`, undefined, 404, false);
        assert.equal(await assetStatus(privateCover.id), 404);
        assert.equal(
          (await request('GET', `/adventures?q=Private-${suffix}`, undefined, 200, false)).length,
          0,
        );
        const invitation = await request(
          'POST',
          `/studio/adventures/${story.id}/invitations`,
          { handle: recipient.handle },
          201,
        );
        await request(
          'POST',
          `/studio/adventures/${story.id}/invitations`,
          { handle: recipient.handle },
          201,
        );
        cookie = recipientCookie;
        assert.equal(
          (await request('GET', '/invitations')).filter((i) => i.id === invitation.id).length,
          1,
        );
        assert.equal(
          (await request('GET', '/notifications')).filter(
            (n) => n.type === 'invitation' && n.payload.adventureId === story.id,
          ).length,
          1,
        );
        await request('GET', `/adventures/${story.slug}`, undefined, 404);
        cookie = strangerCookie;
        await request('GET', `/adventures/${story.slug}`, undefined, 404);
        assert.equal(
          (await request('GET', '/admin/adventures')).some((a) => a.id === story.id),
          false,
        );
        assert.equal(
          (await request('GET', '/admin/npcs')).some((n) => n.id === privateNpc.id),
          false,
        );
        await request(
          'POST',
          `/admin/adventures/${story.id}/moderate`,
          { decision: 'approve', reason: 'Should be forbidden' },
          404,
        );
        await request('POST', `/invitations/${invitation.id}/respond`, { decision: 'accept' }, 404);
        const strangerAsset = await fetch(base + `/assets/${privateCover.id}/file`, {
          headers: { cookie },
        });
        assert.equal(strangerAsset.status, 404);
        cookie = recipientCookie;
        await request('POST', `/invitations/${invitation.id}/respond`, { decision: 'accept' }, 201);
        const detail = await request('GET', `/adventures/${story.slug}`);
        assert.equal(detail.access, 'invited');
        assert.equal(detail.readOnly, true);
        assert.ok(!JSON.stringify(detail).includes('INVITED_MUST_NOT_SEE_SECRET'));
        assert.ok(!JSON.stringify(detail).includes('HIDDEN_PRIVATE_BIO'));
        for (const asset of [privateCover, privatePortrait]) {
          const r = await fetch(base + `/assets/${asset.id}/file`, { headers: { cookie } });
          assert.equal(r.status, 200);
          assert.equal(r.headers.get('cache-control'), 'no-store');
        }
        await request('GET', `/studio/adventures/${story.id}`, undefined, 404);
        await request('GET', `/studio/adventures/${story.id}/versions`, undefined, 404);
        await request('PATCH', `/studio/adventures/${story.id}`, { title: 'Not allowed' }, 404);
        await request('GET', `/npcs/${privateNpc.id}`, undefined, 404);
        await request('PUT', `/favorites/${story.id}`, {});
        assert.ok((await request('GET', '/library')).shared.some((a) => a.id === story.id));
        await request(
          'POST',
          '/reports',
          { adventureId: story.id, reason: 'Private content safety report' },
          201,
        );
        cookie = ownerCookie;
        await request('DELETE', `/studio/adventures/${story.id}/invitations/${invitation.id}`);
        cookie = recipientCookie;
        await request('GET', `/adventures/${story.slug}`, undefined, 404);
        const revokedAsset = await fetch(base + `/assets/${privateCover.id}/file`, {
          headers: { cookie },
        });
        assert.equal(revokedAsset.status, 404);
        const library = await request('GET', '/library');
        assert.equal(
          library.shared.some((a) => a.id === story.id),
          false,
        );
        assert.equal(
          library.favorites.some((a) => a.id === story.id),
          false,
        );
        await request('POST', `/invitations/${invitation.id}/respond`, { decision: 'accept' }, 409);
        cookie = ownerCookie;
        await request(
          'POST',
          `/studio/adventures/${story.id}/invitations`,
          { handle: recipient.handle },
          201,
        );
        cookie = recipientCookie;
        await request('POST', `/invitations/${invitation.id}/respond`, { decision: 'accept' }, 201);
        await request(
          'POST',
          `/invitations/${invitation.id}/respond`,
          { decision: 'decline' },
          201,
        );
        await request('GET', `/adventures/${story.slug}`, undefined, 404);
        cookie = ownerCookie;
        await request('PATCH', '/account/settings', { defaultVisibility: 'unlisted' }, 400);
        await request('POST', '/npcs', { name: 'No links', visibility: 'unlisted' }, 400);
        const publicReport = await request(
          'POST',
          '/reports',
          { adventureId: adventure.id, reason: 'Public report before author withdraws' },
          201,
        );
        await request('PATCH', `/studio/adventures/${adventure.id}`, {
          visibility: 'private',
          title: `REDACTED_PRIVATE_TITLE_${suffix}`,
        });
        cookie = strangerCookie;
        const adminReports = await request('GET', '/admin/reports');
        assert.equal(adminReports.find((r) => r.id === publicReport.id).adventureTitle, null);
        assert.ok(!JSON.stringify(adminReports).includes(`REDACTED_PRIVATE_TITLE_${suffix}`));
        cookie = ownerCookie;
      },
    );
    await t.test(
      'asset quota serializes concurrent uploads and authenticates before parsing',
      async () => {
        const quotaUser = (
          await request(
            'POST',
            '/auth/register',
            {
              email: `quota-${suffix}@example.test`,
              password: `Quota-${randomUUID()}`,
              name: 'Quota tester',
              handle: `quota_${suffix}`,
            },
            201,
          )
        ).user;
        await pool.query(
          "INSERT INTO assets(owner_id,filename,mime,width,height,bytes,sha256) SELECT $1,'quota-fixture-'||n,'image/webp',1,1,1,'fixture' FROM generate_series(1,199) n",
          [quotaUser.id],
        );
        const image =
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPwi1rwH4QZYAwATVwJHR723W0AAAAASUVORK5CYII=';
        const send = async (authenticated = true) => {
          const form = new FormData();
          form.append(
            'file',
            new Blob([Buffer.from(image, 'base64')], { type: 'image/png' }),
            'quota.png',
          );
          return fetch(base + '/assets', {
            method: 'POST',
            headers: { origin, ...(authenticated ? { cookie } : {}) },
            body: form,
          });
        };
        assert.equal((await send(false)).status, 401);
        const replies = await Promise.all([send(), send()]);
        assert.deepEqual(replies.map((r) => r.status).sort(), [201, 413]);
        const rejected = replies.find((r) => r.status === 413);
        assert.equal((await rejected.json()).code, 'ASSET_QUOTA_EXCEEDED');
        assert.equal(
          (
            await pool.query('SELECT count(*)::int AS count FROM assets WHERE owner_id=$1', [
              quotaUser.id,
            ])
          ).rows[0].count,
          200,
        );
        await pool.query(
          "DELETE FROM assets WHERE owner_id=$1 AND filename LIKE 'quota-fixture-%'",
          [quotaUser.id],
        );
        await pool.query('UPDATE assets SET bytes=$2 WHERE owner_id=$1', [
          quotaUser.id,
          100 * 1024 * 1024,
        ]);
        const bytesRejected = await send();
        assert.equal(bytesRejected.status, 413);
        assert.equal((await bytesRejected.json()).code, 'ASSET_QUOTA_EXCEEDED');
      },
    );
  } finally {
    await pool.end();
  }
});
