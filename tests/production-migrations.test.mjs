import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { productionMigrationSql } = require('../apps/api/src/production-migrations.ts');
const { migrationChecksum } = require('../apps/api/src/migration-checksum.ts');
test('production requires operator-installed pgcrypto and never dispatches extension DDL', () => {
  const original = readFileSync('packages/db/migrations/001_platform.sql', 'utf8');
  const checksum = migrationChecksum(original);
  assert.throws(
    () => productionMigrationSql('001_platform.sql', original, false),
    /PGCRYPTO_REQUIRED/,
  );
  const executable = productionMigrationSql('001_platform.sql', original, true);
  assert.ok(executable.startsWith('\nCREATE TABLE users'));
  assert.ok(!/CREATE EXTENSION/i.test(executable));
  assert.equal(migrationChecksum(original), checksum);
  assert.equal(productionMigrationSql('002_example.sql', 'SELECT 1;', true), 'SELECT 1;');
  for (const sql of [
    'CREATE EXTENSION other;',
    'ALTER EXTENSION pgcrypto UPDATE;',
    'DROP EXTENSION pgcrypto;',
  ])
    assert.throws(
      () => productionMigrationSql('999_test.sql', sql, true),
      /EXTENSION_DDL_REQUIRES_OPERATOR/,
    );
  assert.throws(
    () => productionMigrationSql('001_platform.sql', 'CREATE EXTENSION other;', true),
    /UNEXPECTED_EXTENSION/,
  );
});
