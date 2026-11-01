/** Test children must not inherit a workstation's approved external provider settings. */
export function forceMockNpcTestEnvironment(env = process.env) {
  for (const key of Object.keys(env))
    if (
      key.startsWith('NPC_AI_') ||
      key.startsWith('LIVE_TEST_') ||
      key.startsWith('IMAGE_') ||
      key.startsWith('GENERATION_') ||
      key.startsWith('OPENAI_') ||
      key === 'DREAMWALK_SERVER_ENV_FILE' ||
      key === 'DREAMWALK_LIVE_SECRET_FILE'
    )
      delete env[key];
  env.NPC_AI_PROVIDER = 'mock';
  env.NPC_AI_EXTERNAL_APPROVED = 'false';
  return env;
}
