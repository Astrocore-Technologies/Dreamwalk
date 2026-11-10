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

export type SparkPack = (typeof SPARK_PACKS)[number];
/** Price of one Spark in cents. */
export const centsPerSpark = (pack: SparkPack) => pack.priceCents / pack.sparks;
/** Bonus on a user's first purchase, as a share of the pack (+25%). Display only for now. */
export const FIRST_PURCHASE_BONUS = 0.25;
export const firstPurchaseBonusSparks = (pack: SparkPack) =>
  Math.round(pack.sparks * FIRST_PURCHASE_BONUS);
