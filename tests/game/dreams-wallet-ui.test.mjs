import test from 'node:test';
import assert from 'node:assert/strict';
import { readDreamsWallet } from '../../apps/web/lib/dreams-wallet.ts';
const wallet = (patch = {}) => ({
  dreams: {
    ownerId: 'owner-a',
    currency: 'dreams',
    balanceSubunits: '500000',
    heldSubunits: '10000',
    availableSubunits: '490000',
    subunitsPerDream: '10000',
    spendingAvailable: true,
    ledger: [
      {
        id: '1',
        kind: 'starter_grant',
        amountSubunits: '500000',
        createdAt: '2026-11-03T00:00:00.000Z',
      },
    ],
    ...patch,
  },
});
test('Dreams wallet accepts only exact account-bound balances and supported ledger entries', () => {
  assert.equal(readDreamsWallet(wallet(), 'owner-a').availableSubunits, '490000');
  for (const value of [
    null,
    {},
    wallet({ ownerId: 'owner-b' }),
    wallet({ currency: 'sparks' }),
    wallet({ availableSubunits: '500000' }),
    wallet({ balanceSubunits: '1.2' }),
    wallet({ balanceSubunits: 500000 }),
    wallet({ ledger: [{ id: 'x', kind: 'transfer', amountSubunits: '1', createdAt: 'bad' }] }),
  ])
    assert.throws(() => readDreamsWallet(value, 'owner-a'));
});
test('Dreams amounts retain integer precision above JavaScript safe-number limits', () => {
  const large = '9007199254740993';
  assert.equal(
    readDreamsWallet(
      wallet({ balanceSubunits: large, heldSubunits: '0', availableSubunits: large }),
      'owner-a',
    ).balanceSubunits,
    large,
  );
});

test('admin-issued Dreams remain readable without accepting unknown or other-account entries', () => {
  const value = wallet({
    ledger: [
      { id: '2', kind: 'admin_credit', amountSubunits: '70000', createdAt: '2026-11-06T00:00:00Z' },
    ],
  });
  assert.equal(readDreamsWallet(value, 'owner-a').ledger[0].kind, 'admin_credit');
  assert.throws(() => readDreamsWallet(value, 'owner-b'));
});
