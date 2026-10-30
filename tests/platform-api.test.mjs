/** Real PostgreSQL + live Nest integration suite. Never runs against non-loopback API/DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const base = process.env.TEST_API_URL || 'http://127.0.0.1:4000/api/v1';
const origin = process.env.TEST_WEB_ORIGIN || 'http://localhost:3000';
const connectionString = process.env.DATABASE_URL;
for (const value of [base, connectionString]) {
  assert.ok(value, 'DATABASE_URL must point to a local disposable test database');
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname),
    'Tests refuse non-local services',
  );
}
const pool = new pg.Pool({ connectionString });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const password = `Qa-${randomUUID()}!`;
const member = {
  email: `member-${suffix}@example.test`,
  name: 'Тестовый путешественник',
  handle: `member_${suffix}`,
  password,
};
const author = {
  email: `author-${suffix}@example.test`,
  name: 'Тестовый автор',
  handle: `author_${suffix}`,
  password,
};

function session() {
  let cookie = '';
  return {
    async request(method, route, body, status = 200, extraHeaders = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          'content-type': 'application/json',
          origin,
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
      const text = await response.text();
      let result;
      try {
        result = text ? JSON.parse(text) : null;
      } catch {
        result = text;
      }
      assert.equal(
        response.status,
        status,
        `${method} ${route}: ${response.status} ${JSON.stringify(result)}`,
      );
      return result;
    },
    getCookie: () => cookie,
  };
}

const anonymous = session();
const player = session();
const writer = session();
const admin = session();

await test('platform persistence, ownership, moderation and accounting', async (t) => {
  try {
    const version = await pool.query('SHOW server_version');
    assert.match(version.rows[0].server_version, /^\d/);
    await t.test('anonymous can browse but not read private or administrator data', async () => {
      assert.ok(Array.isArray(await anonymous.request('GET', '/adventures')));
      assert.equal((await anonymous.request('GET', '/auth/me')).user, null);
      await anonymous.request('GET', '/library', undefined, 401);
      await anonymous.request('GET', '/admin/users', undefined, 401);
    });
    let playerUser, writerUser;
    await t.test(
      'register real identities, reject duplicate identity and login errors',
      async () => {
        playerUser = (await player.request('POST', '/auth/register', member, 201)).user;
        writerUser = (await writer.request('POST', '/auth/register', author, 201)).user;
        assert.ok(playerUser.id && writerUser.id);
        assert.notEqual(playerUser.id, writerUser.id);
        await anonymous.request('POST', '/auth/register', member, 409);
        await anonymous.request(
          'POST',
          '/auth/login',
          { email: member.email, password: 'wrong-password' },
          401,
        );
        await player.request('GET', '/admin/users', undefined, 403);
        await player.request(
          'POST',
          '/admin/credits',
          { userId: playerUser.id, amount: 100, reason: 'forbidden', idempotencyKey: randomUUID() },
          403,
        );
      },
    );
    await t.test(
      'profile, settings, onboarding and sessions persist across new login',
      async () => {
        await player.request('PATCH', '/account/profile', {
          name: 'Имя после сохранения',
          handle: member.handle,
          bio: 'Проверка постоянного профиля.',
        });
        await player.request('PATCH', '/account/settings', {
          theme: 'light',
          timezone: 'Europe/Paris',
          reducedMotion: true,
          profilePublic: false,
          genres: ['Фэнтези'],
        });
        for (const language of ['uk', 'en', 'ru']) {
          await player.request('PATCH', '/account/settings', { language });
          assert.equal((await player.request('GET', '/auth/me')).user.settings.language, language);
          const languageSession = session();
          assert.equal(
            (
              await languageSession.request(
                'POST',
                '/auth/login',
                { email: member.email, password },
                201,
              )
            ).user.settings.language,
            language,
          );
        }
        await player.request('PATCH', '/account/settings', { language: 'invalid' }, 400);
        await player.request(
          'POST',
          '/account/onboarding',
          { purpose: 'both', name: 'Имя после сохранения' },
          201,
        );
        const originalSession = (await player.request('GET', '/account/sessions')).find(
          (item) => item.current,
        );
        const fresh = session();
        const login = await fresh.request(
          'POST',
          '/auth/login',
          { email: member.email, password },
          201,
        );
        assert.equal(login.user.name, 'Имя после сохранения');
        assert.equal(login.user.settings.theme, 'light');
        assert.equal(login.user.settings.reducedMotion, true);
        assert.equal(login.user.onboarded, true);
        const sessions = await fresh.request('GET', '/account/sessions');
        assert.ok(sessions.length >= 2);
        const old = sessions.find((item) => item.id === originalSession.id);
        assert.ok(old);
        await fresh.request('DELETE', `/account/sessions/${old.id}`);
        await player.request('GET', '/library', undefined, 401);
        await player.request('POST', '/auth/login', { email: member.email, password }, 201);
        const csrf = await fetch(`${base}/account/settings`, {
          method: 'PATCH',
          headers: {
            cookie: player.getCookie(),
            origin: 'https://attacker.invalid',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ theme: 'dark' }),
        });
        assert.equal(csrf.status, 403);
      },
    );
    let hero, npc, adventure;
    await t.test('hero and private NPC are separate owned records', async () => {
      hero = await writer.request(
        'POST',
        '/heroes',
        {
          name: 'Эйра',
          backstory: 'Картограф с северных островов.',
          notes: 'Личные заметки',
          traits: ['Наблюдательность'],
        },
        201,
      );
      npc = await writer.request(
        'POST',
        '/npcs',
        {
          name: 'Смотритель',
          age: 54,
          role: 'Хранитель обсерватории',
          personality: 'Спокойный',
          appearance: 'Плащ цвета звёзд',
          biography: 'Живёт у башни',
          secrets: 'SECRET_NEVER_PUBLIC',
          greeting: 'Добро пожаловать',
          visibility: 'private',
        },
        201,
      );
      assert.notEqual(hero.id, npc.id);
      await player.request('PATCH', `/heroes/${hero.id}`, { name: 'Чужой' }, 404);
      await player.request('GET', `/npcs/${npc.id}`, undefined, 404);
      assert.equal((await writer.request('GET', `/npcs/${npc.id}`)).secrets, 'SECRET_NEVER_PUBLIC');
    });
    await t.test('raster uploads are owned, reencoded and refuse active content', async () => {
      const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPwi1rwH4QZYAwATVwJHR723W0AAAAASUVORK5CYII=',
        'base64',
      );
      const form = new FormData();
      form.append('file', new Blob([tinyPng], { type: 'image/png' }), 'portrait.png');
      const uploaded = await fetch(`${base}/assets`, {
        method: 'POST',
        headers: { origin, cookie: writer.getCookie() },
        body: form,
      });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const asset = await uploaded.json();
      assert.equal(asset.mime, 'image/webp');
      const denied = await fetch(`${base}/assets/${asset.id}/file`, {
        headers: { cookie: player.getCookie() },
      });
      assert.equal(denied.status, 404);
      const allowed = await fetch(`${base}/assets/${asset.id}/file`, {
        headers: { cookie: writer.getCookie() },
      });
      assert.equal(allowed.status, 200);
      assert.match(allowed.headers.get('content-type'), /image\/webp/);
      const invalid = new FormData();
      invalid.append(
        'file',
        new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/svg+xml' }),
        'unsafe.svg',
      );
      const rejected = await fetch(`${base}/assets`, {
        method: 'POST',
        headers: { origin, cookie: writer.getCookie() },
        body: invalid,
      });
      assert.equal(rejected.status, 400);
      const spoofed = new FormData();
      spoofed.append(
        'file',
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'], {
          type: 'image/png',
        }),
        'pretend-raster.png',
      );
      const spoofedResponse = await fetch(`${base}/assets`, {
        method: 'POST',
        headers: { origin, cookie: writer.getCookie() },
        body: spoofed,
      });
      assert.equal(
        spoofedResponse.status,
        400,
        'Forged MIME must be rejected before calling an image decoder',
      );

      const corrupt = new FormData();
      corrupt.append(
        'file',
        new Blob(
          [
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
              'base64',
            ),
          ],
          { type: 'image/png' },
        ),
        'corrupt-crc.png',
      );
      const corruptResult = await fetch(`${base}/assets`, {
        method: 'POST',
        headers: { origin, cookie: writer.getCookie() },
        body: corrupt,
      });
      assert.equal(
        corruptResult.status,
        400,
        'A valid PNG header must not bypass full decoder validation',
      );
    });
    await t.test(
      'draft is private, validates references, duplicates and enters moderation',
      async () => {
        adventure = await writer.request(
          'POST',
          '/studio/adventures',
          { title: `Обсерватория ${suffix}`, visibility: 'public' },
          201,
        );
        await anonymous.request('GET', `/adventures/${adventure.slug}`, undefined, 404);
        await player.request('GET', `/studio/adventures/${adventure.id}`, undefined, 404);
        await writer.request('POST', `/studio/adventures/${adventure.id}/submit`, {}, 400);
        adventure = await writer.request('PATCH', `/studio/adventures/${adventure.id}`, {
          synopsis: 'Письмо из старой обсерватории приглашает разгадать тайну звёздной карты.',
          genre: 'Фэнтези',
          tags: ['тайна'],
          content: {
            world: 'Город на краю северного моря.',
            rules: 'Магия требует любопытства, а не насилия.',
            locations: [
              { id: 'courtyard', name: 'Двор', description: 'Каменные ступени у башни.' },
            ],
            npcIds: [npc.id],
            scenes: [
              {
                id: 'arrival',
                name: 'Прибытие',
                locationId: 'courtyard',
                description: 'Смотритель ждёт гостей.',
              },
            ],
            startSceneId: 'arrival',
            boundaries: ['Без откровенного контента'],
          },
        });
        const duplicate = await writer.request(
          'POST',
          `/studio/adventures/${adventure.id}/duplicate`,
          {},
          201,
        );
        assert.notEqual(duplicate.id, adventure.id);
        assert.equal(duplicate.status, 'draft');
        adventure = await writer.request(
          'POST',
          `/studio/adventures/${adventure.id}/submit`,
          {},
          201,
        );
        assert.equal(adventure.status, 'pending_review');
        assert.equal(
          (await anonymous.request('GET', '/adventures')).some((item) => item.id === adventure.id),
          false,
        );
      },
    );
    await t.test(
      'admin publication is audited, snapshots version and hides NPC secrets',
      async () => {
        await promisify(execFile)(
          process.execPath,
          ['scripts/admin-grant.mjs', '--email', author.email],
          { env: process.env },
        );
        const localGrant = await pool.query(
          "SELECT 1 FROM audit WHERE actor_id=$1 AND action='operator.local_admin_grant'",
          [writerUser.id],
        );
        assert.equal(
          localGrant.rowCount,
          1,
          'Local operator grant must commit role and audit together',
        );
        await admin.request('POST', '/auth/login', { email: author.email, password }, 201);
        adventure = await admin.request(
          'POST',
          `/admin/adventures/${adventure.id}/moderate`,
          { decision: 'approve', reason: 'Проверено в локальном QA' },
          201,
        );
        assert.equal(adventure.status, 'published');
        const publicDetail = await anonymous.request('GET', `/adventures/${adventure.slug}`);
        assert.ok(!JSON.stringify(publicDetail).includes('SECRET_NEVER_PUBLIC'));
        assert.ok(
          (await anonymous.request('GET', '/adventures')).some((item) => item.id === adventure.id),
        );
        const before = await writer.request('GET', `/studio/adventures/${adventure.id}/versions`);
        assert.ok(before.length);
        await writer.request('PATCH', `/studio/adventures/${adventure.id}`, {
          synopsis: 'Новый неопубликованный текст.',
        });
        const after = await writer.request('GET', `/studio/adventures/${adventure.id}/versions`);
        assert.deepEqual(after, before);
        assert.notEqual(
          (await anonymous.request('GET', `/adventures/${adventure.slug}`)).synopsis,
          'Новый неопубликованный текст.',
        );
        assert.ok((await admin.request('GET', '/admin/audit')).length);
      },
    );
    await t.test('favorites and reports are real persistent records', async () => {
      await player.request('PUT', `/favorites/${adventure.id}`, {});
      await player.request('PUT', `/favorites/${adventure.id}`, {});
      const library = await player.request('GET', '/library');
      assert.equal(library.favorites.filter((item) => item.id === adventure.id).length, 1);
      await player.request(
        'POST',
        '/reports',
        { adventureId: adventure.id, reason: 'Тестовая жалоба для проверки модерации.' },
        201,
      );
      assert.ok(
        (await admin.request('GET', '/admin/reports')).some(
          (item) => item.adventureId === adventure.id,
        ),
      );
      await player.request('DELETE', `/favorites/${adventure.id}`);
    });
    await t.test('demo ledger is idempotent, append-only and concurrency-safe', async () => {
      const before = await player.request('GET', '/wallet');
      assert.equal(before.mode, 'demo');
      const grant = {
        userId: playerUser.id,
        amount: 37,
        reason: 'QA grant',
        idempotencyKey: randomUUID(),
      };
      await admin.request('POST', '/admin/credits', grant, 201);
      await admin.request('POST', '/admin/credits', grant, 201);
      let wallet = await player.request('GET', '/wallet');
      assert.equal(wallet.balance, before.balance + 37);
      await admin.request('POST', '/admin/credits', { ...grant, amount: 38 }, 409);
      const debit = -wallet.balance;
      const responses = await Promise.all(
        [1, 2].map(async (index) =>
          fetch(`${base}/admin/credits`, {
            method: 'POST',
            headers: { origin, cookie: admin.getCookie(), 'content-type': 'application/json' },
            body: JSON.stringify({
              userId: playerUser.id,
              amount: debit,
              reason: `QA concurrent debit ${index}`,
              idempotencyKey: randomUUID(),
            }),
          }),
        ),
      );
      assert.deepEqual(responses.map((res) => res.status).sort(), [201, 409]);
      wallet = await player.request('GET', '/wallet');
      assert.equal(wallet.balance, 0);
      assert.ok(wallet.ledger.length >= before.ledger.length + 2);
      await assert.rejects(
        pool.query('UPDATE ledger SET amount=amount+1 WHERE user_id=$1', [playerUser.id]),
        /Append-only/,
      );
      const totals = await pool.query(
        'SELECT COALESCE(sum(amount),0)::int AS total FROM ledger WHERE user_id=$1',
        [playerUser.id],
      );
      assert.equal(totals.rows[0].total, wallet.balance);
    });
    await t.test(
      'runtime configuration refuses external endpoints and live generation',
      async () => {
        await admin.request(
          'POST',
          '/admin/runtimes',
          {
            name: 'Disallowed endpoint',
            provider: 'local',
            model: 'test',
            enabled: false,
            endpointId: 'http://169.254.169.254',
            maxInputTokens: 4096,
            maxOutputTokens: 512,
            timeoutMs: 10000,
            concurrency: 1,
          },
          400,
        );
        await admin.request(
          'POST',
          '/admin/runtimes',
          {
            name: 'Disallowed live',
            provider: 'openai',
            model: 'test',
            enabled: true,
            endpointId: 'openai',
            maxInputTokens: 4096,
            maxOutputTokens: 512,
            timeoutMs: 10000,
            concurrency: 1,
          },
          400,
        );
        assert.ok(
          (await anonymous.request('GET', '/store/packages')).every(
            (item) => item.demo === true && item.available === false,
          ),
        );
      },
    );
    await t.test(
      'admin edits model versions, resolves reports and quarantines publication',
      async () => {
        const models = await admin.request('GET', '/admin/models');
        const model = models.find((item) => item.key === 'green_apple');
        assert.ok(model);
        const updated = await admin.request('PATCH', `/admin/models/${model.id}`, {
          instructions: 'QA version: concise, adventurous and respectful.',
          enabled: false,
        });
        assert.equal(updated.version, model.version + 1);
        assert.equal(updated.enabled, false);
        await assert.rejects(
          pool.query('UPDATE model_profile_versions SET version=99 WHERE model_id=$1', [model.id]),
          /Append-only/,
        );
        const report = (await admin.request('GET', '/admin/reports')).find(
          (item) => item.adventureId === adventure.id,
        );
        const resolved = await admin.request('PATCH', `/admin/reports/${report.id}`, {
          status: 'resolved',
          resolution: 'QA: проверено модератором',
        });
        assert.equal(resolved.status, 'resolved');
        await admin.request(
          'POST',
          `/admin/adventures/${adventure.id}/moderate`,
          { decision: 'quarantine', reason: 'QA проверка карантина' },
          201,
        );
        assert.equal(
          (await anonymous.request('GET', '/adventures')).some((item) => item.id === adventure.id),
          false,
        );
        await anonymous.request('GET', `/adventures/${adventure.slug}`, undefined, 404);
      },
    );
    await t.test(
      'export, password change and confirmed account deletion behave honestly',
      async () => {
        const exported = await player.request('POST', '/account/export', {}, 201);
        assert.equal(exported.status, 'requested');
        const reset = await anonymous.request(
          'POST',
          '/auth/reset-password',
          { email: member.email },
          201,
        );
        assert.equal(reset.code, 'EMAIL_DELIVERY_UNAVAILABLE');
        assert.ok(reset.message);
        const newPassword = `${password}-new`;
        await player.request(
          'POST',
          '/account/password',
          { currentPassword: password, newPassword },
          201,
        );
        await anonymous.request('POST', '/auth/login', { email: member.email, password }, 401);
        await player.request(
          'DELETE',
          '/account',
          { password: newPassword, confirmation: 'НЕТ' },
          400,
        );
        await player.request('DELETE', '/account', {
          password: newPassword,
          confirmation: 'УДАЛИТЬ',
        });
        assert.equal((await player.request('GET', '/auth/me')).user, null);
      },
    );
  } finally {
    await pool.end();
  }
});
