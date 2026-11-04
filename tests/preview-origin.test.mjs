import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const { proxy } = require('../apps/web/proxy.ts');
const {
  canonicalWebOrigin,
  trustedBrowserOrigin,
  ENFORCE_BROWSER_ORIGIN,
} = require('../apps/web/lib/hosted-origin.ts');
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
test('temporary web and API policy pauses only origin enforcement without changing trusted ingress', () => {
  const { ENFORCE_BROWSER_ORIGIN: apiPolicy } = require('../apps/api/src/ingress.ts');
  assert.equal(ENFORCE_BROWSER_ORIGIN, false);
  assert.equal(apiPolicy, false);
  const old = { ...process.env };
  try {
    Object.assign(process.env, env, { VERCEL_PROJECT_PRODUCTION_URL: 'play.example.com' });
    delete process.env.API_WEB_ORIGIN;
    for (const origin of [env.WEB_ORIGIN, `https://${env.VERCEL_URL}`, 'https://other.example']) {
      for (const browserOrigin of [origin, 'https://foreign.example', 'null', undefined]) {
        const req = request(origin, {
          'sec-fetch-site': 'cross-site',
          'x-dreamwalk-ingress': 'spoof',
        });
        if (browserOrigin === undefined) req.headers.delete('origin');
        else req.headers.set('origin', browserOrigin);
        const result = proxy(req);
        assert.equal(
          result.headers.get('x-middleware-rewrite'),
          'https://api.example.test/api/v1/auth/login',
        );
        assert.equal(
          result.headers.get('x-middleware-request-x-dreamwalk-ingress'),
          env.DREAMWALK_INGRESS_SECRET,
        );
        assert.equal(result.headers.get('x-middleware-request-origin'), 'https://play.example.com');
        const socketRequest = new Request(
          origin + '/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
          {
            headers: {
              ...Object.fromEntries(req.headers),
              cookie: `dreamwalk_session=${'b'.repeat(64)}`,
            },
          },
        );
        const socket = socketRelayTarget(socketRequest, process.env);
        assert.equal(
          socket.url,
          'wss://api.example.test/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
        );
        assert.equal(socket.headers['x-dreamwalk-ingress'], env.DREAMWALK_INGRESS_SECRET);
        socketRequest.headers.delete('cookie');
        assert.throws(() => socketRelayTarget(socketRequest, process.env), /RELAY_SESSION/);
      }
    }
    delete process.env.DREAMWALK_INGRESS_SECRET;
    assert.equal(proxy(request(env.WEB_ORIGIN)).status, 503);
    assert.throws(
      () => socketRelayTarget(new Request(env.WEB_ORIGIN), process.env),
      /RELAY_CONFIG/,
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
test('preserved strict helper validates exact preview and canonical origins for later re-enable', () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, env);
    delete process.env.API_WEB_ORIGIN;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    for (const origin of [
      env.WEB_ORIGIN,
      `https://${env.VERCEL_URL}`,
      `https://${env.VERCEL_BRANCH_URL}`,
    ]) {
      assert.equal(trustedBrowserOrigin(request(origin), process.env), true);
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
      assert.equal(
        trustedBrowserOrigin(request(`https://${env.VERCEL_URL}`, headers), process.env),
        false,
      );
    }
    const missing = request(`https://${env.VERCEL_URL}`);
    missing.headers.delete('origin');
    assert.equal(trustedBrowserOrigin(missing, process.env), false);
    assert.equal(trustedBrowserOrigin(request('https://unrelated.vercel.app'), process.env), false);
    assert.equal(
      trustedBrowserOrigin(request('http://dreamwalk-build-team.vercel.app'), process.env),
      false,
    );
    const spoof = request('https://evil.test', {
      'x-forwarded-host': env.VERCEL_URL,
      'x-forwarded-proto': 'https',
      host: env.VERCEL_URL,
    });
    assert.equal(trustedBrowserOrigin(spoof, process.env), false);
    delete process.env.WEB_ORIGIN;
    assert.equal(trustedBrowserOrigin(request(`https://${env.VERCEL_URL}`), process.env), false);
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
  assert.equal(trustedBrowserOrigin(req, env), false);
  assert.equal(socketRelayTarget(req, env).headers.origin, env.WEB_ORIGIN);
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
      assert.equal(trustedBrowserOrigin(req, env), false);
      assert.equal(socketRelayTarget(req, env).headers.origin, env.WEB_ORIGIN);
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

test('explicit API origin stays stable when Vercel selects a custom production domain', () => {
  const configured = {
    ...env,
    API_WEB_ORIGIN: env.WEB_ORIGIN,
    WEB_ORIGIN: 'https://obsolete.example',
    VERCEL_PROJECT_PRODUCTION_URL: 'play.example.com',
  };
  const old = { ...process.env };
  try {
    Object.assign(process.env, configured);
    const browserOrigins = [
      configured.API_WEB_ORIGIN,
      `https://${configured.VERCEL_PROJECT_PRODUCTION_URL}`,
      `https://${configured.VERCEL_URL}`,
      `https://${configured.VERCEL_BRANCH_URL}`,
    ];
    assert.equal(canonicalWebOrigin(configured), env.WEB_ORIGIN);
    for (const origin of browserOrigins) {
      assert.equal(trustedBrowserOrigin(request(origin), configured), true);
      const result = proxy(
        request(origin, { host: new URL(origin).host, 'sec-fetch-site': 'same-origin' }),
      );
      assert.equal(result.headers.get('x-middleware-request-origin'), configured.API_WEB_ORIGIN);
      assert.equal(
        result.headers.get('x-middleware-request-x-dreamwalk-ingress'),
        env.DREAMWALK_INGRESS_SECRET,
      );
      assert.equal(
        result.headers.get('x-middleware-rewrite'),
        'https://api.example.test/api/v1/auth/login',
      );
      const socket = socketRelayTarget(
        new Request(
          origin + '/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
          {
            headers: {
              origin,
              host: new URL(origin).host,
              'sec-fetch-site': 'same-origin',
              cookie: `dreamwalk_session=${'b'.repeat(64)}`,
            },
          },
        ),
        configured,
      );
      assert.equal(socket.headers.origin, configured.API_WEB_ORIGIN);
    }
    for (const origin of [
      'https://obsolete.example',
      'https://unrelated.vercel.app',
      'https://evil.test',
    ]) {
      assert.equal(trustedBrowserOrigin(request(origin), configured), false);
    }
    const custom = `https://${configured.VERCEL_PROJECT_PRODUCTION_URL}`;
    for (const headers of [
      { origin: configured.API_WEB_ORIGIN },
      { origin: 'https://evil.test' },
      { origin: 'null' },
      { origin: '' },
      { host: 'evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      assert.equal(trustedBrowserOrigin(request(custom, headers), configured), false);
      assert.equal(
        trustedBrowserOrigin(
          new Request(
            custom + '/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
            {
              headers: {
                origin: custom,
                cookie: `dreamwalk_session=${'b'.repeat(64)}`,
                ...headers,
              },
            },
          ),
          configured,
        ),
        false,
      );
    }
    const missingOrigin = request(custom);
    missingOrigin.headers.delete('origin');
    assert.equal(trustedBrowserOrigin(missingOrigin, configured), false);
    assert.equal(
      trustedBrowserOrigin(
        request('https://evil.test', {
          'x-forwarded-host': configured.VERCEL_PROJECT_PRODUCTION_URL,
          'x-forwarded-proto': 'https',
        }),
        configured,
      ),
      false,
    );
    // Selecting another verified production domain must not alter the backend hop.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'next.example.com';
    assert.equal(
      proxy(request('https://next.example.com')).headers.get('x-middleware-request-origin'),
      configured.API_WEB_ORIGIN,
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test('malformed API origins remain invalid and are never forwarded while enforcement is paused', () => {
  const configured = { ...env, VERCEL_PROJECT_PRODUCTION_URL: 'play.example.com' };
  const old = { ...process.env };
  try {
    Object.assign(process.env, configured);
    for (const value of [
      '',
      'http://web.example.test',
      'null',
      'https://web.example.test/',
      'https://u:p@web.example.test',
      'https://web.example.test/path',
      'https://web.example.test?x=1',
      'https://web.example.test#x',
      'https://web.example.test\n',
      'https://*.vercel.app',
    ]) {
      process.env.API_WEB_ORIGIN = value;
      const bad = { ...configured, API_WEB_ORIGIN: value };
      assert.equal(canonicalWebOrigin(bad), null, value);
      assert.equal(
        proxy(request('https://play.example.com')).headers.get('x-middleware-request-origin'),
        null,
        value,
      );
      assert.equal(
        socketRelayTarget(
          new Request(
            'https://play.example.com/api/v1/game/socket?campaignId=12345678-1234-1234-1234-123456789012',
            {
              headers: {
                origin: 'https://play.example.com',
                cookie: `dreamwalk_session=${'b'.repeat(64)}`,
              },
            },
          ),
          bad,
        ).headers.origin,
        undefined,
      );
    }
    process.env.API_WEB_ORIGIN = env.WEB_ORIGIN;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'evil.test/path';
    assert.equal(trustedBrowserOrigin(request(env.WEB_ORIGIN), process.env), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
