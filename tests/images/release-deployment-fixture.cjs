// Synthetic deployment helper for disposable databases only. Never imported by application code.
const { randomUUID } = require('node:crypto');
const {
  registerReleaseDeployment,
  activateRegisteredReleaseDeployment,
} = require('../../apps/api/dist/generation/release-deployment.js');
const { fenceGenerationAdmission } = require('../../apps/api/dist/generation/scope-fence.js');
exports.activateReleaseDeployment = async (c, config) => {
  await fenceGenerationAdmission(c);
  const active = (
    await c.query(
      'SELECT d.epoch,d.config_fingerprint FROM generation_release_deployments d JOIN generation_release_activations a ON a.epoch=d.epoch ORDER BY d.epoch DESC LIMIT 1',
    )
  ).rows[0];
  if (active?.config_fingerprint === config.configFingerprint) return String(active.epoch);
  const id = randomUUID();
  await registerReleaseDeployment(c, config, id);
  return activateRegisteredReleaseDeployment(c, config, id);
};
