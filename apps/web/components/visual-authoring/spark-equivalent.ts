import {
  LEGACY_SPARK_RATE_VERSION,
  SPARK_RATE_VERSION,
  providerMicrosToSparkSubunits,
} from '@dreamwalk/contracts';

/** Null means a bound quote has no known tariff; never reprice it at today's rate. */
export function providerSparkSubunits(
  micros: number | undefined | null,
  rateVersion: string | null = SPARK_RATE_VERSION,
): string | null {
  if (
    typeof micros !== 'number' ||
    !Number.isSafeInteger(micros) ||
    micros < 0 ||
    (rateVersion !== SPARK_RATE_VERSION && rateVersion !== LEGACY_SPARK_RATE_VERSION)
  )
    return null;
  return providerMicrosToSparkSubunits(String(micros), rateVersion);
}
