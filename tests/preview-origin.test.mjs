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
const canonical = 'https://dreamwalk-rho.vercel.app';
const origins = ['https://www.dreamwalk.online', 'https://dreamwalk.online', canonical];
const env = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  API_WEB_ORIGIN: canonical,
  WEB_ALLOWED_ORIGINS: origins.join(','),
  VERCEL_URL: 'dreamwalk-build-team.vercel.app',
  VERCEL_BRANCH_URL: 'dreamwalk-git-feature-team.vercel.app',
  API_URL: 'https://api.example.test',
  DREAMWALK_INGRESS_SECRET: 'a'.repeat(40),
};
const campaignId = '12345678-1234-1234-1234-123456789012';
function request(origin, headers = {}, socket = false) {
  return new NextRequest(
    origin + (socket ? `/api/v1/game/socket?campaignId=${campaignId}` : '/api/v1/auth/login'),
    {
      method: socket ? 'GET' : 'POST',
      headers: {
        origin,
        host: new URL(origin).host,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: `dreamwalk_session=${'b'.repeat(64)}`,
        ...headers,
      },
    },
  );
}
function withEnv(config, fn) {
  const old = { ...process.env };
  try {
    for (const key of [
      'API_WEB_ORIGIN',
      'WEB_ORIGIN',
      'WEB_ALLOWED_ORIGINS',
      'VERCEL_PROJECT_PRODUCTION_URL',
      'VERCEL_URL',
      'VERCEL_BRANCH_URL',
    ])
      delete process.env[key];
    Object.assign(process.env, config);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
}
function accepted(origin, config = env) {
  withEnv(config, () => {
    assert.equal(trustedBrowserOrigin(request(origin), config), true);
    const result = proxy(request(origin, { 'x-dreamwalk-ingress': 'spoof' }));
    assert.equal(
      result.headers.get('x-middleware-rewrite'),
      'https://api.example.test/api/v1/auth/login',
    );
    assert.equal(result.headers.get('x-middleware-request-origin'), canonical);
    assert.equal(
      result.headers.get('x-middleware-request-x-dreamwalk-ingress'),
      env.DREAMWALK_INGRESS_SECRET,
    );
    assert.equal(result.headers.get('x-dreamwalk-ingress'), null);
    const target = socketRelayTarget(request(origin, {}, true), config);
    assert.equal(target.headers.origin, canonical);
    assert.equal(target.headers['x-dreamwalk-ingress'], env.DREAMWALK_INGRESS_SECRET);
    assert.equal(target.url, `wss://api.example.test/api/v1/game/socket?campaignId=${campaignId}`);
  });
}
function rejected(origin, headers = {}, config = env) {
  withEnv(config, () => {
    const req = request(origin, headers);
    const ws = request(origin, headers, true);
    if (headers.origin === undefined && Object.hasOwn(headers, 'origin')) {
      req.headers.delete('origin');
      ws.headers.delete('origin');
    }
    assert.equal(trustedBrowserOrigin(req, config), false);
    assert.equal(proxy(req).status, 403);
    assert.throws(() => socketRelayTarget(ws, config), /RELAY_ORIGIN/);
  });
}
test('web and API enforce browser origin while retaining trusted ingress', () => {
  assert.equal(ENFORCE_BROWSER_ORIGIN, true);
  assert.equal(require('../apps/api/src/ingress.ts').ENFORCE_BROWSER_ORIGIN, true);
  for (const origin of origins) accepted(origin);
});
test('only preview deployments admit their exact deployment and branch URLs', () => {
  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
    rejected(`https://${host}`);
    accepted(`https://${host}`, { ...env, VERCEL_ENV: 'preview' });
  }
  for (const mode of ['preview', 'production']) {
    for (const host of [
      'unrelated.vercel.app',
      'dreamwalk-other-team.vercel.app',
      'dreamwalk-build-team.vercel.app.evil.test',
    ])
      rejected(`https://${host}`, {}, { ...env, VERCEL_ENV: mode });
  }
});
test('HTTP and WS reject missing, null, foreign, cross-origin and forged admission headers', () => {
  for (const origin of origins) {
    for (const headers of [
      { origin: undefined },
      { origin: '' },
      { origin: 'null' },
      { origin: 'https://evil.test' },
      { host: 'evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
    ])
      rejected(origin, headers);
  }
  rejected(origins[0], { origin: canonical });
  rejected('https://evil.test', {
    'x-forwarded-host': 'www.dreamwalk.online',
    'x-forwarded-proto': 'https',
    forwarded: 'host=www.dreamwalk.online;proto=https',
  });
  rejected('http://www.dreamwalk.online');
  withEnv(env, () => {
    const req = request(origins[0]);
    req.headers.delete('host');
    req.headers.delete('sec-fetch-site');
    assert.equal(trustedBrowserOrigin(req, env), true);
  });
});
test('mutable platform production domain never changes trust or implicitly admits aliases', () => {
  for (const value of ['new.example.com', 'evil.test/path', '', 'www.dreamwalk.online']) {
    const config = {
      ...env,
      WEB_ORIGIN: 'https://obsolete.example',
      VERCEL_PROJECT_PRODUCTION_URL: value,
    };
    assert.equal(canonicalWebOrigin(config), canonical);
    for (const origin of origins) accepted(origin, config);
    rejected('https://new.example.com', {}, config);
  }
});
test('Vercel requires explicit valid canonical configuration without any fallback', () => {
  const badValues = [
    undefined,
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
  ];
  for (const value of badValues) {
    const config = {
      ...env,
      WEB_ORIGIN: canonical,
      VERCEL_PROJECT_PRODUCTION_URL: 'dreamwalk-rho.vercel.app',
    };
    if (value === undefined) delete config.API_WEB_ORIGIN;
    else config.API_WEB_ORIGIN = value;
    withEnv(config, () => {
      assert.equal(canonicalWebOrigin(config), null, String(value));
      assert.equal(trustedBrowserOrigin(request(origins[0]), config), false);
      assert.equal(proxy(request(origins[0])).status, 503);
      assert.throws(() => socketRelayTarget(request(origins[0], {}, true), config), /RELAY_CONFIG/);
    });
  }
  assert.equal(canonicalWebOrigin({ WEB_ORIGIN: canonical }), canonical);
});
test('missing, empty, malformed and oversized browser allowlists fail closed', () => {
  for (const value of [
    undefined,
    '',
    ',',
    ' '.repeat(4097) + canonical,
    `${canonical},`,
    `${canonical},http://bad.test`,
    `${canonical},https://*.vercel.app`,
    `${canonical},https://u:p@bad.test`,
    `${canonical},https://bad.test/path`,
    Array.from({ length: 17 }, (_, i) => `https://host${i}.test`).join(','),
  ]) {
    const config = { ...env };
    if (value === undefined) delete config.WEB_ALLOWED_ORIGINS;
    else config.WEB_ALLOWED_ORIGINS = value;
    withEnv(config, () => {
      assert.equal(trustedBrowserOrigin(request(canonical), config), false, String(value));
      assert.ok([403, 503].includes(proxy(request(canonical)).status));
      assert.throws(() => socketRelayTarget(request(canonical, {}, true), config));
    });
  }
});
test('admitted sockets retain bounded locales, fixed target, session and ingress requirements', () => {
  for (const origin of origins) {
    for (const locale of ['uk', 'en', 'ru', '', 'fr', 'RU', 'en-US']) {
      const req = new Request(
        `${origin}/api/v1/game/socket?campaignId=${campaignId}&locale=${locale}&url=https://evil.test&token=ignored`,
        { headers: Object.fromEntries(request(origin, {}, true).headers) },
      );
      const target = socketRelayTarget(req, env);
      assert.equal(
        target.url,
        `wss://api.example.test/api/v1/game/socket?campaignId=${campaignId}${['uk', 'en', 'ru'].includes(locale) ? `&locale=${locale}` : ''}`,
      );
      assert.deepEqual(Object.keys(target.headers).sort(), [
        'cookie',
        'origin',
        'x-dreamwalk-ingress',
      ]);
      req.headers.delete('cookie');
      assert.throws(() => socketRelayTarget(req, env), /RELAY_SESSION/);
    }
  }
  const config = { ...env };
  delete config.DREAMWALK_INGRESS_SECRET;
  withEnv(config, () => {
    delete process.env.DREAMWALK_INGRESS_SECRET;
    assert.equal(proxy(request(canonical)).status, 503);
    assert.throws(() => socketRelayTarget(request(canonical, {}, true), config), /RELAY_CONFIG/);
  });
});

test('backend canonical origin is not an implicit browser alias', () => {
  const config = { ...env, WEB_ALLOWED_ORIGINS: origins[0] };
  accepted(origins[0], config);
  rejected(canonical, {}, config);
});
test('malformed preview platform host fails closed instead of widening trust', () => {
  for (const host of [
    '*.vercel.app',
    'evil.test',
    'https://build.vercel.app',
    'build.vercel.app/path',
    '-bad.vercel.app',
    'a..vercel.app',
  ]) {
    const config = { ...env, VERCEL_ENV: 'preview', VERCEL_URL: host };
    rejected(canonical, {}, config);
  }
});
