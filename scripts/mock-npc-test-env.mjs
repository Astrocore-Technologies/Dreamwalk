/** Test children must not inherit a workstation's approved external provider settings. */
export function forceMockNpcTestEnvironment(env = process.env) {
  for (const key of Object.keys(env)) if (key.startsWith('NPC_AI_')) delete env[key];
  env.NPC_AI_PROVIDER = 'mock';
  env.NPC_AI_EXTERNAL_APPROVED = 'false';
  return env;
}
