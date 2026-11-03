import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const { proxy } = require('../apps/web/proxy.ts');
const { canonicalWebOrigin } = require('../apps/web/lib/hosted-origin.ts');
const { socketRelayTarget } = require('../apps/web/lib/game-socket-relay.ts');
const env = {
  VERCEL: '1',
  WEB_ORIGIN: 'https://dreamwalk-rho.vercel.app',
  VERCEL_URL: 'dreamwalk-build-team.vercel.app',
  VERCEL_BRANCH_URL: 'dreamwalk-git-feature-team.vercel.app',
  API_URL: 'https://api.example.test',
  DREAMWALK_INGRESS_SECRET: 'a'.repeat(40),
};
function request(origin, headers = {}) {
  return new NextRequest(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
}
test('preview and canonical mutations normalize only after exact same-origin admission', () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, env);
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    for (const origin of [
      env.WEB_ORIGIN,
      `https://${env.VERCEL_URL}`,
      `https://${env.VERCEL_BRANCH_URL}`,
    ]) {
      const result = proxy(request(origin));
      assert.equal(result.headers.get('x-middleware-request-origin'), env.WEB_ORIGIN);
      assert.equal(
        result.headers.get('x-middleware-request-x-dreamwalk-ingress'),
        env.DREAMWALK_INGRESS_SECRET,
      );
    }
    for (const headers of [
      { origin: 'https://evil.test' },
      { origin: 'null' },
      { origin: '' },
      { origin: env.WEB_ORIGIN },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'evil.test' },
    ]) {
      const result = proxy(request(`https://${env.VERCEL_URL}`, headers));
      assert.equal(result.status, 403);
      assert.equal(result.headers.get('x-middleware-request-x-dreamwalk-ingress'), null);
    }
    const missing = request(`https://${env.VERCEL_URL}`);
    missing.headers.delete('origin');
    assert.equal(proxy(missing).status, 403);
    assert.equal(proxy(request('https://unrelated.vercel.app')).status, 403);
    assert.equal(proxy(request('http://dreamwalk-build-team.vercel.app')).status, 403);
    const spoof = request('https://evil.test', {
      'x-forwarded-host': env.VERCEL_URL,
      'x-forwarded-proto': 'https',
      host: env.VERCEL_URL,
    });
    assert.equal(proxy(spoof).status, 403);
    delete process.env.WEB_ORIGIN;
    assert.equal(proxy(request(`https://${env.VERCEL_URL}`)).status, 503);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
test('socket preview admission preserves canonical upstream, session and fixed destination', () => {
  const origin = `https://${env.VERCEL_URL}`;
  const req = new Request(
    origin + '/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
    { headers: { origin, cookie: `dreamwalk_session=${'b'.repeat(64)}` } },
  );
  const target = socketRelayTarget(req, env);
  assert.equal(target.headers.origin, env.WEB_ORIGIN);
  assert.equal(target.headers['x-dreamwalk-ingress'], env.DREAMWALK_INGRESS_SECRET);
  req.headers.set('origin', 'https://evil.test');
  assert.throws(() => socketRelayTarget(req, env));
  req.headers.set('origin', origin);
  req.headers.delete('cookie');
  assert.throws(() => socketRelayTarget(req, env));
});

test('socket relay preserves only supported output locales on canonical and preview origins', () => {
  const campaignId = '12345678-1234-1234-1234-123456789012';
  for (const origin of [
    env.WEB_ORIGIN,
    `https://${env.VERCEL_URL}`,
    `https://${env.VERCEL_BRANCH_URL}`,
  ]) {
    for (const locale of ['uk', 'en', 'ru']) {
      const req = new Request(
        `${origin}/api/v1/game/socket?campaignId=${campaignId}&locale=${locale}&url=https://evil.test&token=ignored`,
        { headers: { origin, cookie: `dreamwalk_session=${'b'.repeat(64)}` } },
      );
      const target = socketRelayTarget(req, env);
      assert.equal(
        target.url,
        `wss://api.example.test/api/v1/game/socket?campaignId=${campaignId}&locale=${locale}`,
      );
      assert.deepEqual(Object.keys(target.headers).sort(), [
        'cookie',
        'origin',
        'x-dreamwalk-ingress',
      ]);
      assert.equal(target.headers.origin, env.WEB_ORIGIN);
      req.headers.set('origin', 'https://evil.test');
      assert.throws(() => socketRelayTarget(req, env));
      req.headers.set('origin', origin);
      req.headers.delete('cookie');
      assert.throws(() => socketRelayTarget(req, env));
    }
  }
});

test('missing or unsupported socket locale keeps the existing account-language fallback', () => {
  const campaignId = '12345678-1234-1234-1234-123456789012';
  const origin = `https://${env.VERCEL_URL}`;
  for (const locale of [undefined, '', 'fr', 'RU', 'en-US', 'ru\r\nx-test: unsafe']) {
    const url = new URL(`${origin}/api/v1/game/socket?campaignId=${campaignId}`);
    if (locale !== undefined) url.searchParams.set('locale', locale);
    const target = socketRelayTarget(
      new Request(url, {
        headers: { origin, cookie: `dreamwalk_session=${'b'.repeat(64)}` },
      }),
      env,
    );
    assert.equal(target.url, `wss://api.example.test/api/v1/game/socket?campaignId=${campaignId}`);
  }
});

test('platform production origin wins over stale manual origin and fails closed when malformed', () => {
  const platform = {
    ...env,
    WEB_ORIGIN: 'https://obsolete.example',
    VERCEL_PROJECT_PRODUCTION_URL: 'dreamwalk-rho.vercel.app',
  };
  assert.equal(canonicalWebOrigin(platform), 'https://dreamwalk-rho.vercel.app');
  assert.equal(
    canonicalWebOrigin({ ...platform, VERCEL_PROJECT_PRODUCTION_URL: 'play.example.com' }),
    'https://play.example.com',
  );
  for (const value of [
    '',
    'https://evil.test',
    'evil.test/path',
    'u:p@evil.test',
    'evil.test:443',
    'evil.test?x=1',
    'evil.test#fragment',
    'evil..test',
    '-evil.test',
    '*.vercel.app',
    'evil.test\n',
  ])
    assert.equal(canonicalWebOrigin({ ...platform, VERCEL_PROJECT_PRODUCTION_URL: value }), null);
  const preview = `https://${env.VERCEL_URL}`;
  const req = new Request(
    preview + '/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
    { headers: { origin: preview, cookie: `dreamwalk_session=${'b'.repeat(64)}` } },
  );
  assert.equal(socketRelayTarget(req, platform).headers.origin, 'https://dreamwalk-rho.vercel.app');
});
