import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localPreviewAdminEnabled,
  localPreviewLogin,
} from '../apps/api/src/local-preview-admin.ts';
import { loginSchema, registerSchema } from '@dreamwalk/contracts';
import { localAuthMessages } from '../apps/web/components/local-auth-messages.ts';
const settings = { NODE_ENV: 'development', WEB_ORIGIN: 'http://127.0.0.1:3010' };
const enabled = { LOCAL_PREVIEW_TEST_ADMIN_ENABLED: 'true' };
function request(overrides = {}) {
  return {
    headers: { host: '127.0.0.1:4000', origin: settings.WEB_ORIGIN },
    socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}
test('local admin alias requires explicit flag, development and loopback on both sides', () => {
  assert.equal(localPreviewAdminEnabled(request(), settings, enabled), true);
  for (const value of [undefined, 'false', '1', 'TRUE'])
    assert.equal(
      localPreviewAdminEnabled(request(), settings, { LOCAL_PREVIEW_TEST_ADMIN_ENABLED: value }),
      false,
    );
  assert.equal(
    localPreviewAdminEnabled(request(), { ...settings, NODE_ENV: 'production' }, enabled),
    false,
  );
  assert.equal(
    localPreviewAdminEnabled(
      request(),
      { ...settings, WEB_ORIGIN: 'http://public.example' },
      enabled,
    ),
    false,
  );
  for (const socket of [
    { localAddress: '0.0.0.0', remoteAddress: '127.0.0.1' },
    { localAddress: '127.0.0.1', remoteAddress: '192.168.1.4' },
    {},
  ])
    assert.equal(localPreviewAdminEnabled(request({ socket }), settings, enabled), false);
});
test('local alias rejects public host, forwarded host, foreign origin and malformed headers', () => {
  for (const headers of [
    { host: 'public.example' },
    { host: '127.0.0.1:4000', 'x-forwarded-host': 'public.example' },
    { host: '127.0.0.1:4000', 'x-forwarded-host': ['127.0.0.1:3010'] },
    { host: '127.0.0.1:4000', origin: 'https://evil.example' },
    { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:9999' },
    { host: 'user@127.0.0.1:4000' },
    {},
  ])
    assert.equal(localPreviewAdminEnabled(request({ headers }), settings, enabled), false);
  assert.equal(
    localPreviewAdminEnabled(
      request({ headers: { host: '127.0.0.1:4000', 'x-forwarded-host': '127.0.0.1:3010' } }),
      settings,
      enabled,
    ),
    true,
  );
});
test('only exact local alias is parsed, never normal email or permissive password fallback', () => {
  const body = { email: 'admin', password: 'short' };
  assert.equal(localPreviewLogin(body, false), null);
  assert.equal(localPreviewLogin({ email: 'other', password: 'short' }, true), null);
  assert.equal(localPreviewLogin({ email: 'person@example.test', password: 'short' }, true), null);
  assert.equal(localPreviewLogin(null, true), null);
  assert.deepEqual(localPreviewLogin(body, true), {
    email: 'local-preview-admin@dreamwalk.test',
    password: 'short',
  });
  for (const value of ['', 'a'.repeat(129), 12])
    assert.throws(() => localPreviewLogin({ email: 'admin', password: value }, true));
  assert.throws(() => localPreviewLogin({ ...body, role: 'admin' }, true));
});
test('public signup and email login keep their existing minimum password policy', () => {
  assert.equal(
    loginSchema.safeParse({ email: 'person@example.test', password: 'short' }).success,
    false,
  );
  assert.equal(
    loginSchema.safeParse({ email: 'admin', password: 'long-enough-password' }).success,
    false,
  );
  assert.equal(
    registerSchema.safeParse({
      email: 'person@example.test',
      password: 'short',
      name: 'Person',
      handle: 'person',
    }).success,
    false,
  );
  assert.equal(
    loginSchema.safeParse({ email: 'person@example.test', password: 'long-enough-password' })
      .success,
    true,
  );
});
test('local sign-in labels are complete for Ukrainian, English and Russian', () => {
  assert.deepEqual(Object.keys(localAuthMessages).sort(), ['en', 'ru', 'uk']);
  for (const text of Object.values(localAuthMessages))
    for (const value of Object.values(text)) assert.ok(value.length > 5);
});
