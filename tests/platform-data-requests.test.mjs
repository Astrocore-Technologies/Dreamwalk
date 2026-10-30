import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
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
const owner = client(),
  stranger = client();
const password = `Export-${randomUUID()}`;
const operator = async (id, extra = []) =>
  run(
    process.execPath,
    ['scripts/process-data-request.mjs', '--request', id, '--operator', 'synthetic-test', ...extra],
    { cwd: process.cwd(), env: process.env },
  );
await test('explicit operator export and erasure are authenticated, scoped and retryable', async (t) => {
  try {
    const user = (
      await owner.call(
        'POST',
        '/auth/register',
        {
          email: `export-${suffix}@example.test`,
          name: 'Export author',
          handle: `export_${suffix}`,
          password,
        },
        201,
      )
    ).user;
    await stranger.call(
      'POST',
      '/auth/register',
      {
        email: `export-other-${suffix}@example.test`,
        name: 'Other',
        handle: `other_${suffix}`,
        password,
      },
      201,
    );
    const story = (
      await db.query(
        "INSERT INTO adventures(owner_id,slug,title,genre,data) VALUES($1,$2,'Sensitive original','fantasy','{}') RETURNING id",
        [user.id, `export-${suffix}`],
      )
    ).rows[0];
    await db.query(
      'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,1,\'{"privateText":"sensitive history"}\')',
      [story.id],
    );
    await db.query(
      'INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,\'synthetic.personal\',$2,\'{"reason":"personal prose"}\')',
      [user.id, story.id],
    );
    await db.query(
      "INSERT INTO ledger(user_id,actor_id,amount,reason,source_key) VALUES($1,$1,1,'personal credit reason',$2)",
      [user.id, `export-ledger-${suffix}`],
    );
    const assetId = randomUUID(),
      assetDir = resolve(process.env.ASSET_DIR || '.local/assets'),
      assetFile = resolve(assetDir, `${assetId}.webp`);
    await mkdir(assetDir, { recursive: true });
    await writeFile(assetFile, 'synthetic owned media');
    await db.query(
      "INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,'image/webp',1,1,21,'synthetic')",
      [assetId, user.id, `${assetId}.webp`],
    );
    const request = await owner.call('POST', '/account/export', undefined, 201);
    await t.test(
      'completed export contains own content but no credentials; other owner cannot download',
      async () => {
        await owner.call('GET', `/account/exports/${request.id}/download`, undefined, 404);
        await owner.call('GET', '/account/exports/invalid/download', undefined, 400);
        await operator(request.id);
        const data = await owner.call('GET', `/account/exports/${request.id}/download`);
        assert.equal(data.profile.email, `export-${suffix}@example.test`);
        assert.equal(
          Buffer.from(data.assets[0].base64, 'base64').toString(),
          'synthetic owned media',
        );
        assert.equal(data.versions[0].snapshot.privateText, 'sensitive history');
        assert.equal(
          /password_hash|token_hash|source_key|operator_reference/.test(JSON.stringify(data)),
          false,
        );
        await stranger.call('GET', `/account/exports/${request.id}/download`, undefined, 404);
        assert.equal((await owner.call('GET', '/account/exports'))[0].status, 'completed');
        await operator(request.id);
      },
    );
    await t.test(
      'expired exports cannot download and explicit expiry removes persisted artifact',
      async () => {
        await db.query(
          "UPDATE data_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
          [request.id],
        );
        await owner.call('GET', `/account/exports/${request.id}/download`, undefined, 404);
        await operator(request.id, ['--expire']);
        assert.equal(
          (await db.query('SELECT artifact FROM data_requests WHERE id=$1', [request.id])).rows[0]
            .artifact,
          null,
        );
      },
    );
    await t.test(
      'immutable rows cannot be arbitrarily changed even with erasure flag',
      async () => {
        const c = await db.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
          await assert.rejects(
            c.query(
              'UPDATE adventure_versions SET snapshot=\'{"erased":true}\' WHERE adventure_id=$1',
              [story.id],
            ),
          );
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      },
    );
    await t.test(
      'unsafe stored paths fail closed and the same failed request is retryable',
      async () => {
        const retry = await owner.call('POST', '/account/export', undefined, 201);
        await db.query('UPDATE assets SET filename=$2 WHERE id=$1', [assetId, '../outside.webp']);
        await assert.rejects(operator(retry.id));
        assert.equal(
          (await db.query('SELECT status FROM data_requests WHERE id=$1', [retry.id])).rows[0]
            .status,
          'failed',
        );
        await db.query('UPDATE assets SET filename=$2 WHERE id=$1', [assetId, `${assetId}.webp`]);
        await operator(retry.id);
        await owner.call('GET', `/account/exports/${retry.id}/download`);
      },
    );
    await owner.call('DELETE', '/account', { password, confirmation: 'DELETE' });
    await db.query(
      "INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'reset',now()+interval '1 hour')",
      [user.id.replaceAll('-', '').repeat(2), user.id],
    );
    const deletion = (
      await db.query("SELECT id FROM data_requests WHERE user_id=$1 AND kind='deletion'", [user.id])
    ).rows[0];
    await t.test(
      'purge requires explicit UUID confirmation and keeps fixed nonidentifying history',
      async () => {
        await assert.rejects(operator(deletion.id));
        await operator(deletion.id, ['--confirm-purge', deletion.id]);
        await assert.rejects(access(assetFile));
        assert.equal(
          (await db.query('SELECT * FROM auth_email_tokens WHERE user_id=$1', [user.id])).rowCount,
          0,
        );
        assert.equal(
          (await db.query('SELECT id FROM assets WHERE owner_id=$1', [user.id])).rowCount,
          0,
        );
        assert.deepEqual(
          (
            await db.query('SELECT snapshot FROM adventure_versions WHERE adventure_id=$1', [
              story.id,
            ])
          ).rows[0].snapshot,
          { erased: true },
        );
        const ledger = (
          await db.query('SELECT amount,reason,source_key,id FROM ledger WHERE user_id=$1', [
            user.id,
          ])
        ).rows[0];
        assert.equal(ledger.amount, 1);
        assert.equal(ledger.reason, 'Erased account');
        assert.equal(ledger.source_key, `erased:${ledger.id}`);
        assert.equal(
          (await db.query('SELECT status FROM data_requests WHERE id=$1', [deletion.id])).rows[0]
            .status,
          'completed',
        );
        await operator(deletion.id, ['--confirm-purge', deletion.id]);
        await assert.rejects(
          db.query("UPDATE adventure_versions SET snapshot='{}' WHERE adventure_id=$1", [story.id]),
        );
        for (const [sql, values] of [
          [
            'UPDATE adventure_versions SET snapshot=\'{"arbitrary":true}\' WHERE adventure_id=$1',
            [story.id],
          ],
          ['UPDATE audit SET details=\'{"arbitrary":true}\' WHERE actor_id=$1', [user.id]],
        ]) {
          const connection = await db.connect();
          try {
            await connection.query('BEGIN');
            await connection.query("SET LOCAL dreamwalk.erasure='confirmed'");
            await assert.rejects(connection.query(sql, values));
            await connection.query('ROLLBACK');
          } finally {
            connection.release();
          }
        }
        const c = await db.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
          await assert.rejects(c.query('UPDATE ledger SET amount=99 WHERE user_id=$1', [user.id]));
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      },
    );
  } finally {
    await db.end();
  }
});
