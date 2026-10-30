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
