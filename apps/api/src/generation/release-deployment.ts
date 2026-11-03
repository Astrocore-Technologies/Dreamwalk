/** Deployment registration is ordered in pre-deploy; only a ready registered runtime activates. */
import type { PoolClient } from 'pg';
import type { ReleaseGenerationConfig } from './config';
import { fail } from '../errors';
import { fenceGenerationAdmission } from './scope-fence';

export function releaseDeploymentId(value: string | undefined) {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    fail(
      503,
      'GENERATION_RELEASE_DEPLOYMENT_ID_REQUIRED',
      'GENERATION_RELEASE_DEPLOYMENT_ID_REQUIRED',
    );
  return value!;
}
/** Only the serialized pre-deploy migration phase registers a candidate. It does not switch traffic. */
export async function registerReleaseDeployment(
  c: PoolClient,
  config: ReleaseGenerationConfig,
  deploymentId: string,
) {
  releaseDeploymentId(deploymentId);
  await fenceGenerationAdmission(c);
  const existing = (
    await c.query('SELECT * FROM generation_release_deployments WHERE deployment_id=$1', [
      deploymentId,
    ])
  ).rows[0];
  if (existing) {
    if (existing.config_fingerprint !== config.configFingerprint)
      fail(409, 'GENERATION_RELEASE_DEPLOYMENT_CONFLICT', 'GENERATION_RELEASE_DEPLOYMENT_CONFLICT');
    return String(existing.epoch);
  }
  const { configFingerprint, ...profile } = config;
  return String(
    (
      await c.query(
        'INSERT INTO generation_release_deployments(deployment_id,config_fingerprint,profile_snapshot) VALUES($1,$2,$3) RETURNING epoch',
        [deploymentId, configFingerprint, JSON.stringify(profile)],
      )
    ).rows[0].epoch,
  );
}
/** After required initialization and successful listen, before health readiness. Never registers. */
export async function activateRegisteredReleaseDeployment(
  c: PoolClient,
  config: ReleaseGenerationConfig,
  deploymentId: string,
) {
  releaseDeploymentId(deploymentId);
  await fenceGenerationAdmission(c);
  const candidate = (
    await c.query('SELECT * FROM generation_release_deployments WHERE deployment_id=$1', [
      deploymentId,
    ])
  ).rows[0];
  if (!candidate || candidate.config_fingerprint !== config.configFingerprint)
    fail(
      409,
      'GENERATION_RELEASE_PROFILE_NOT_REGISTERED',
      'GENERATION_RELEASE_PROFILE_NOT_REGISTERED',
    );
  const active = (
    await c.query('SELECT epoch FROM generation_release_activations ORDER BY epoch DESC LIMIT 1')
  ).rows[0];
  if (String(active?.epoch) === String(candidate.epoch)) return String(candidate.epoch);
  const latest = (
    await c.query('SELECT epoch FROM generation_release_deployments ORDER BY epoch DESC LIMIT 1')
  ).rows[0];
  if (String(latest?.epoch) !== String(candidate.epoch))
    fail(
      409,
      'GENERATION_RELEASE_DEPLOYMENT_SUPERSEDED',
      'GENERATION_RELEASE_DEPLOYMENT_SUPERSEDED',
    );
  await c.query('INSERT INTO generation_release_activations(epoch) VALUES($1)', [candidate.epoch]);
  return String(candidate.epoch);
}
/** Read-only. Pending/failed candidates do not replace the healthy active profile. */
export async function currentReleaseDeployment(
  c: Pick<PoolClient, 'query'>,
  config: ReleaseGenerationConfig,
) {
  const row = (
    await c.query(
      'SELECT d.epoch,d.config_fingerprint FROM generation_release_deployments d JOIN generation_release_activations a ON a.epoch=d.epoch ORDER BY d.epoch DESC LIMIT 1',
    )
  ).rows[0];
  if (!row || row.config_fingerprint !== config.configFingerprint)
    fail(409, 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE', 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE');
  return String(row.epoch);
}
export class ReleaseDeploymentReadiness {
  ready: boolean;
  constructor(release: boolean) {
    this.ready = !release;
  }
  async activate(work: () => Promise<unknown>) {
    await work();
    this.ready = true;
  }
}
