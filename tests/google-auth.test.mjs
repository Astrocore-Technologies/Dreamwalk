import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:55432/not_used';
const require = createRequire(import.meta.url);
const {
  googleEmailIsAuthoritative,
  verifyGoogleIdToken,
} = require('../apps/api/dist/google-auth.js');
const { tokenHash, Auth } = require('../apps/api/dist/auth.js');
test('Google authority is Gmail or verified Workspace, not any verified third-party address', () => {
  for (const claims of [
    { email: 'user@gmail.com', email_verified: true },
    { email: 'a@work.test', email_verified: true, hd: 'work.test' },
  ])
    assert.equal(googleEmailIsAuthoritative(claims), true);
  for (const claims of [
    { email: 'a@other.test', email_verified: true },
    { email: 'user@gmail.com', email_verified: false },
    { email: 'user@gmail.com', email_verified: 'true' },
  ])
    assert.equal(googleEmailIsAuthoritative(claims), false);
});
test('signed Google token validation rejects wrong audience, issuer, nonce, authorized party and expiry', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey);
  key.kid = 'local-test';
  const resolver = createLocalJWKSet({ keys: [key] });
  const sign = (patch = {}) =>
    new SignJWT({
      sub: 'google-stable-id',
      email: 'test@gmail.com',
      email_verified: true,
      nonce: 'nonce',
      iss: 'https://accounts.google.com',
      aud: 'client',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...patch,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-test' })
      .sign(privateKey);
  assert.equal(
    (await verifyGoogleIdToken(await sign(), 'client', tokenHash('nonce'), resolver)).sub,
    'google-stable-id',
  );
  const validToken = await sign();
  await assert.rejects(
    verifyGoogleIdToken(
      validToken.slice(0, -8) + 'aaaaaaaa',
      'client',
      tokenHash('nonce'),
      resolver,
    ),
  );
  for (const patch of [
    { aud: 'attacker' },
    { aud: ['client', 'other'] },
    { email: undefined },
    { iat: 1 },
    { iss: 'https://attacker.test' },
    { nonce: 'other' },
    { azp: 'attacker' },
    { exp: 1 },
    { sub: '' },
    { email: 'invalid' },
  ])
    await assert.rejects(
      verifyGoogleIdToken(await sign(patch), 'client', tokenHash('nonce'), resolver),
    );
});
test('pending accounts cannot use normal authority, legacy and verified users can', async () => {
  const auth = new Auth({});
  auth.current = async () => ({
    id: 'pending',
    emailVerificationRequired: true,
    emailVerified: false,
  });
  await assert.rejects(auth.require({}), (error) => error.getStatus() === 403);
  assert.equal((await auth.pending({})).id, 'pending');
  assert.equal(await auth.viewer({}), null);
  auth.current = async () => ({
    id: 'legacy',
    emailVerificationRequired: false,
    emailVerified: false,
  });
  assert.equal((await auth.require({})).id, 'legacy');
  assert.equal((await auth.viewer({})).id, 'legacy');
  auth.current = async () => ({
    id: 'verified',
    emailVerificationRequired: true,
    emailVerified: true,
  });
  assert.equal((await auth.require({})).id, 'verified');
});
test('OAuth attempts bind browser, PKCE and nonce and are consumed once before token exchange', async () => {
  const { GoogleAuthController } = require('../apps/api/dist/google-auth.js');
  const { config } = require('../apps/api/dist/config.js');
  const previous = {
    id: config.GOOGLE_CLIENT_ID,
    secret: config.GOOGLE_CLIENT_SECRET,
    fetch: global.fetch,
  };
  config.GOOGLE_CLIENT_ID = 'fixture-client';
  config.GOOGLE_CLIENT_SECRET = 'fixture-secret';
  let stored,
    redirect,
    cookie,
    exchanges = 0;
  const db = {
    query: async (sql, args) => {
      if (sql.startsWith('INSERT')) {
        stored = {
          state_hash: args[0],
          browser_hash: args[1],
          nonce_hash: args[2],
          code_verifier: args[3],
        };
        return [];
      }
      if (sql.includes('RETURNING')) {
        if (stored && stored.state_hash === args[0] && stored.browser_hash === args[1]) {
          const row = stored;
          stored = null;
          return [row];
        }
        return [];
      }
      return [];
    },
  };
  const res = {
    cookie: (name, value) => {
      cookie = `${name}=${value}`;
    },
    clearCookie: () => {},
    redirect: (value) => {
      redirect = value;
    },
  };
  try {
    const controller = new GoogleAuthController(db, {});
    await controller.start(res);
    const url = new URL(redirect);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      url.searchParams.get('code_challenge'),
      Buffer.from(tokenHash(stored.code_verifier), 'hex').toString('base64url'),
    );
    assert.equal(stored.nonce_hash, tokenHash(url.searchParams.get('nonce')));
    global.fetch = async () => {
      exchanges++;
      return new Response('{}', { status: 400 });
    };
    const query = { state: url.searchParams.get('state'), code: 'synthetic-code' };
    await controller.finish(
      { headers: { cookie: 'dreamwalk_oauth=' + 'a'.repeat(64) }, query },
      res,
    );
    assert.equal(exchanges, 0);
    assert.ok(stored);
    await controller.finish({ headers: { cookie }, query }, res);
    assert.equal(exchanges, 1);
    assert.equal(stored, null);
    await controller.finish({ headers: { cookie }, query }, res);
    assert.equal(exchanges, 1);
  } finally {
    config.GOOGLE_CLIENT_ID = previous.id;
    config.GOOGLE_CLIENT_SECRET = previous.secret;
    global.fetch = previous.fetch;
  }
});
