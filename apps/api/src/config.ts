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
      API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
      API_HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).default('127.0.0.1'),
      WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
      AI_PROVIDER: z.enum(['mock', 'openai', 'local']).default('mock'),
      PAID_GENERATION_ENABLED: flag,
      PAYMENTS_ENABLED: flag,
      DISCORD_ENABLED: flag,
      DEV_AUTH_ENABLED: flag,
      DEMO_FAUCET_ENABLED: flag,
      AUTH_EMAIL_VERIFICATION_REQUIRED: flag,
      GOOGLE_CLIENT_ID: z.string().min(1).optional(),
      GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
      BREVO_API_KEY: z.string().min(1).optional(),
      BREVO_FROM: z.email().optional(),
      SMTP_HOST: z.string().min(1).optional(),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
      SMTP_SECURE: flag,
      SMTP_USER: z.string().min(1).optional(),
      SMTP_PASSWORD: z.string().min(1).optional(),
      SMTP_FROM: z.email().optional(),
      DREAMWALK_REQUIRE_INGRESS_SECRET: flag,
      DREAMWALK_INGRESS_SECRET: z
        .string()
        .regex(/^[A-Za-z0-9_-]{32,256}$/)
        .optional(),
      ASSET_DIR: z.string().default('.local/assets'),
      GLOBAL_SPEND_CAP: z.coerce.number().int().min(0).default(0),
    })
    .parse({ ...env, API_PORT: env.API_PORT ?? env.PORT });
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
  if (new URL(c.WEB_ORIGIN).origin !== c.WEB_ORIGIN || c.WEB_ORIGIN.includes('*'))
    throw new Error('WEB_ORIGIN must be an exact origin without credentials, path or wildcard.');
  if (c.DREAMWALK_REQUIRE_INGRESS_SECRET && !c.DREAMWALK_INGRESS_SECRET)
    throw new Error('Ingress secret required.');
  if (c.SMTP_HOST && !c.SMTP_FROM) throw new Error('SMTP_FROM is required with SMTP_HOST.');
  if (Boolean(c.SMTP_USER) !== Boolean(c.SMTP_PASSWORD))
    throw new Error('SMTP authentication requires both user and password.');
  if (!c.SMTP_HOST && (c.SMTP_FROM || c.SMTP_USER || c.SMTP_PASSWORD))
    throw new Error('Incomplete SMTP configuration.');
  if (c.AUTH_EMAIL_VERIFICATION_REQUIRED && !c.SMTP_HOST && !c.BREVO_API_KEY)
    throw new Error('Mandatory email verification requires email delivery configuration.');
  if (Boolean(c.GOOGLE_CLIENT_ID) !== Boolean(c.GOOGLE_CLIENT_SECRET))
    throw new Error('Google login requires client ID and secret.');
  if (Boolean(c.BREVO_API_KEY) !== Boolean(c.BREVO_FROM))
    throw new Error('Brevo delivery requires API key and sender.');
  if (c.BREVO_API_KEY && c.SMTP_HOST)
    throw new Error('Choose one email transport: Brevo HTTPS or SMTP.');
  return c;
}
export const config = readConfig();
