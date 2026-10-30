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
      SMTP_HOST: z.string().min(1).optional(),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
      SMTP_SECURE: flag,
      SMTP_USER: z.string().min(1).optional(),
      SMTP_PASSWORD: z.string().min(1).optional(),
      SMTP_FROM: z.email().optional(),
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
  if (c.SMTP_HOST && !c.SMTP_FROM) throw new Error('SMTP_FROM is required with SMTP_HOST.');
  if (Boolean(c.SMTP_USER) !== Boolean(c.SMTP_PASSWORD))
    throw new Error('SMTP authentication requires both user and password.');
  if (!c.SMTP_HOST && (c.SMTP_FROM || c.SMTP_USER || c.SMTP_PASSWORD))
    throw new Error('Incomplete SMTP configuration.');
  return c;
}
export const config = readConfig();
