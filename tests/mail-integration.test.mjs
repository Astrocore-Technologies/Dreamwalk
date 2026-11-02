/** Local SMTP capture only. No message content or bearer token is logged or written to disk. */
import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { startLocalPostgres } from '../scripts/postgres-local.mjs';
import { forceMockNpcTestEnvironment } from '../scripts/mock-npc-test-env.mjs';
forceMockNpcTestEnvironment();
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function run(args) {
  const p = spawn(process.execPath, args, { env: process.env, stdio: 'ignore' });
  const [code] = await once(p, 'exit');
  assert.equal(code, 0);
}
async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
test('SMTP capture: reset, verification, nonenumeration, expiry, replay, session revocation', async () => {
  delete process.env.DATABASE_URL;
  process.env.LOCAL_POSTGRES_CLUSTER = `mail-test-${Date.now()}`;
  process.env.LOCAL_POSTGRES_PORT = String(await freePort());
  const database = await startLocalPostgres();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const messages = [];
  let rejectDeliveries = false;
  const sockets = new Set();
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test capture\r\n');
    let buffer = '',
      data = false,
      message = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            messages.push(message);
            message = '';
            data = false;
            socket.write('250 captured\r\n');
          } else message += line + '\n';
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (line === 'DATA') {
          if (rejectDeliveries) {
            socket.write('451 delivery unavailable\r\n');
            continue;
          }
          data = true;
          socket.write('354 send\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  smtp.listen(0, '127.0.0.1');
  await once(smtp, 'listening');
  let api;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api/v1`;
  let cookie = '';
  async function call(route, body, status = 201) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    if (response.headers.getSetCookie().length)
      cookie = response.headers.getSetCookie()[0].split(';')[0];
    assert.equal(response.status, status);
    return response.json();
  }
  async function start(enabled, required = false) {
    api = spawn(process.execPath, ['apps/api/dist/main.js'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        API_PORT: String(port),
        WEB_ORIGIN: 'http://localhost:3000',
        AUTH_EMAIL_VERIFICATION_REQUIRED: String(required),
        SMTP_HOST: enabled ? '127.0.0.1' : undefined,
        SMTP_PORT: String(smtp.address().port),
        SMTP_FROM: enabled ? 'test@example.test' : undefined,
        SMTP_USER: undefined,
        SMTP_PASSWORD: undefined,
        SMTP_SECURE: 'false',
      },
    });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(base + '/health')).ok) return;
      } catch {
        /* Wait only for this isolated loopback API. */
      }
      await delay(100);
    }
    throw Error('Mail test API startup failed');
  }
  async function stop() {
    if (api) {
      api.kill('SIGTERM');
      await once(api, 'exit');
      api = null;
    }
  }
  async function captured(count) {
    for (let i = 0; i < 100 && messages.length < count; i++) await delay(50);
    assert.equal(messages.length, count);
    const capturedMessage = messages[count - 1];
    const raw = /Content-Transfer-Encoding: base64/i.test(capturedMessage)
      ? Buffer.from(
          capturedMessage.split('\n\n').slice(1).join('\n\n').replace(/\s/g, ''),
          'base64',
        ).toString('utf8')
      : capturedMessage.replace(/=\n/g, '').replace(/=3D/g, '=');
    const token = raw.match(/#token=([a-f0-9]{64})/)?.[1];
    assert.ok(token, 'Fragment bearer link captured');
    assert.ok(!raw.includes('?token='));
    return token;
  }
  try {
    await run(['--import', 'tsx', 'apps/api/src/migrate.ts']);
    await start(false);
    assert.equal(
      (await call('/auth/reset-password', { email: 'unknown@example.test' })).code,
      'EMAIL_DELIVERY_UNAVAILABLE',
    );
    await call('/auth/register', {
      email: 'disabled@example.test',
      password: 'Disabled-test-password-123',
      name: 'Disabled mail',
      handle: 'disabled_mail',
    });
    assert.equal(
      (await call('/auth/reset-password', { email: 'disabled@example.test' })).code,
      'EMAIL_DELIVERY_UNAVAILABLE',
    );
    assert.equal(
      (await call('/account/email-verification/request', {})).code,
      'EMAIL_DELIVERY_UNAVAILABLE',
    );
    assert.equal((await pool.query('SELECT count(*) FROM auth_email_tokens')).rows[0].count, '0');
    assert.equal(
      (await pool.query('SELECT count(*) FROM auth_email_cooldowns')).rows[0].count,
      '0',
    );
    await stop();
    await start(true);
    const suffix = randomUUID().slice(0, 8),
      email = `mail-${suffix}@example.test`,
      password = 'Temporary-test-password-123';
    const { user } = await call('/auth/register', {
      email,
      password,
      name: 'Mail test',
      handle: `mail_${suffix}`,
    });
    assert.equal(user.emailVerified, false);
    assert.deepEqual(
      await call('/auth/reset-password', { email }),
      await call('/auth/reset-password', { email: 'absent@example.test' }),
    );
    const token = await captured(1);
    const stored = (await pool.query('SELECT * FROM auth_email_tokens WHERE user_id=$1', [user.id]))
      .rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].token_hash, hash(token));
    assert.ok(!JSON.stringify(stored).includes(token));
    await call('/auth/reset-password', { email });
    await delay(100);
    assert.equal(messages.length, 1, 'Cooldown suppresses repeat email');
    await call('/auth/verify-email', { token }, 400);
    await call('/auth/reset-password/confirm', { token: 'malformed', password }, 400);
    const newPassword = 'New-test-password-456';
    await call('/auth/reset-password/confirm', { token, password: newPassword });
    assert.equal(
      (await pool.query('SELECT count(*) FROM sessions WHERE user_id=$1', [user.id])).rows[0].count,
      '0',
    );
    assert.equal(
      (await call('/auth/reset-password/confirm', { token, password: newPassword }, 400)).code,
      'TOKEN_INVALID',
    );
    await call('/auth/login', { email, password }, 401);
    await call('/auth/login', { email, password: newPassword });
    await call('/account/email-verification/request', {});
    const verify = await captured(2);
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        fetch(base + '/auth/verify-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: verify }),
        }),
      ),
    );
    assert.deepEqual(
      concurrent.map((r) => r.status).sort(),
      [201, 400],
      'Concurrent token consumption succeeds exactly once',
    );
    assert.equal(
      (await pool.query('SELECT email_verified FROM users WHERE id=$1', [user.id])).rows[0]
        .email_verified,
      true,
    );
    await call('/auth/verify-email', { token: verify }, 400);
    const expired = 'a'.repeat(64);
    await pool.query(
      "INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'reset',now()-interval '1 second')",
      [hash(expired), user.id],
    );
    assert.equal(
      (await call('/auth/reset-password/confirm', { token: expired, password: newPassword }, 400))
        .code,
      'TOKEN_INVALID',
    );
    await pool.query(
      "UPDATE auth_email_cooldowns SET requested_at=now()-interval '2 minutes' WHERE address_hash=$1 AND purpose='reset'",
      [hash(email)],
    );
    await call('/auth/reset-password', { email });
    const racingToken = await captured(3);
    await pool.query(
      "UPDATE auth_email_cooldowns SET requested_at=now()-interval '2 minutes' WHERE address_hash=$1 AND purpose='reset'",
      [hash(email)],
    );
    const racing = await Promise.all([
      fetch(base + '/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
      fetch(base + '/auth/reset-password/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: racingToken, password: newPassword }),
      }),
    ]);
    assert.equal(racing[0].status, 201);
    assert.ok(
      [201, 400].includes(racing[1].status),
      'Concurrent replacement/consume must never deadlock or return500',
    );
    await captured(4);
    await stop();
    await start(true, true);
    const pending = await call('/auth/register', {
      email: 'pending@example.test',
      password,
      name: 'Pending',
      handle: 'pending_verified',
    });
    assert.equal(pending.user.emailVerificationRequired, true);
    assert.equal(pending.user.emailVerified, false);
    assert.equal(
      (await pool.query('SELECT count(*) FROM spark_wallets WHERE owner_id=$1', [pending.user.id]))
        .rows[0].count,
      '0',
    );
    const pendingCookie = cookie;
    assert.equal((await fetch(base + '/sparks/wallet', { headers: { cookie } })).status, 403);
    assert.equal((await fetch(base + '/auth/me', { headers: { cookie } })).status, 200);
    await call('/account/email-verification/request', {}); // cooldown, session allowed
    const pendingToken = await captured(5);
    const pendingRace = await Promise.all(
      [1, 2].map(() =>
        fetch(base + '/auth/verify-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: pendingToken }),
        }),
      ),
    );
    assert.deepEqual(pendingRace.map((r) => r.status).sort(), [201, 400]);
    assert.equal(
      (
        await pool.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [
          pending.user.id,
        ])
      ).rows[0].balance_subunits,
      '500000',
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM spark_ledger WHERE owner_id=$1 AND kind='starter_grant'",
          [pending.user.id],
        )
      ).rows[0].count,
      '1',
    );
    assert.equal(
      (await fetch(base + '/sparks/wallet', { headers: { cookie: pendingCookie } })).status,
      200,
    );
    // Legacy account remains explicitly unverified but is not locked by activation.
    await call('/auth/login', {
      email: 'disabled@example.test',
      password: 'Disabled-test-password-123',
    });
    const legacy = await (await fetch(base + '/auth/me', { headers: { cookie } })).json();
    assert.equal(legacy.user.emailVerified, false);
    assert.equal(legacy.user.emailVerificationRequired, false);
    assert.equal((await fetch(base + '/sparks/wallet', { headers: { cookie } })).status, 200);
    rejectDeliveries = true;
    const failedDelivery = await call('/auth/register', {
      email: 'retry-delivery@example.test',
      password,
      name: 'Retry delivery',
      handle: 'retry_delivery',
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      const tokens = await pool.query('SELECT count(*) FROM auth_email_tokens WHERE user_id=$1', [
        failedDelivery.user.id,
      ]);
      if (tokens.rows[0].count === '0') break;
      await delay(50);
    }
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM auth_email_tokens WHERE user_id=$1', [
          failedDelivery.user.id,
        ])
      ).rows[0].count,
      '0',
      'Rejected mail invalidates unsent bearer',
    );
    assert.equal((await fetch(base + '/sparks/wallet', { headers: { cookie } })).status, 403);
    rejectDeliveries = false;
    await pool.query(
      "UPDATE auth_email_cooldowns SET requested_at=now()-interval '2 minutes' WHERE address_hash=$1",
      [hash('retry-delivery@example.test')],
    );
    const messageCount = messages.length;
    await call('/account/email-verification/request', {});
    const retryToken = await captured(messageCount + 1);
    await call('/auth/verify-email', { token: retryToken });
    assert.equal(
      (
        await pool.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [
          failedDelivery.user.id,
        ])
      ).rows[0].balance_subunits,
      '500000',
    );
    // Provisioning uses signed-claim-shaped local fixtures; no Google endpoints called.
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_FROM = 'test@example.test';
    const require = createRequire(import.meta.url);
    const { provisionGoogleUser } = require('../apps/api/dist/google-auth.js');
    const dbAdapter = {
      tx: async (work) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const result = await work(c);
          await c.query('COMMIT');
          return result;
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        } finally {
          c.release();
        }
      },
    };
    const googleClaims = {
      sub: 'fixture-google-identity',
      email: 'google-fixture@gmail.com',
      email_verified: true,
      name: 'Google fixture',
    };
    const [google1, google2] = await Promise.all(
      [1, 2].map(() => provisionGoogleUser(dbAdapter, googleClaims)),
    );
    assert.equal(google1.id, google2.id);
    assert.equal(google1.email_verified, true);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM spark_ledger WHERE owner_id=$1 AND kind='starter_grant'",
          [google1.id],
        )
      ).rows[0].count,
      '1',
    );
    await assert.rejects(
      provisionGoogleUser(dbAdapter, {
        ...googleClaims,
        sub: 'different',
        email: 'disabled@example.test',
      }),
      { message: 'ACCOUNT_LINK_REQUIRED' },
    );
    const thirdParty = await provisionGoogleUser(dbAdapter, {
      sub: 'third-party-google',
      email: 'third-party@example.test',
      email_verified: true,
    });
    assert.equal(thirdParty.email_verified, false);
    assert.equal(thirdParty.email_verification_required, true);
    assert.equal(
      (await pool.query('SELECT count(*) FROM spark_wallets WHERE owner_id=$1', [thirdParty.id]))
        .rows[0].count,
      '0',
    );
    const returning = await provisionGoogleUser(dbAdapter, {
      ...googleClaims,
      email: 'changed-google@gmail.com',
    });
    assert.equal(
      returning.id,
      google1.id,
      'Stable sub, never changed email, controls returning login',
    );
  } finally {
    await stop();
    for (const s of sockets) s.destroy();
    await new Promise((r) => smtp.close(r));
    await pool.end();
    await database.stop();
  }
});
