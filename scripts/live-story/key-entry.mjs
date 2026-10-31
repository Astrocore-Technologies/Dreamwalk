/** Secret transfer only after explicit execute approval. Never called by default plan. */
export function stripBootstrapSecrets(env) {
  delete env.NPC_AI_API_KEY;
  delete env.OPENAI_API_KEY;
}
export function consumeFreshKey(env) {
  const key = env.NPC_AI_API_KEY;
  stripBootstrapSecrets(env);
  if (!key) throw Error('FRESH_SECURE_KEY_REQUIRED');
  return key;
}
