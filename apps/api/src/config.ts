import { z } from 'zod';
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
export function readConfig(env = process.env) {
  const c = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      DATABASE_URL: z.string().url(),
      API_PORT: z.coerce.number().int().min(1).default(4000),
      WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
      AI_PROVIDER: z.enum(['mock', 'openai', 'local']).default('mock'),
      PAID_GENERATION_ENABLED: flag,
      PAYMENTS_ENABLED: flag,
      DISCORD_ENABLED: flag,
      DEV_AUTH_ENABLED: flag,
      DEMO_FAUCET_ENABLED: flag,
      ASSET_DIR: z.string().default('.local/assets'),
      GLOBAL_SPEND_CAP: z.coerce.number().int().min(0).default(0),
    })
    .parse(env);
  if (
    c.PAID_GENERATION_ENABLED ||
    c.PAYMENTS_ENABLED ||
    c.DISCORD_ENABLED ||
    c.AI_PROVIDER !== 'mock' ||
    c.GLOBAL_SPEND_CAP !== 0
  )
    throw new Error('Platform milestone permits only mock providers and zero spend.');
  if (c.NODE_ENV === 'production' && (c.DEV_AUTH_ENABLED || c.DEMO_FAUCET_ENABLED))
    throw new Error('Unsafe development flags in production.');
  if (c.NODE_ENV === 'production' && !c.WEB_ORIGIN.startsWith('https://'))
    throw new Error('Production requires HTTPS.');
  return c;
}
export const config = readConfig();
