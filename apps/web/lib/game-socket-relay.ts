import WebSocket, { type RawData } from 'ws';
import { localeSchema } from '@dreamwalk/contracts';
import { canonicalWebOrigin, trustedBrowserOrigin } from './hosted-origin';

const CLIENT_LIMIT = 8192;
const SERVER_LIMIT = 1024 * 1024;
const BUFFER_LIMIT = 1024 * 1024;

/** Server-only configuration; never accept an upstream target or headers from the caller. */
export function socketRelayTarget(request: Request, env: NodeJS.ProcessEnv) {
  if (env.VERCEL !== '1') return null;
  const secret = env.DREAMWALK_INGRESS_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('RELAY_CONFIG');
  const api = new URL(env.API_URL ?? '');
  const canonical = canonicalWebOrigin(env);
  if (!canonical) throw new Error('RELAY_CONFIG');
  const web = new URL(canonical);
  if (
    api.protocol !== 'https:' ||
    api.username ||
    api.password ||
    api.pathname !== '/' ||
    api.search ||
    api.hash ||
    web.protocol !== 'https:' ||
    !trustedBrowserOrigin(request, env)
  )
    throw new Error('RELAY_ORIGIN');
  const cookie = request.headers.get('cookie') ?? '';
  if (
    cookie.length > 8192 ||
    !cookie.split(';').some((v) => /^dreamwalk_session=[a-f0-9]{64}$/.test(v.trim()))
  )
    throw new Error('RELAY_SESSION');
  const sessionCookie = cookie
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith('dreamwalk_session='))
    .join('; ');
  const incoming = new URL(request.url);
  const campaignId = incoming.searchParams.get('campaignId');
  if (!campaignId || !/^[a-f0-9-]{36}$/i.test(campaignId)) throw new Error('RELAY_CAMPAIGN');
  const url = new URL('/api/v1/game/socket', api);
  url.protocol = 'wss:';
  url.searchParams.set('campaignId', campaignId);
  // Match the API socket's bounded output preference, never forward arbitrary query data.
  const locale = localeSchema.safeParse(incoming.searchParams.get('locale'));
  if (locale.success) url.searchParams.set('locale', locale.data);
  return {
    url: url.href,
    headers: { cookie: sessionCookie, origin: web.origin, 'x-dreamwalk-ingress': secret },
  };
}

function bytes(data: RawData) {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
}
function closeCode(code: number) {
  return code === 1000 ||
    code === 1001 ||
    code === 1008 ||
    code === 1009 ||
    code === 1011 ||
    code === 1012 ||
    code === 1013 ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1011;
}

/** One connection, no durable state and no automatic replay of client operations. */
export function relayGameSocket(browser: WebSocket, upstream: WebSocket, lifetimeMs = 280_000) {
  let ended = false;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = setTimeout(() => stop(1012), lifetimeMs);
  lifetime.unref();
  function stop(code = 1011) {
    if (ended) return;
    ended = true;
    clearTimeout(lifetime);
    pending.length = 0;
    pendingBytes = 0;
    for (const ws of [browser, upstream]) {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close(closeCode(code));
    }
    killTimer = setTimeout(() => {
      for (const ws of [browser, upstream]) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, 250);
    killTimer.unref();
  }
  const send = (ws: WebSocket, data: Buffer) => {
    if (ended || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount + data.length > BUFFER_LIMIT) return stop(1013);
    ws.send(data, { binary: false }, (error) => {
      if (error) stop();
    });
  };
  browser.on('message', (data, binary) => {
    if (ended) return;
    const message = bytes(data);
    if (binary || message.length > CLIENT_LIMIT) return stop(1009);
    if (upstream.readyState === WebSocket.CONNECTING) {
      if (pending.length >= 8 || pendingBytes + message.length > 32768) return stop(1013);
      pending.push(message);
      pendingBytes += message.length;
    } else send(upstream, message);
  });
  upstream.on('open', () => {
    if (ended) return upstream.terminate();
    for (const message of pending) send(upstream, message);
    pending.length = 0;
    pendingBytes = 0;
  });
  upstream.on('message', (data, binary) => {
    const message = bytes(data);
    if (binary || message.length > SERVER_LIMIT) return stop(1009);
    send(browser, message);
  });
  // Upstream autoPong MUST be false: only an actual browser pong proves liveness.
  upstream.on('ping', (data) => {
    if (!ended && browser.readyState === WebSocket.OPEN) browser.ping(data);
  });
  browser.on('pong', (data) => {
    if (!ended && upstream.readyState === WebSocket.OPEN) upstream.pong(data);
  });
  for (const ws of [browser, upstream]) {
    ws.on('error', () => stop());
    ws.on('close', (code) => {
      stop(code);
      if (browser.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED)
        clearTimeout(killTimer);
    });
  }
  return stop;
}

export function openGameSocketRelay(
  browser: WebSocket,
  target: NonNullable<ReturnType<typeof socketRelayTarget>>,
) {
  const upstream = new WebSocket(target.url, {
    headers: target.headers,
    autoPong: false,
    followRedirects: false,
    handshakeTimeout: 8000,
    maxPayload: SERVER_LIMIT,
    perMessageDeflate: false,
  });
  const stop = relayGameSocket(browser, upstream);
  upstream.on('unexpected-response', (_request, response) => {
    // The browser side is already upgraded. Preserve terminal authorization
    // failures so its reconnect loop does not hammer an expired session.
    const status = response.statusCode;
    response.resume();
    stop(status === 401 || status === 403 ? 1008 : 1011);
    response.destroy();
  });
  return stop;
}
