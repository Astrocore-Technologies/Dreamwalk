/**
 * Spark packs offered in the shop, priced in US cents. Reference rate: 200 Sparks = $5.00
 * (2.5 cents per Spark) with a volume discount on larger packs. Provider cost is
 * 2 Sparks per API cent, so one Spark costs us 0.5 cents.
 * Display only: no payment is taken anywhere until payments are separately authorised.
 */
export const SPARK_PACKS = [
  { sparks: 200, priceCents: 500 },
  { sparks: 500, priceCents: 1199 },
  { sparks: 1000, priceCents: 2299 },
  { sparks: 3000, priceCents: 6499 },
  { sparks: 5000, priceCents: 10499 },
  { sparks: 10000, priceCents: 19999 },
] as const;
export const SPARK_BASE_CENTS = 2.5;

export type SparkPack = (typeof SPARK_PACKS)[number];
/** Price of one Spark in cents. */
export const centsPerSpark = (pack: SparkPack) => pack.priceCents / pack.sparks;
/** Whole-percent saving against the base rate of the smallest pack. */
export const packSavingPercent = (pack: SparkPack) =>
  Math.max(0, Math.round((1 - centsPerSpark(pack) / SPARK_BASE_CENTS) * 100));
