import { parseSparkInteger } from '@dreamwalk/contracts';
/** The usage wallet is independent of the legacy demo wallet. Amounts remain integer strings. */
export interface SparksWallet {
  ownerId: string;
  enabled: boolean;
  balanceSubunits: string;
  heldSubunits: string;
  availableSubunits: string;
  subunitsPerSpark: string;
  ledger: { id: string; kind: string; amountSubunits: string; createdAt: string }[];
}
export const SPARKS_REFRESH_EVENT = 'dreamwalk:sparks-refresh';

/** Reject malformed responses instead of displaying a fictional zero balance. */
export function readSparksWallet(value: unknown, expectedOwnerId: string): SparksWallet {
  const wallet = value as SparksWallet | null;
  if (
    !wallet ||
    !expectedOwnerId ||
    wallet.ownerId !== expectedOwnerId ||
    wallet.subunitsPerSpark !== '10000' ||
    typeof wallet.enabled !== 'boolean'
  )
    throw new Error('SPARK_WALLET_INVALID');
  for (const amount of [wallet.balanceSubunits, wallet.heldSubunits, wallet.availableSubunits]) {
    parseSparkInteger(amount);
  }
  if (
    BigInt(wallet.balanceSubunits) - BigInt(wallet.heldSubunits) !==
    BigInt(wallet.availableSubunits)
  )
    throw new Error('SPARK_WALLET_INVALID');
  if (!Array.isArray(wallet.ledger)) throw new Error('SPARK_WALLET_INVALID');
  for (const entry of wallet.ledger) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !/^\d+$/.test(entry.id) ||
      !['starter_grant', 'reserve', 'pending', 'capture', 'release'].includes(entry.kind) ||
      typeof entry.amountSubunits !== 'string' ||
      typeof entry.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      throw new Error('SPARK_WALLET_INVALID');
    parseSparkInteger(entry.amountSubunits);
  }
  return wallet;
}
