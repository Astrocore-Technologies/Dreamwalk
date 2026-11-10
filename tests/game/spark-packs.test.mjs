import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SPARK_PACKS,
  centsPerSpark,
  firstPurchaseBonusSparks,
} from '../../apps/web/lib/spark-packs.ts';
const shop = await readFile(new URL('../../apps/web/components/shop.tsx', import.meta.url), 'utf8');
test('the pack ladder starts at 200 Sparks for $5 and only gets cheaper per Spark', () => {
  assert.deepEqual(
    SPARK_PACKS.map((pack) => pack.sparks),
    [200, 500, 1000, 3000, 5000, 10000],
  );
  assert.equal(SPARK_PACKS[0].priceCents, 500);
  for (let i = 1; i < SPARK_PACKS.length; i++) {
    assert.ok(centsPerSpark(SPARK_PACKS[i]) < centsPerSpark(SPARK_PACKS[i - 1]));
  }
  // Every pack stays well above the provider cost of 2 Sparks per API cent (0.5 cent per Spark).
  assert.ok(SPARK_PACKS.every((pack) => centsPerSpark(pack) >= 1.5));
});
test('the first purchase bonus is 25% of every pack in whole Sparks', () => {
  assert.deepEqual(SPARK_PACKS.map(firstPurchaseBonusSparks), [50, 125, 250, 750, 1250, 2500]);
  assert.doesNotMatch(shop, /packSavingPercent|text\.saving/);
});
test('the shop never takes a payment: buy buttons are disabled and no request is made', () => {
  assert.match(shop, /<button type="button" className="button primary" disabled>/);
  assert.doesNotMatch(shop, /fetch\(|onClick|onSubmit|<form|window\.open|location\./);
});
