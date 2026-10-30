/** Isolated logical backup/restore drill. Never accepts a user database URL. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { startLocalPostgres } from './postgres-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
assert.ok(
  !process.env.DATABASE_URL,
  'Unset DATABASE_URL: this drill creates only isolated synthetic databases.',
);
assert.notEqual(process.env.NODE_ENV, 'production');
const stamp = Date.now();
process.env.LOCAL_POSTGRES_CLUSTER = `restore-drill-${stamp}`;
process.env.LOCAL_POSTGRES_PORT = '55439';
process.env.NODE_ENV = 'test';
const work = path.join(root, '.local', `restore-drill-${stamp}`);
await mkdir(work, { recursive: true, mode: 0o700 });
const clientBin = process.env.PG_CLIENT_BIN || '';
const executable = (name) => (clientBin ? path.join(clientBin, name) : name);
async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)),
    );
  });
}
await run(executable('pg_dump'), ['--version']);
await run(executable('pg_restore'), ['--version']);
const database = await startLocalPostgres();
const sourceUrl = process.env.DATABASE_URL;
const restoreUrl = new URL(sourceUrl);
restoreUrl.pathname = '/dreamwalk_restored';
const origin = 'http://localhost:3000';
const apiBase = 'http://127.0.0.1:4019/api/v1';
let api, source, restored;
const evidence = { startedAt: new Date().toISOString(), checks: [] };
const mark = (name) => {
  evidence.checks.push(name);
  console.log(`PASS ${name}`);
};
async function stopApi() {
  if (!api) return;
  const child = api;
  api = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
async function startApi(url, assetDir) {
  api = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      DATABASE_URL: url,
      API_PORT: '4019',
      WEB_ORIGIN: origin,
      ASSET_DIR: assetDir,
      AI_PROVIDER: 'mock',
      PAID_GENERATION_ENABLED: 'false',
      PAYMENTS_ENABLED: 'false',
      DISCORD_ENABLED: 'false',
      DEV_AUTH_ENABLED: 'false',
      DEMO_FAUCET_ENABLED: 'false',
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${apiBase}/auth/me`)).ok) return;
    } catch {
      /* Only retry isolated local startup. */
    }
    await delay(100);
  }
  throw new Error('Isolated API did not become ready');
}
function browserSession() {
  let cookie = '';
  return {
    async request(method, route, body, expected = 200) {
      const r = await fetch(apiBase + route, {
        method,
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      assert.equal(
        r.status,
        expected,
        `${method} ${route}: expected ${expected}, received ${r.status}`,
      );
      if (r.headers.getSetCookie().length)
        cookie = r.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ');
      return text ? JSON.parse(text) : null;
    },
    async upload() {
      const f = new FormData();
      f.append(
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
        'synthetic.png',
      );
      const r = await fetch(apiBase + '/assets', {
        method: 'POST',
        headers: { origin, cookie },
        body: f,
      });
      assert.equal(r.status, 201);
      return r.json();
    },
    async asset(id, expected) {
      const r = await fetch(`${apiBase}/assets/${id}/file`, { headers: cookie ? { cookie } : {} });
      assert.equal(r.status, expected);
      return r;
    },
  };
}
async function snapshot(client) {
  const tables = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  const result = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    const rows = (await client.query(`SELECT row_to_json(t) AS data FROM "${table}" t`)).rows
      .map((r) => JSON.stringify(r.data))
      .sort();
    result[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(rows.join('\n')).digest('hex'),
    };
  }
  return result;
}
try {
  await run('npm', ['run', 'build', '-w', '@dreamwalk/contracts']);
  await run('npm', ['run', 'build', '-w', '@dreamwalk/game-core']);
  await run('npm', ['run', 'build', '-w', '@dreamwalk/api']);
  await run('npm', ['run', 'db:migrate']);
  await run('npm', ['run', 'db:seed']);
  source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  await source.query('CREATE DATABASE dreamwalk_restored');
  const assetsSource = path.join(work, 'assets-source'),
    assetsRestored = path.join(work, 'assets-restored');
  await startApi(sourceUrl, assetsSource);
  const owner = browserSession(),
    invitee = browserSession(),
    outsider = browserSession(),
    anonymous = browserSession();
  const password = `Synthetic-${randomUUID()}!`;
  async function register(session, name) {
    return (
      await session.request(
        'POST',
        '/auth/register',
        { email: `${name}-${stamp}@example.test`, handle: `${name}_${stamp}`, name, password },
        201,
      )
    ).user;
  }
  const ownerUser = await register(owner, 'restoreowner'),
    invitedUser = await register(invitee, 'restoreguest');
  await register(outsider, 'restoreoutside');
  await source.query("UPDATE users SET role='admin' WHERE id=$1", [ownerUser.id]);
  const asset = await owner.upload();
  const npc = await owner.request(
    'POST',
    '/npcs',
    { name: 'Restore NPC', secrets: 'SYNTHETIC_PRIVATE_SECRET', greeting: 'Welcome' },
    201,
  );
  const payload = {
    title: 'Synthetic restored private world',
    synopsis: 'Only invited members can read this synthetic story.',
    visibility: 'private',
    coverAssetId: asset.id,
    content: {
      world: 'Synthetic world',
      locations: [{ id: 'room', name: 'Room' }],
      npcIds: [npc.id],
      scenes: [{ id: 'start', name: 'Start', locationId: 'room' }],
      startSceneId: 'start',
    },
  };
  const privateWorld = await owner.request('POST', '/studio/adventures', payload, 201);
  const invitation = await owner.request(
    'POST',
    `/studio/adventures/${privateWorld.id}/invitations`,
    { handle: invitedUser.handle },
    201,
  );
  await invitee.request(
    'POST',
    `/invitations/${invitation.id}/respond`,
    { decision: 'accept' },
    201,
  );
  const published = await owner.request(
    'POST',
    '/studio/adventures',
    {
      ...payload,
      title: 'Synthetic immutable public world',
      visibility: 'public',
      coverAssetId: null,
    },
    201,
  );
  await owner.request('POST', `/studio/adventures/${published.id}/submit`, {}, 201);
  await owner.request(
    'POST',
    `/admin/adventures/${published.id}/moderate`,
    { decision: 'approve', reason: 'Isolated backup drill' },
    201,
  );
  await owner.request(
    'POST',
    '/admin/credits',
    {
      userId: ownerUser.id,
      amount: 125,
      reason: 'Synthetic restore credit',
      idempotencyKey: `restore-${stamp}`,
    },
    201,
  );
  await owner.request('PATCH', '/account/settings', { language: 'uk', timezone: 'Europe/Kyiv' });
  const beforeVersions = await owner.request('GET', `/studio/adventures/${published.id}/versions`);
  await stopApi();
  const before = await snapshot(source);
  const sourceConfig = new URL(sourceUrl);
  const toolEnv = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: sourceConfig.port,
    PGUSER: decodeURIComponent(sourceConfig.username),
    PGPASSWORD: decodeURIComponent(sourceConfig.password),
    PGDATABASE: 'dreamwalk',
  };
  const dump = path.join(work, 'synthetic.dump');
  await run(executable('pg_dump'), ['--format=custom', '--no-password', '--file', dump], toolEnv);
  await chmod(dump, 0o600);
  await mkdir(assetsRestored, { recursive: true, mode: 0o700 });
  await cp(assetsSource, assetsRestored, { recursive: true });
  await run(
    executable('pg_restore'),
    [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-password',
      '--dbname',
      'dreamwalk_restored',
      dump,
    ],
    { ...toolEnv, PGDATABASE: 'dreamwalk_restored' },
  );
  restored = new pg.Client({ connectionString: restoreUrl.toString() });
  await restored.connect();
  assert.deepEqual(await snapshot(restored), before);
  mark('all public tables: exact row counts and content SHA-256 match after logical restore');
  await run('npm', ['run', 'db:migrate'], { ...process.env, DATABASE_URL: restoreUrl.toString() });
  assert.deepEqual(await snapshot(restored), before);
  mark('migration rerun preserves restored data and migration checksums');
  const files = (await restored.query('SELECT filename,sha256 FROM assets')).rows;
  for (const file of files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(assetsRestored, file.filename)))
        .digest('hex'),
      file.sha256,
    );
  mark('restored private asset bytes match database SHA-256');
  const inconsistent = await restored.query(
    'SELECT w.user_id FROM wallets w LEFT JOIN ledger l ON l.user_id=w.user_id GROUP BY w.user_id,w.balance HAVING w.balance<>COALESCE(SUM(l.amount),0)',
  );
  assert.equal(inconsistent.rowCount, 0);
  mark('wallet balances equal restored append-only integer ledger sums');
  await assert.rejects(restored.query('UPDATE ledger SET reason=reason'), /Append-only table/i);
  await assert.rejects(
    restored.query('UPDATE adventure_versions SET snapshot=snapshot'),
    /Append-only table/i,
  );
  mark('ledger and published-version immutability triggers restored');
  await startApi(restoreUrl.toString(), assetsRestored);
  assert.equal((await owner.request('GET', '/auth/me')).user.id, ownerUser.id);
  mark('existing synthetic session authenticates after restore');
  const fresh = browserSession();
  await fresh.request(
    'POST',
    '/auth/login',
    { email: `restoreowner-${stamp}@example.test`, password },
    201,
  );
  mark('restored password hash supports a fresh login');
  await anonymous.request('GET', `/adventures/${privateWorld.slug}`, undefined, 404);
  await outsider.request('GET', `/adventures/${privateWorld.slug}`, undefined, 404);
  const shared = await invitee.request('GET', `/adventures/${privateWorld.slug}`);
  assert.equal(shared.id, privateWorld.id);
  assert.ok(!JSON.stringify(shared).includes('SYNTHETIC_PRIVATE_SECRET'));
  await invitee.request(
    'PATCH',
    `/studio/adventures/${privateWorld.id}`,
    { title: 'Forbidden' },
    404,
  );
  mark('private ownership, accepted invitation read-only ACL and NPC secret exclusion survive');
  await anonymous.asset(asset.id, 404);
  await outsider.asset(asset.id, 404);
  await invitee.asset(asset.id, 200);
  mark('private media ACL and file delivery survive restore');
  const publicAfter = await anonymous.request('GET', `/adventures/${published.slug}`);
  assert.equal(publicAfter.title, published.title);
  assert.deepEqual(
    await owner.request('GET', `/studio/adventures/${published.id}/versions`),
    beforeVersions,
  );
  mark('published immutable snapshots remain public and unchanged');
  await owner.request(
    'DELETE',
    `/studio/adventures/${privateWorld.id}/invitations/${invitation.id}`,
  );
  await invitee.request('GET', `/adventures/${privateWorld.slug}`, undefined, 404);
  await invitee.asset(asset.id, 404);
  mark('revoking a restored invitation immediately removes content and asset access');
  evidence.tableCounts = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.count]));
  evidence.completedAt = new Date().toISOString();
  evidence.result = 'passed';
  await writeFile(path.join(work, 'evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(
    `Restore drill PASSED: ${evidence.checks.length} checks. Private evidence under .local/restore-drill-${stamp}/evidence.json.`,
  );
} finally {
  await stopApi();
  await source?.end();
  await restored?.end();
  await database.stop();
}
