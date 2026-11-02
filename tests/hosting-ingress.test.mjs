import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ingressAllowed } = require('../apps/api/src/ingress.ts');
const { proxy } = require('../apps/web/proxy.ts');
const { NextRequest } = require('next/server');
const secret = 'fixture-only-ingress-value-not-a-real-secret';
test('ingress is fail closed when required, exact, non-array and independent of session', () => {
  assert.equal(ingressAllowed(undefined, undefined, true), false);
  assert.equal(ingressAllowed(undefined, undefined, false), true);
  assert.equal(ingressAllowed(secret, secret, true), true);
  for (const value of [undefined, '', secret + 'x', [secret]])
    assert.equal(ingressAllowed(value, secret, true), false);
});
test('hosted HTTP proxy overwrites ingress header and keeps secrets request-only', () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      VERCEL: '1',
      API_URL: 'https://api.example.test',
      DREAMWALK_INGRESS_SECRET: secret,
    });
    const response = proxy(
      new NextRequest(
        'https://web.example.test/api/v1/auth/me?x=1&_vercel_share=synthetic-share-one&x=2&x-vercel-protection-bypass=synthetic-url-secret&x-vercel-set-bypass-cookie=true&_vercel_share=synthetic-share-two',
        {
          headers: {
            cookie: 'dreamwalk_session=fixture; platform_protection=must-not-forward',
            origin: 'https://web.example.test',
            'x-dreamwalk-ingress': 'attacker',
            'x-vercel-protection-bypass': 'synthetic-protection-secret',
            'x-vercel-trusted-oidc-idp-token': 'synthetic-identity-secret',
            'x-vercel-oidc-token': 'synthetic-runtime-identity-secret',
            'x-vercel-set-bypass-cookie': 'true',
            'content-type': 'application/json',
          },
        },
      ),
    );
    assert.equal(
      response.headers.get('x-middleware-rewrite'),
      'https://api.example.test/api/v1/auth/me?x=1&x=2',
    );
    assert.equal(response.headers.get('x-middleware-request-x-dreamwalk-ingress'), secret);
    assert.equal(response.headers.get('x-dreamwalk-ingress'), null);
    assert.equal(response.headers.get('x-middleware-request-cookie'), 'dreamwalk_session=fixture');
    assert.equal(response.headers.get('x-middleware-request-origin'), 'https://web.example.test');
    assert.equal(response.headers.get('x-middleware-request-content-type'), 'application/json');
    for (const name of [
      'x-vercel-protection-bypass',
      'x-vercel-trusted-oidc-idp-token',
      'x-vercel-oidc-token',
      'x-vercel-set-bypass-cookie',
    ]) {
      assert.equal(response.headers.get(`x-middleware-request-${name}`), null);
      assert.ok(
        !(response.headers.get('x-middleware-override-headers') ?? '').split(',').includes(name),
      );
      assert.equal(response.headers.get(name), null);
    }
    assert.equal(response.headers.get('x-vercel-enable-rewrite-caching'), '0');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    delete process.env.DREAMWALK_INGRESS_SECRET;
    assert.equal(proxy(new NextRequest('https://web.example.test/api/v1/auth/me')).status, 503);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test('OAuth cookie is forwarded only to its exact Google endpoint scope', () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      VERCEL: '1',
      API_URL: 'https://api.example.test',
      DREAMWALK_INGRESS_SECRET: secret,
    });
    for (const path of ['/api/v1/auth/google/callback', '/api/v1/auth/me']) {
      const result = proxy(
        new NextRequest('https://web.example.test' + path, {
          headers: { cookie: 'dreamwalk_session=s; dreamwalk_oauth=o; other=x' },
        }),
      );
      assert.equal(
        result.headers.get('x-middleware-request-cookie'),
        path.includes('/google/')
          ? 'dreamwalk_session=s; dreamwalk_oauth=o'
          : 'dreamwalk_session=s',
      );
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
