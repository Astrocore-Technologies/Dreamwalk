import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeErrorCode, errorMessages } from '../../apps/web/lib/error-catalog.ts';
import { dictionaries, supportedLocales } from '../../apps/web/lib/locales.ts';

const apiCodes = () => {
  const codes = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts'))
        for (const match of readFileSync(path, 'utf8').matchAll(
          /fail\(\s*\d+,\s*'([A-Z][A-Z0-9_]+)'/g,
        ))
          codes.add(match[1]);
    }
  };
  walk('apps/api/src');
  return [...codes];
};
// Older codes already carry hand-written wording in the client's own table.
const clientSource = readFileSync('apps/web/lib/client.tsx', 'utf8');
const clientCodes = new Set(
  [
    ...clientSource
      .slice(clientSource.indexOf('const errorKeys'), clientSource.indexOf('export class ApiError'))
      .matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm),
  ].map((m) => m[1]),
);
const generic = describeErrorCode('NOT_A_REAL_CODE_FOR_THIS_TEST');

test('every error code the API can raise has an actionable message, never the bare generic one', () => {
  const codes = apiCodes();
  assert.ok(codes.length > 150);
  assert.ok(clientCodes.has('UNAUTHORIZED'));
  const bare = codes.filter(
    (code) => !clientCodes.has(code) && describeErrorCode(code) === generic,
  );
  assert.deepEqual(bare, [], 'add the new code to the catalog or a recovery category');
});

test('critical player codes have their own wording, not a category fallback', () => {
  for (const code of [
    'STALE_STATE',
    'TURN_PHASE_STALE',
    'IDEMPOTENCY_CONFLICT',
    'QUOTE_EXPIRED',
    'MAP_GRID_REQUIRED',
    'START_SOURCE_CHANGED',
    'NOT_PLAYABLE',
    'OPENING_ART_REQUIRED',
    'CAMPAIGN_FULL',
    'NPC_AI_BUSY',
    'OUT_OF_RANGE',
    'PATH_BLOCKED',
  ])
    assert.notEqual(describeErrorCode(code).ru, generic.ru, code);
});

test('every catalog sentence is translated into all three interface languages', () => {
  assert.ok(Object.keys(errorMessages).length >= 20);
  for (const [key, text] of Object.entries(errorMessages))
    for (const locale of supportedLocales) {
      assert.equal(dictionaries[locale][key], text[locale], `${locale}: ${key}`);
      assert.ok(text[locale].trim().length > 10);
    }
});

test('messages never expose internal codes or technical words', () => {
  for (const text of Object.values(errorMessages))
    for (const locale of supportedLocales)
      assert.doesNotMatch(text[locale], /[A-Z]{3,}_[A-Z_]+|HTTP|\b4\d\d\b|\b5\d\d\b|stack/i);
});
