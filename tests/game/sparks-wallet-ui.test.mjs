import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSparksWallet } from '../../apps/web/lib/sparks-wallet.ts';
import { formatSparkSubunits } from '../../packages/contracts/src/sparks.ts';
const wallet = {
  ownerId: 'first',
  enabled: true,
  balanceSubunits: '500000',
  heldSubunits: '12345',
  availableSubunits: '487655',
  subunitsPerSpark: '10000',
  ledger: [],
};
test('actual usage wallet is read with exact integer arithmetic, independently of demo credits', () => {
  assert.equal(readSparksWallet(wallet, 'first').availableSubunits, '487655');
  assert.equal(formatSparkSubunits('500000'), '50.00');
  assert.equal(formatSparkSubunits('487655', 'ru', 'exact'), '48,7655');
  const huge = '9223372036854775807';
  assert.equal(
    readSparksWallet(
      {
        ...wallet,
        balanceSubunits: huge,
        heldSubunits: '0',
        availableSubunits: huge,
      },
      'first',
    ).availableSubunits,
    huge,
  );
});
test('unavailable, malformed or inconsistent wallet never becomes fake zero', () => {
  for (const value of [
    null,
    { ...wallet, ownerId: 'another-account' },
    {},
    { ...wallet, subunitsPerSpark: '100' },
    { ...wallet, balanceSubunits: 500000 },
    { ...wallet, availableSubunits: '-1' },
    { ...wallet, availableSubunits: '500000' },
    { ...wallet, heldSubunits: '0.5' },
    { ...wallet, balanceSubunits: '0500000' },
    {
      ...wallet,
      balanceSubunits: '9223372036854775808',
      heldSubunits: '0',
      availableSubunits: '9223372036854775808',
    },
    {
      ...wallet,
      ledger: [{ id: '1', kind: 'starter_grant', amountSubunits: 'x', createdAt: '2026-11-02' }],
    },
  ])
    assert.throws(() => readSparksWallet(value, 'first'));
});
test('header is scoped to account and refreshes after mutations and asynchronous settlement', async () => {
  const source = async (path) =>
    readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
  const shell = await source('components/shell.tsx');
  assert.match(shell, /<SparksBalance key=\{user.id\} ownerId=\{user.id\}/);
  assert.doesNotMatch(shell, /<small>DEMO/);
  const hook = await source('lib/use-sparks-wallet.ts');
  assert.match(hook, /state\?\.ownerId === ownerId/);
  assert.match(hook, /active && request === sequence/);
  assert.match(hook, /setInterval\(visibleRefresh, 15000\)/);
  assert.match(hook, /removeEventListener\(SPARKS_REFRESH_EVENT/);
  assert.match(hook, /api<unknown>\('\/sparks\/wallet'\)/);
  assert.doesNotMatch(hook, /'\/wallet'/);
  assert.match(
    await source('lib/client.tsx'),
    /dispatchEvent\(new Event\(SPARKS_REFRESH_EVENT\)\)/,
  );
  assert.doesNotMatch(
    await source('components/personal.tsx'),
    /sparks\.data\?\.(?:available|held)Subunits \?\? '0'/,
  );
});
