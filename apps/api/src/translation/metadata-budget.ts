import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ReleaseGenerationConfig } from '../generation/config';
import { aggregateGenerationExposure } from '../generation/aggregate-exposure';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import { currentReleaseDeployment } from '../generation/release-deployment';

export const METADATA_BUDGET_SCOPE = 'platform:story-metadata';
/** Platform identity is never a fabricated player or a player's Sparks/Dreams grant.
 * The existing shared ledger includes these reservations in aggregate exposure. */
export async function lockMetadataSpendScope(c: PoolClient, config: ReleaseGenerationConfig) {
  const unlimited = config.allowance === 'unlimited';
  await c.query(
    `INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,unlimited_allowance)
     VALUES($1,true,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      METADATA_BUDGET_SCOPE,
      config.totalCapMicros,
      config.textCapMicros,
      config.imageCapMicros,
      unlimited,
    ],
  );
  const scope = (
    await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
      METADATA_BUDGET_SCOPE,
    ])
  ).rows[0];
  await fenceGenerationAdmission(c);
  await currentReleaseDeployment(c, config);
  if (!scope.approved || scope.blocked || scope.unlimited_allowance !== unlimited)
    throw new Error('METADATA_BUDGET_UNAVAILABLE');
  for (const [field, cap] of [
    ['total_cap_micros', config.totalCapMicros],
    ['text_cap_micros', config.textCapMicros],
    ['image_cap_micros', config.imageCapMicros],
  ] as const)
    if (cap === null ? scope[field] !== null : String(scope[field]) !== String(cap))
      throw new Error('METADATA_BUDGET_POLICY_CHANGED');
}
export async function reserveMetadataSpend(
  c: PoolClient,
  config: ReleaseGenerationConfig,
  jobId: string,
  upperMicros: number,
) {
  if (!Number.isSafeInteger(upperMicros) || upperMicros < 1)
    throw new Error('METADATA_COST_BOUND_REQUIRED');
  await lockMetadataSpendScope(c, config);
  const unlimited = config.allowance === 'unlimited';
  if (!unlimited) {
    const exposure = await aggregateGenerationExposure(c);
    if (
      config.aggregateCapMicros === null ||
      exposure.totalMicros + BigInt(upperMicros) > BigInt(config.aggregateCapMicros)
    )
      throw new Error('GENERATION_AGGREGATE_BUDGET_EXCEEDED');
    const row = (
      await c.query(
        `SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS spent
       FROM generation_budget_reservations WHERE scope_id=$1`,
        [METADATA_BUDGET_SCOPE],
      )
    ).rows[0];
    if (
      BigInt(row.spent) + BigInt(upperMicros) >
      BigInt(Math.min(config.totalCapMicros!, config.textCapMicros!))
    )
      throw new Error('GENERATION_BUDGET_EXCEEDED');
  }
  const id = randomUUID();
  await c.query(
    `INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status)
     VALUES($1,$2,NULL,'text',$3,$4,'held')`,
    [id, METADATA_BUDGET_SCOPE, `metadata:${jobId}`, upperMicros],
  );
  return id;
}
