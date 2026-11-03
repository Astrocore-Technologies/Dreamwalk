import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { settingsSchema } from '@dreamwalk/contracts';
import { Auth, requestAccountEmail, tokenHash, userView } from './auth';
import { config } from './config';
import { Db } from './db';
import { mailEnabled } from './mail';
import { grantRegistrationDreams } from './generation/starter-dreams';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export function googleEmailIsAuthoritative(claims: JWTPayload) {
  return (
    claims.email_verified === true &&
    typeof claims.email === 'string' &&
    (claims.email.toLowerCase().endsWith('@gmail.com') ||
      (typeof claims.hd === 'string' && claims.hd.length > 0))
  );
}
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  nonceHash: string,
  resolver: JWTVerifyGetKey = keys,
) {
  const { payload } = await jwtVerify(idToken, resolver, {
    issuer: ['accounts.google.com', 'https://accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    maxTokenAge: '10m',
    requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email'],
  });
  if (
    typeof payload.nonce !== 'string' ||
    tokenHash(payload.nonce) !== nonceHash ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    payload.sub.length > 255 ||
    typeof payload.email !== 'string' ||
    payload.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
  )
    throw new Error('INVALID_GOOGLE_IDENTITY');
  return payload as JWTPayload & { sub: string; email: string };
}
/** Only call with claims returned by verifyGoogleIdToken; never accept client profile data. */
export async function provisionGoogleUser(
  db: Db,
  payload: JWTPayload & { sub: string; email: string },
) {
  const email = payload.email.toLowerCase();
  const verified = googleEmailIsAuthoritative(payload);
  return db.tx(async (c) => {
    // Serialize concurrent first login for the same stable provider identity.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `google:${payload.sub}`,
    ]);
    const existing = (
      await c.query(
        "SELECT u.* FROM users u JOIN auth_identities i ON i.user_id=u.id WHERE i.provider='google' AND i.subject=$1 AND u.deleted_at IS NULL FOR UPDATE OF u",
        [payload.sub],
      )
    ).rows[0];
    if (existing) return existing;
    // Never link or overwrite an existing password user by matching email.
    if ((await c.query('SELECT id FROM users WHERE email=$1', [email])).rowCount)
      throw new Error('ACCOUNT_LINK_REQUIRED');
    if (!verified && !mailEnabled) throw new Error('EMAIL_DELIVERY_UNAVAILABLE');
    const created = (
      await c.query(
        'INSERT INTO users(email,password_hash,name,handle,settings,email_verified,email_verification_required,starter_sparks_eligible,starter_dreams_eligible) VALUES($1,$2,$3,$4,$5,$6,true,false,true) RETURNING *',
        [
          email,
          'oauth:google',
          typeof payload.name === 'string' && payload.name.trim().length >= 2
            ? payload.name.trim().slice(0, 60)
            : 'Wanderer',
          `wanderer_${randomBytes(10).toString('hex')}`,
          JSON.stringify(settingsSchema.parse({})),
          verified,
        ],
      )
    ).rows[0];
    await c.query("INSERT INTO auth_identities(provider,subject,user_id) VALUES('google',$1,$2)", [
      payload.sub,
      created.id,
    ]);
    await c.query('INSERT INTO wallets(user_id) VALUES($1)', [created.id]);
    if (verified) await grantRegistrationDreams(c, created.id);
    await c.query(
      "INSERT INTO notifications(user_id,title,message,type,payload) VALUES($1,'','','welcome','{}')",
      [created.id],
    );
    return created;
  });
}
const enabled = () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
const callback = () => new URL('/api/v1/auth/google/callback', config.WEB_ORIGIN).href;
const cookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/v1/auth/google',
};
@Controller('api/v1/auth')
export class GoogleAuthController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
  ) {}
  @Get('providers')
  providers() {
    return {
      google: enabled(),
      emailVerificationRequired: config.AUTH_EMAIL_VERIFICATION_REQUIRED,
    };
  }
  @Get('google/start')
  async start(@Res() res: Response) {
    if (!enabled())
      return res.redirect(new URL('/auth/sign-in?googleError=unavailable', config.WEB_ORIGIN).href);
    const state = randomBytes(32).toString('hex');
    const browser = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    await this.db.query('DELETE FROM auth_oauth_attempts WHERE expires_at<now()');
    await this.db.query(
      "INSERT INTO auth_oauth_attempts(state_hash,browser_hash,nonce_hash,code_verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [tokenHash(state), tokenHash(browser), tokenHash(nonce), verifier],
    );
    res.cookie('dreamwalk_oauth', browser, { ...cookieOptions, maxAge: 600000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!,
      redirect_uri: callback(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: Buffer.from(tokenHash(verifier), 'hex').toString('base64url'),
    }).toString();
    return res.redirect(url.href);
  }
  @Get('google/callback')
  async finish(@Req() req: Request, @Res() res: Response) {
    const failure = (code: string) =>
      res.redirect(new URL(`/auth/sign-in?googleError=${code}`, config.WEB_ORIGIN).href);
    const browser = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('dreamwalk_oauth='))
      ?.slice('dreamwalk_oauth='.length);
    res.clearCookie('dreamwalk_oauth', cookieOptions);
    if (
      !enabled() ||
      !browser ||
      !/^[a-f0-9]{64}$/.test(browser) ||
      typeof req.query.state !== 'string' ||
      !/^[a-f0-9]{64}$/.test(req.query.state)
    )
      return failure('invalid');
    // Consume before external calls; browser binding prevents login CSRF, and replay cannot retry.
    const attempts = await this.db.query(
      'DELETE FROM auth_oauth_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',
      [tokenHash(req.query.state), tokenHash(browser)],
    );
    const attempt = attempts[0];
    if (!attempt || typeof req.query.code !== 'string' || req.query.code.length > 4096)
      return failure('invalid');
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.GOOGLE_CLIENT_ID!,
          client_secret: config.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callback(),
          grant_type: 'authorization_code',
          code_verifier: attempt.code_verifier as string,
        }),
      });
      if (!response.ok) return failure('invalid');
      const body: unknown = await response.json();
      const idToken = (body as { id_token?: unknown })?.id_token;
      if (typeof idToken !== 'string' || idToken.length > 16384) return failure('invalid');
      const payload = await verifyGoogleIdToken(
        idToken,
        config.GOOGLE_CLIENT_ID!,
        attempt.nonce_hash as string,
      );
      const row = await provisionGoogleUser(this.db, payload);
      const user = userView(row);
      await this.auth.session(user, req, res, true);
      if (!user.emailVerified) await requestAccountEmail(this.db, user.email, 'verify');
      return res.redirect(
        new URL(
          !user.emailVerified ? '/account/sessions' : user.onboarded ? '/home' : '/onboarding',
          config.WEB_ORIGIN,
        ).href,
      );
    } catch (error) {
      // Never include tokens, provider responses or credentials in logs/redirects.
      return failure(
        error instanceof Error && error.message === 'ACCOUNT_LINK_REQUIRED'
          ? 'existing_account'
          : 'unavailable',
      );
    }
  }
}
