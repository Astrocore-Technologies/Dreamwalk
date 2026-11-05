import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/config_only',
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:3000',
  AI_PROVIDER: 'mock',
  PAID_GENERATION_ENABLED: 'false',
  PAYMENTS_ENABLED: 'false',
  DISCORD_ENABLED: 'false',
  DEV_AUTH_ENABLED: 'false',
  DEMO_FAUCET_ENABLED: 'false',
  GLOBAL_SPEND_CAP: '0',
};
function validates(overrides) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./apps/api/src/config.ts')"],
    {
      cwd: process.cwd(),
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}
test('safe mock startup requires no external keys', () => {
  const result = validates({});
  assert.equal(result.status, 0, result.stderr);
});
for (const flag of ['DEV_AUTH_ENABLED', 'DEMO_FAUCET_ENABLED']) {
  test(`production rejects ${flag}`, () => {
    assert.notEqual(
      validates({ NODE_ENV: 'production', WEB_ORIGIN: 'https://dreamwalk.example', [flag]: 'true' })
        .status,
      0,
    );
  });
}
for (const flag of ['PAID_GENERATION_ENABLED', 'PAYMENTS_ENABLED', 'DISCORD_ENABLED']) {
  test(`platform milestone rejects enabled ${flag}`, () => {
    assert.notEqual(validates({ [flag]: 'true' }).status, 0);
  });
}
for (const provider of ['openai', 'local']) {
  test(`no implicit switch to ${provider} runtime`, () => {
    assert.notEqual(validates({ AI_PROVIDER: provider }).status, 0);
  });
}
test('production requires HTTPS and malformed booleans are not coerced', () => {
  assert.notEqual(validates({ NODE_ENV: 'production' }).status, 0);
  assert.notEqual(validates({ PAYMENTS_ENABLED: 'yes' }).status, 0);
});
test('SMTP requires complete explicit sender and credential configuration', () => {
  assert.notEqual(validates({ SMTP_HOST: '127.0.0.1' }).status, 0);
  assert.notEqual(validates({ SMTP_FROM: 'test@example.test' }).status, 0);
  assert.notEqual(
    validates({ SMTP_HOST: '127.0.0.1', SMTP_FROM: 'test@example.test', SMTP_USER: 'test' }).status,
    0,
  );
  assert.equal(
    validates({ SMTP_HOST: '127.0.0.1', SMTP_FROM: 'test@example.test', SMTP_PORT: '2525' }).status,
    0,
  );
});

test('platform PORT is bounded and explicit API_PORT preserves split local launchers', () => {
  for (const value of ['0', '65536', '-1', 'oops', '']) {
    assert.notEqual(validates({ API_PORT: undefined, PORT: value }).status, 0);
  }
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const { config } = await import('./apps/api/src/config.ts'); if (config.API_PORT !== 4000 || config.API_HOST !== '0.0.0.0') process.exit(1);",
    ],
    {
      cwd: process.cwd(),
      env: { ...env, PORT: '8080', API_PORT: '4000', API_HOST: '0.0.0.0' },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('bind address is explicit and does not accept arbitrary hostnames', () => {
  assert.equal(validates({ API_HOST: '127.0.0.1' }).status, 0);
  assert.equal(validates({ API_HOST: '0.0.0.0' }).status, 0);
  assert.notEqual(validates({ API_HOST: 'untrusted.example' }).status, 0);
});

test('platform-only PORT is used when API_PORT is absent', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const { config } = await import('./apps/api/src/config.ts'); if (config.API_PORT !== 8080) process.exit(1);",
    ],
    {
      cwd: process.cwd(),
      env: { ...env, API_PORT: undefined, PORT: '8080' },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('required trusted ingress cannot boot without a sufficiently strong key', () => {
  assert.notEqual(validates({ DREAMWALK_REQUIRE_INGRESS_SECRET: 'true' }).status, 0);
  assert.notEqual(
    validates({ DREAMWALK_REQUIRE_INGRESS_SECRET: 'true', DREAMWALK_INGRESS_SECRET: 'short' })
      .status,
    0,
  );
  assert.equal(
    validates({
      DREAMWALK_REQUIRE_INGRESS_SECRET: 'true',
      DREAMWALK_INGRESS_SECRET: 'test-only-server-ingress-secret-long-enough',
    }).status,
    0,
  );
});
test('mandatory verification requires delivery and Google credentials are all-or-nothing', () => {
  assert.notEqual(
    validates({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'true', SMTP_HOST: undefined }).status,
    0,
  );
  assert.notEqual(
    validates({ GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: undefined }).status,
    0,
  );
  assert.notEqual(
    validates({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: 'test' }).status,
    0,
  );
});
test('Brevo HTTPS delivery requires both key and sender and excludes ambiguous SMTP', () => {
  assert.notEqual(validates({ BREVO_API_KEY: 'fixture', BREVO_FROM: undefined }).status, 0);
  assert.notEqual(
    validates({ BREVO_FROM: 'sender@example.test', BREVO_API_KEY: undefined }).status,
    0,
  );
  assert.notEqual(
    validates({
      BREVO_API_KEY: 'fixture',
      BREVO_FROM: 'sender@example.test',
      SMTP_HOST: 'localhost',
      SMTP_FROM: 'sender@example.test',
    }).status,
    0,
  );
  assert.equal(
    validates({
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      BREVO_API_KEY: 'fixture',
      BREVO_FROM: 'sender@example.test',
      SMTP_HOST: undefined,
    }).status,
    0,
  );
});

test('API WEB_ORIGIN must be an exact origin rather than a URL or wildcard', () => {
  for (const WEB_ORIGIN of [
    'https://web.example.test/',
    'https://web.example.test/path',
    'https://web.example.test?x=1',
    'https://web.example.test#fragment',
    'https://user:password@web.example.test',
    'https://*.example.test',
  ]) {
    assert.notEqual(validates({ WEB_ORIGIN }).status, 0, WEB_ORIGIN);
  }
  assert.equal(validates({ WEB_ORIGIN: 'https://dreamwalk-rho.vercel.app' }).status, 0);
});
