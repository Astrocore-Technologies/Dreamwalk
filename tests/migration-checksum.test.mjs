import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMigrationSql,
  migrationChecksum,
  matchesMigrationChecksum,
} from '../apps/api/src/migration-checksum.ts';

const sql = 'CREATE TABLE example (\n id uuid PRIMARY KEY\n);\n';

test('migration checksums preserve LF, CRLF and the proven Windows final-CRLF history', () => {
  const lf = sql;
  const crlf = sql.replace(/\n/g, '\r\n');
  const finalCrlf = sql.slice(0, -1) + '\r\n';
  for (const original of [lf, crlf, finalCrlf]) {
    for (const current of [lf, crlf, finalCrlf]) {
      assert.equal(matchesMigrationChecksum(current, migrationChecksum(original)), true);
    }
  }
});

test('actual SQL edits and other whitespace changes still fail checksum verification', () => {
  const expected = migrationChecksum(sql);
  for (const changed of [
    sql.replace('uuid', 'text'),
    sql.replace('example', 'other'),
    sql + '\n',
    sql + ' ',
    '-- added comment\n' + sql,
  ]) {
    assert.equal(matchesMigrationChecksum(changed, expected), false);
  }
  assert.equal(matchesMigrationChecksum(sql, ''), false);
  assert.equal(matchesMigrationChecksum(sql, 'not-a-checksum'), false);
  assert.equal(matchesMigrationChecksum(sql, expected.toUpperCase()), false);
});

test('new migration execution and stored hashes use the same canonical SQL without trimming', () => {
  const crlf = sql.replace(/\n/g, '\r\n');
  assert.equal(canonicalMigrationSql(crlf), sql);
  assert.equal(migrationChecksum(canonicalMigrationSql(crlf)), migrationChecksum(sql));
  assert.equal(canonicalMigrationSql(' ' + crlf + '\n'), ' ' + sql + '\n');
  assert.equal(canonicalMigrationSql('\uFEFF' + sql), '\uFEFF' + sql);
});
