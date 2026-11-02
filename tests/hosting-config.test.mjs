import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
function load(overrides) {
  const env = { ...process.env, VERCEL: '1', API_URL: '', ...overrides };
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const {default: loaded} = await import('./apps/web/next.config.ts'); const c = loaded.default ?? loaded; console.log(JSON.stringify(await c.rewrites()));",
    ],
    { env, encoding: 'utf8', timeout: 15000 },
  );
}
test('Vercel routing requires explicit HTTPS upstream origin without embedded secrets or paths', () => {
  for (const API_URL of [
    '',
    'http://example.test',
    'https://u:p@example.test',
    'https://example.test/path',
    'https://example.test?secret=a',
  ])
    assert.notEqual(load({ API_URL }).status, 0, API_URL);
  const result = load({ API_URL: 'https://api.example.test/' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []); // Hosted routing injects a server-only ingress key.
});
test('Railway starts a single persistent API and migrates compiled code without seeding', () => {
  const config = JSON.parse(readFileSync('infra/railway-service-settings.json', 'utf8'));
  assert.equal(config.deploy.numReplicas, 1);
  assert.equal(config.deploy.startCommand, 'npm run start:api');
  assert.deepEqual(config.deploy.preDeployCommand, ['npm run db:migrate:production']);
  assert.equal(config.deploy.healthcheckPath, '/api/v1/health');
});
