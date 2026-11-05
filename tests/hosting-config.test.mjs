import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { partitionBrowserFiles } from '../scripts/browser-shard.mjs';
import { webEnvironment } from '../scripts/server-environment.mjs';
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
test('release startup activates only after listen and health stays unready until commit', () => {
  const main = readFileSync('apps/api/src/main.ts', 'utf8');
  const migration = readFileSync('apps/api/src/migrate.ts', 'utf8');
  assert.match(main, /if \(!releaseReadiness\.ready\)[\s\S]*?fail\(503/);
  assert.ok(main.indexOf('await app.listen(') < main.indexOf('await releaseReadiness.activate('));
  assert.match(main, /activateRegisteredReleaseDeployment\([\s\S]*?RAILWAY_DEPLOYMENT_ID/);
  assert.match(main, /catch \(error\) \{\s*await app.close\(\);\s*throw error;/);
  assert.doesNotMatch(main, /registerReleaseDeployment\(/);
  assert.match(migration, /registerReleaseDeployment\(/);
  assert.doesNotMatch(migration, /activateRegisteredReleaseDeployment\(/);
});

test('browser partitions preserve every test file exactly once and balance long game journeys', () => {
  const files = readdirSync('tests/e2e', { recursive: true }).filter((file) =>
    file.endsWith('.spec.ts'),
  );
  const groups = partitionBrowserFiles(files, 3);
  assert.deepEqual(groups.flatMap((group) => group.files).sort(), [...files].sort());
  assert.deepEqual(partitionBrowserFiles([...files].reverse(), 3), groups);
  assert.notEqual(
    groups.findIndex((group) => group.files.includes('game-adventure-completion.spec.ts')),
    groups.findIndex((group) => group.files.includes('game-director.spec.ts')),
  );
  assert.notEqual(
    groups.findIndex((group) => group.files.includes('game-area-speech.spec.ts')),
    groups.findIndex((group) => group.files.includes('game-chat-layout.spec.ts')),
    'measured area-speech and chat locale matrices must not overload one runner',
  );
  assert.equal(groups.length, 3);
  assert.ok(
    Math.max(...groups.map((g) => g.seconds)) - Math.min(...groups.map((g) => g.seconds)) <= 60,
  );
  assert.throws(() => partitionBrowserFiles(['same', 'same']));
  const workflow = readFileSync('.github/workflows/platform.yml', 'utf8');
  for (const index of [1, 2, 3])
    assert.ok(workflow.includes(`node scripts/browser-shard.mjs ${index}/3`));
  assert.equal((workflow.match(/runner.temp \}\}\/dreamwalk-web.log/g) ?? []).length, 3);
});

test('all browser shards retain isolation, bounded jobs and an all-success aggregate', () => {
  const workflow = readFileSync('.github/workflows/platform.yml', 'utf8');
  for (const index of [1, 2, 3]) {
    const block = workflow
      .split(`  browser_${index}:\n`)[1]
      .split(/\n {2}(?:browser_\d|platform):/)[0];
    assert.match(block, /timeout-minutes: 20/);
    assert.match(block, /runs-on: ubuntu-latest/);
    assert.match(block, /postgres:17\.10-alpine/);
    assert.equal((block.match(new RegExp(`browser-${index}-ephemeral`, 'g')) ?? []).length, 2);
    assert.ok(block.includes(`dreamwalk-browser-${index}-assets`));
    assert.ok(block.includes(`node scripts/browser-shard.mjs ${index}/3`));
    assert.doesNotMatch(block, /continue-on-error|--grep|--max-failures/);
  }
  const gate = workflow.split('  platform:\n')[1];
  assert.match(gate, /needs: \[static, integration, browser_1, browser_2, browser_3\]/);
  assert.ok(gate.includes("['static', 'integration', 'browser_1', 'browser_2', 'browser_3']"));
  assert.ok(gate.includes("results[name]?.result !== 'success'"));
  assert.match(gate, /Object\.keys\(results\)\.length !== expected\.length/);
  assert.match(gate, /process\.exit\(1\)/);
});

test('prebuilt browser CI keeps all three complete shards and the API test environment', () => {
  const workflow = readFileSync('.github/workflows/platform.yml', 'utf8');
  const launcher = readFileSync('scripts/dev.mjs', 'utf8');
  assert.equal((workflow.match(/NODE_ENV=production npm run build:web/g) ?? []).length, 3);
  assert.equal(
    (workflow.match(/NODE_ENV=development npm run dev -- --prebuilt-web/g) ?? []).length,
    3,
  );
  assert.match(launcher, /prebuiltWeb \? 'start' : 'dev'/);
  assert.match(
    launcher,
    /env: webEnvironment\(prebuiltWeb \? \{ \.\.\.process.env, NODE_ENV: 'production' \} : process.env\)/,
  );
  const input = {
    NODE_ENV: 'development',
    DATABASE_URL: 'synthetic-private-database',
    NPC_AI_API_KEY: 'synthetic-private-key',
    API_URL: 'http://127.0.0.1:4000',
  };
  assert.deepEqual(webEnvironment({ ...input, NODE_ENV: 'production' }), {
    NODE_ENV: 'production',
    API_URL: input.API_URL,
  });
  assert.equal(input.NODE_ENV, 'development');
});

test('prebuilt browser launch rejects absent output before opening a database', () => {
  const result = spawnSync(process.execPath, ['scripts/dev.mjs', '--prebuilt-web'], {
    env: { ...process.env, DREAMWALK_WEB_DIST_DIR: '.next-ci-missing-output' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run the production web build before --prebuilt-web/);
});

// Git pushes must never consume a Vercel build before GitHub CI is green.
test('Vercel Git deployments stay disabled for both preview and production', () => {
  const config = JSON.parse(readFileSync('apps/web/vercel.json', 'utf8'));
  assert.equal(config.git?.deploymentEnabled, false);
});

test('filtered web launcher preserves the explicit non-secret origin contract', () => {
  assert.deepEqual(
    webEnvironment({
      API_WEB_ORIGIN: 'https://dreamwalk-rho.vercel.app',
      WEB_ALLOWED_ORIGINS: 'https://www.dreamwalk.online,https://dreamwalk-rho.vercel.app',
      DATABASE_URL: 'postgres://not-for-web',
      OPENAI_API_KEY: 'synthetic-not-for-web',
    }),
    {
      API_WEB_ORIGIN: 'https://dreamwalk-rho.vercel.app',
      WEB_ALLOWED_ORIGINS: 'https://www.dreamwalk.online,https://dreamwalk-rho.vercel.app',
    },
  );
});
