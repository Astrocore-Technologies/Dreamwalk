/** Compile the real application graph in production import order, without listening,
 * running lifecycle hooks, connecting to a database, or dispatching providers. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
process.env.GENERATION_MODE = 'disabled';
process.env.LIVE_TEST_ENABLED = 'false';
const fs = require('node:fs');
const ts = require('typescript');
const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('/apps/api/src/main.ts')) {
    assert.ok(source.includes('void bootstrap();'));
    source = source.replace('void bootstrap();', 'export { AppModule };');
  }
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
};
test('production recovery-first import resolves the complete Nest dependency graph', async () => {
  // Import main FIRST: importing GenerationAuthority directly would mask the cycle.
  const { AppModule } = require('../../apps/api/src/main.ts');
  const {
    KnownAuthoringSettlement,
  } = require('../../apps/api/src/live-test/known-authoring-settlement.ts');
  const { GenerationAuthority } = require('../../apps/api/src/generation/service.ts');
  const tokens = Reflect.getMetadata('self:paramtypes', KnownAuthoringSettlement);
  assert.equal(tokens.find((p) => p.index === 1).param, GenerationAuthority);
  const { NestFactory } = require('@nestjs/core');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  try {
    assert.ok(app.get(KnownAuthoringSettlement));
    assert.ok(app.get(GenerationAuthority));
  } finally {
    await app.close();
  }
});
