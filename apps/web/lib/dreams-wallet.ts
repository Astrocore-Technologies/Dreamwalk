import { parseSparkInteger } from '@dreamwalk/contracts';
export interface DreamsWallet {
  ownerId: string;
  currency: 'dreams';
  balanceSubunits: string;
  heldSubunits: string;
  availableSubunits: string;
  subunitsPerDream: '10000';
  spendingAvailable: boolean;
  ledger: {
    id: string;
    kind: 'starter_grant' | 'admin_credit' | 'reserve' | 'pending' | 'capture' | 'release';
    amountSubunits: string;
    createdAt: string;
  }[];
}
/** Account-bound integer balances only. Missing/malformed data is never a fictional zero. */
export function readDreamsWallet(value: unknown, ownerId: string): DreamsWallet {
  const wallet = (value as { dreams?: DreamsWallet } | null)?.dreams;
  if (
    !wallet ||
    !ownerId ||
    wallet.ownerId !== ownerId ||
    wallet.currency !== 'dreams' ||
    wallet.subunitsPerDream !== '10000' ||
    typeof wallet.spendingAvailable !== 'boolean'
  )
    throw new Error('DREAM_WALLET_INVALID');
  for (const amount of [wallet.balanceSubunits, wallet.heldSubunits, wallet.availableSubunits])
    parseSparkInteger(amount);
  if (
    BigInt(wallet.balanceSubunits) - BigInt(wallet.heldSubunits) !==
      BigInt(wallet.availableSubunits) ||
    !Array.isArray(wallet.ledger)
  )
    throw new Error('DREAM_WALLET_INVALID');
  for (const entry of wallet.ledger) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !/^\d+$/.test(entry.id) ||
      !['starter_grant', 'admin_credit', 'reserve', 'pending', 'capture', 'release'].includes(
        entry.kind,
      ) ||
      typeof entry.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      throw new Error('DREAM_WALLET_INVALID');
    parseSparkInteger(entry.amountSubunits);
  }
  return wallet;
}
