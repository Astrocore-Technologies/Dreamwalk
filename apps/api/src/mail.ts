import nodemailer from 'nodemailer';
import { config } from './config';
import type { Locale } from '@dreamwalk/contracts';

const copy = {
  en: {
    reset: 'Reset your Dreamwalk password',
    verify: 'Verify your Dreamwalk email',
    instruction:
      'Open this link and confirm the action. The link expires in 30 minutes and can be used only once. If you did not request this, ignore this email.',
  },
  ru: {
    reset: 'Сброс пароля Dreamwalk',
    verify: 'Подтверждение email Dreamwalk',
    instruction:
      'Откройте ссылку и подтвердите действие. Ссылка действует 30 минут и используется один раз. Если вы не запрашивали это действие, проигнорируйте письмо.',
  },
  uk: {
    reset: 'Скидання пароля Dreamwalk',
    verify: 'Підтвердження email Dreamwalk',
    instruction:
      'Відкрийте посилання та підтвердьте дію. Посилання діє 30 хвилин і використовується один раз. Якщо ви не запитували цю дію, проігноруйте лист.',
  },
};
export const mailEnabled = Boolean(config.SMTP_HOST && config.SMTP_FROM);
const transport = mailEnabled
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: config.NODE_ENV === 'production',
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  : null;
export async function sendAccountMail(
  email: string,
  purpose: 'reset' | 'verify',
  token: string,
  locale: Locale,
) {
  if (!transport) return;
  const language = copy[locale] ?? copy.en;
  const path = purpose === 'reset' ? '/auth/reset-password/confirm' : '/auth/verify-email';
  const url = new URL(path, config.WEB_ORIGIN);
  url.hash = `token=${token}`;
  await transport.sendMail({
    from: config.SMTP_FROM,
    to: { address: email, name: '' },
    subject: language[purpose],
    text: `${language.instruction}\n\n${url.href}`,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
