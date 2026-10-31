/** Default is a read-only plan. Paid execution requires separate operator approval and fresh key. */
import { LIMITS } from './live-story/guard.mjs';
import { consumeFreshKey, stripBootstrapSecrets } from './live-story/key-entry.mjs';
const plan = {
  model: LIMITS.model,
  maximumRequests: 4,
  carriedMicros: LIMITS.carriedMicros,
  remainingMicros: 989231,
  runSubcapMicros: LIMITS.runCapMicros,
  steps: [
    'Two independently authenticated synthetic players select heroes and join one campaign',
    'Ordinary director creates a grounded scene/NPC; both players enter it',
    'Ordinary NPC speech receives a real response',
    'Second director turn refers to confirmed first turn; same NPC receives a follow-up',
    'Reconnect both clients and compare persisted shared canon; no duplicate dispatch',
  ],
  defaults:
    'No network, key reads, database, images, or application restart without --execute and explicit fresh-key gate',
  costEvidence: 'Conservative configured-rate accounting, not an invoice guarantee',
};
if (process.argv.includes('--execute') && process.argv.includes('--rehearse'))
  throw Error('AMBIGUOUS_MODE');
if (process.argv.includes('--rehearse')) {
  stripBootstrapSecrets(process.env);
  await execute('synthetic-not-a-key', true);
} else if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  if (process.env.LIVE_STORY_APPROVED !== 'text-only-four-requests-carried-10769')
    throw Error('EXPLICIT_LIVE_APPROVAL_REQUIRED');
  // This is deliberately the first secret access. Never read an env file or an old saved key.
  const freshKey = consumeFreshKey(process.env);
  await execute(freshKey);
}
async function execute(key, fixture = false) {
  const { randomUUID, createHash } = await import('node:crypto'),
    { spawn } = await import('node:child_process'),
    { once } = await import('node:events');
  const { setTimeout: delay } = await import('node:timers/promises'),
    { mkdir, writeFile, access, readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path'),
    net = await import('node:net');
  const { pathToFileURL } = await import('node:url');
  const root = resolve(import.meta.dirname, '..'),
    ledger = resolve(
      root,
      fixture
        ? `.local/live-story-rehearsal-${randomUUID()}/ledger.json`
        : '.local/live-story-evaluation-20261031/ledger.json',
    );
  await access(resolve(root, 'apps/api/dist/main.js')); // Never build/install or touch the managed preview implicitly.
  const { default: WebSocket } = await import('ws');
  const port = async () => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  };
  const apiPort = await port(),
    pgPort = await port(),
    runId = randomUUID(),
    cluster = fixture ? `live-story-${runId}` : 'live-story-evaluation-20261031';
  const exists = async (path) =>
    access(path)
      .then(() => true)
      .catch((e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      });
  if (!fixture && (await exists(ledger))) throw Error('LEGACY_FILE_LEDGER_RECONCILIATION_REQUIRED');
  const initializeLedger = !(await exists(
    resolve(root, '.local', cluster, 'postgres', 'PG_VERSION'),
  ));
  // Only the isolated bootstrap reads these local-service settings. No preview DB is reused.
  process.env.NODE_ENV = 'test';
  process.env.LOCAL_POSTGRES_CLUSTER = cluster;
  process.env.LOCAL_POSTGRES_PORT = String(pgPort);
  delete process.env.DATABASE_URL;
  const { startLocalPostgres } = await import('./postgres-local.mjs');
  const pg = await startLocalPostgres();
  const origin = 'http://localhost:4174',
    base = `http://127.0.0.1:${apiPort}/api/v1`;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SYSTEMROOT: process.env.SYSTEMROOT,
    COMSPEC: process.env.COMSPEC,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    API_PORT: String(apiPort),
    WEB_ORIGIN: origin,
    ASSET_DIR: resolve(root, '.local', cluster, 'assets'),
    AI_PROVIDER: 'mock',
    PAID_GENERATION_ENABLED: 'false',
    PAYMENTS_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    DEV_AUTH_ENABLED: 'false',
    DEMO_FAUCET_ENABLED: 'false',
    GLOBAL_SPEND_CAP: '0',
    NPC_AI_PROVIDER: 'openai-responses',
    NPC_AI_MODEL: LIMITS.model,
    NPC_AI_EXTERNAL_APPROVED: 'true',
    NPC_AI_PRICING_VERIFIED: 'true',
    NPC_AI_API_KEY: key,
    NPC_AI_VERSION: 'live-story-evaluation-standard-v1',
    NPC_AI_CREDIT_PRICE: '0',
    NPC_AI_UPPER_MICROS: String(LIMITS.requestUpperMicros),
    NPC_AI_CAP_MICROS: String(LIMITS.runCapMicros),
    NPC_AI_INPUT_MICROS_PER_MILLION: String(LIMITS.inputRate),
    NPC_AI_OUTPUT_MICROS_PER_MILLION: String(LIMITS.outputRate),
    NPC_AI_MAX_OUTPUT_TOKENS: String(LIMITS.maxOutputTokens),
    NPC_AI_TIMEOUT_MS: '60000',
    LIVE_STORY_CHILD_APPROVED: 'text-only-four-requests-carried-10769',
    LIVE_STORY_LEDGER_INITIALIZE: initializeLedger ? 'true' : 'false',
    LIVE_STORY_FIXTURE_MODE: fixture ? 'true' : 'false',
  };
  let api;
  const sockets = [];
  const report = {
    ...plan,
    mode: fixture ? 'zero-network-rehearsal' : 'approved-live',
    runId,
    status: 'not_started',
    mechanical: [],
    quality: [],
    receipts: [],
  };
  async function child(file) {
    const p = spawn(process.execPath, [file], {
      cwd: root,
      env: {
        ...env,
        NPC_AI_API_KEY: undefined,
        NPC_AI_PROVIDER: 'mock',
        NPC_AI_EXTERNAL_APPROVED: 'false',
        NPC_AI_CAP_MICROS: '0',
        NPC_AI_UPPER_MICROS: '0',
      },
      stdio: 'ignore',
    });
    if ((await once(p, 'exit'))[0] !== 0) throw Error('ISOLATED_BOOTSTRAP_FAILED');
  }
  async function until(read, predicate, ms = 65000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const result = await read();
      if (predicate(result)) return result;
      await delay(150);
    }
    throw Error('EVALUATION_TIMEOUT_NO_RETRY');
  }
  function user() {
    let cookie = '';
    return {
      handle: '',
      async request(path, body, method = body === undefined ? 'GET' : 'POST') {
        const r = await fetch(base + path, {
          method,
          headers: { origin, 'content-type': 'application/json', cookie },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        const cookies = r.headers.getSetCookie();
        if (cookies.length) cookie = cookies.map((x) => x.split(';')[0]).join('; ');
        const value = await r.json();
        if (!r.ok)
          throw Error(`LOCAL_API_${r.status}_${String(value.code ?? 'FAILED').slice(0, 80)}`);
        return value;
      },
      async connect(campaign) {
        const ws = new WebSocket(
          base.replace('http:', 'ws:') + `/game/socket?campaignId=${campaign}`,
          { headers: { origin, cookie }, handshakeTimeout: 15000 },
        );
        sockets.push(ws);
        await once(ws, 'open');
        return ws;
      },
    };
  }
  try {
    report.codeHashes = {};
    for (const file of [
      'apps/api/dist/ai/openai-provider.js',
      'apps/api/dist/ai/npc-ai.service.js',
      'apps/api/dist/game/game.service.js',
      'packages/game-core/dist/narrative.js',
      'packages/game-core/dist/living.js',
      'scripts/evaluate-live-story.mjs',
      'scripts/live-story/guard.mjs',
      'scripts/live-story/preload.mjs',
      'scripts/live-story/pg-guard.mjs',
      'scripts/live-story/key-entry.mjs',
    ]) {
      report.codeHashes[file] = createHash('sha256')
        .update(await readFile(resolve(root, file)))
        .digest('hex');
    }
    await child('apps/api/dist/migrate.js');
    await child('apps/api/dist/seed.js');
    api = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve(root, 'scripts/live-story/preload.mjs')).href,
        'apps/api/dist/main.js',
      ],
      { cwd: root, env, stdio: 'ignore' },
    );
    await until(
      () =>
        fetch(base + '/health', { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      20000,
    );
    const users = [user(), user()];
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      u.handle = `eval_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await u.request('/auth/register', {
        handle: u.handle,
        email: `${u.handle}@example.test`,
        name: `Synthetic player ${i + 1}`,
        password: `Synthetic-${randomUUID()}!`,
      });
      u.hero = await u.request('/heroes', {
        name: i ? 'Synthetic scholar' : 'Synthetic explorer',
        backstory: 'Synthetic public evaluation character.',
        notes: 'SYNTHETIC_PRIVATE_HERO_CANARY',
      });
    }
    const [host, guest] = users,
      source = await host.request('/adventures/old-observatory?view=published');
    report.sourceVersionId = source.playableVersionId;
    const { campaignId } = await host.request('/game/campaigns', {
      playableVersionId: source.playableVersionId,
      heroId: host.hero.id,
    });
    const path = (suffix) => `/game/campaigns/${campaignId}/${suffix}`,
      snapshot = (u) => u.request(path('snapshot'));
    await host.request(path('invitations'), { username: guest.handle });
    await guest.request(path('accept'), { heroId: guest.hero.id });
    for (const u of users) await u.connect(campaignId);
    const sponsor = await host.request(path('ai/sponsors'), {
      operationId: randomUUID(),
      consent: true,
      totalCredits: 0,
      perOperationCredits: 0,
      maxOperations: 2,
      totalProviderMicros: 100000,
      perOperationProviderMicros: 50000,
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      purposes: ['speech'],
    });
    async function narrative(text, revision) {
      const q = await host.request(path('narrative/quote'), {
        text,
        expectedCanonRevision: revision,
      });
      const turn = await host.request(path('narrative'), {
        text,
        expectedCanonRevision: revision,
        operationId: randomUUID(),
        quoteId: q.id,
        consent: true,
      });
      const finished = await until(
        () => host.request(path('narrative')),
        (r) => r.turns.some((t) => t.id === turn.id && t.status !== 'pending'),
      );
      const result = finished.turns.find((t) => t.id === turn.id);
      if (result.status !== 'committed') throw Error('DIRECTOR_NOT_COMMITTED_NO_REGENERATION');
      report.quality.push({
        kind: 'narrative',
        text: result.narration ?? null,
        turnId: result.id,
        rubric: 'Intent, premise consistency, causal continuity; human review required',
      });
      return result;
    }
    async function move(u, target, range = 0) {
      const s = await snapshot(u),
        a = s.projection.entities.find((e) => e.id === s.projection.actorId);
      await u.request(path('move'), {
        connectionEpoch: s.connectionEpoch,
        inputSeq: (a.lastInputSeq ?? 0) + 1,
        movementGeneration: a.movementGeneration,
        target,
      });
      await until(
        () => snapshot(u),
        (v) => {
          const e = v.projection.entities.find((x) => x.id === v.projection.actorId);
          return Math.abs(e.x - target.x) + Math.abs(e.y - target.y) <= range;
        },
        15000,
      );
    }
    const first = await narrative(
      'Продолжим исследование обсерватории: добавь одну небольшую связанную комнату и нового помощника-реставратора с собственным именем. Он не знает наших секретов. Покажи реальный проход, а не только описание.',
      0,
    );
    let view = (await snapshot(host)).projection;
    const link = view.map.exits.find((e) => e.destinationMapId === first.sceneId);
    if (!link || !first.npcId) throw Error('EXPECTED_SCENE_NPC_NOT_CREATED_NO_REGENERATION');
    for (const u of users) {
      await move(u, { x: link.x, y: link.y }, 1);
      await u.request(path('commands'), {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'action',
        action: { kind: 'transition', targetId: link.id },
      });
    }
    async function talk(text) {
      view = (await snapshot(host)).projection;
      const npc = view.entities.find((e) => e.id === first.npcId);
      if (!npc) throw Error('NPC_NOT_VISIBLE');
      const occupied = new Set(view.entities.map((e) => `${e.x},${e.y}`)),
        blocked = new Set(view.map.blocked.map((e) => `${e.x},${e.y}`));
      const tile = [
        { x: npc.x - 1, y: npc.y },
        { x: npc.x + 1, y: npc.y },
        { x: npc.x, y: npc.y - 1 },
        { x: npc.x, y: npc.y + 1 },
      ].find(
        (p) =>
          p.x > 0 &&
          p.y > 0 &&
          p.x < view.map.width - 1 &&
          p.y < view.map.height - 1 &&
          !occupied.has(`${p.x},${p.y}`) &&
          !blocked.has(`${p.x},${p.y}`),
      );
      if (tile) await move(host, tile);
      const before = (await snapshot(host)).projection.npcUtterances ?? [];
      const result = await host.request(path('commands'), {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'npc.speech',
        npcId: first.npcId,
        speech: { channel: 'say', text },
      });
      if (!result.decisionRequestId) throw Error('ORDINARY_SPEECH_NOT_QUEUED');
      const answered = await until(
        () => snapshot(host),
        (s) =>
          (s.projection.npcUtterances ?? []).some(
            (u) => u.speakerId === first.npcId && !before.some((old) => old.id === u.id),
          ),
      );
      report.quality.push({
        kind: 'npc',
        name: npc.label,
        role: npc.supportingNpc?.roleLabel,
        utterances: answered.projection.npcUtterances
          ?.filter((u) => u.speakerId === first.npcId)
          .map((u) => u.text),
        rubric: 'Identity, relevance and public episodic recall; human review required',
      });
    }
    await talk(
      'Как тебя зовут и чем ты занимаешься здесь? Мы назовём найденный сигнал «Серебряный маяк».',
    );
    await narrative(
      'Помощник уже встретил нас. Продолжи именно эту историю: исследуем «Серебряный маяк». Не заменяй существующего помощника и не переноси нас автоматически; используй уже подтверждённые события.',
      1,
    );
    await talk('Помнишь, как мы назвали сигнал в прошлом разговоре? И что мы теперь проверяем?');
    await host.request(
      path(`ai/sponsors/${sponsor.sponsors.find((s) => !s.revoked).id}`),
      undefined,
      'DELETE',
    );
    const before = (await host.request(path('narrative'))).turns.filter(
      (t) => t.status === 'committed',
    );
    for (const ws of sockets) ws.close();
    await delay(500);
    // Reload the actual API process against the same saved database and ledger,
    // not merely the same in-memory campaign behind a new browser socket.
    env.LIVE_STORY_LEDGER_INITIALIZE = 'false';
    const stopped = once(api, 'exit');
    api.kill('SIGTERM');
    const stopDeadline = setTimeout(() => api.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(stopDeadline);
    api = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve(root, 'scripts/live-story/preload.mjs')).href,
        'apps/api/dist/main.js',
      ],
      { cwd: root, env, stdio: 'ignore' },
    );
    await until(
      () =>
        fetch(base + '/health', { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      20000,
    );
    for (const u of users) await u.connect(campaignId);
    const h = await host.request(path('narrative')),
      g = await guest.request(path('narrative'));
    if (
      JSON.stringify(h.turns.filter((t) => t.status === 'committed')) !==
        JSON.stringify(g.turns.filter((t) => t.status === 'committed')) ||
      JSON.stringify(h.turns.filter((t) => t.status === 'committed')) !== JSON.stringify(before)
    )
      throw Error('SHARED_CANON_RELOAD_MISMATCH');
    report.mechanical.push(
      'Two independently authenticated players; actual connected scene and NPC; ordinary dialogue pipeline; shared canon retained after actual API restart and reconnect.',
    );
    report.status = 'mechanical_pass_quality_review_required';
  } catch (e) {
    report.status = 'stopped_no_retry';
    report.failure = String(e.message)
      .replace(/[^a-zA-Z0-9_: -]/g, '')
      .slice(0, 160);
  } finally {
    for (const ws of sockets) ws.terminate();
    if (api && api.exitCode === null) {
      const done = once(api, 'exit');
      api.kill('SIGTERM');
      const kill = setTimeout(() => api.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(kill);
    }
    try {
      const { readPgStoryLedger } = await import('./live-story/pg-guard.mjs');
      report.receipts = (await readPgStoryLedger(env.DATABASE_URL))?.attempts ?? [];
    } catch {
      report.receipts = [];
    }
    await pg.stop();
    if (
      report.status === 'mechanical_pass_quality_review_required' &&
      (report.receipts.length !== 4 ||
        report.receipts.some((a) => a.state !== 'known') ||
        report.receipts.filter((a) => a.purpose === 'narrative').length !== 2 ||
        report.receipts.filter((a) => a.purpose === 'speech').length !== 2)
    ) {
      report.status = 'stopped_no_retry';
      report.failure = 'EXPECTED_FOUR_ACTUAL_PROVIDER_RECEIPTS';
    }
    if (JSON.stringify(report.quality).includes('SYNTHETIC_PRIVATE_HERO_CANARY')) {
      report.status = 'stopped_no_retry';
      report.failure = 'PRIVATE_HERO_LEAK';
    }
    const reportPath = resolve(ledger, '../report.json');
    await mkdir(resolve(ledger, '..'), { recursive: true, mode: 0o700 });
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({ status: report.status, reportPath, requests: report.receipts.length }),
    );
    if (report.status === 'stopped_no_retry') process.exitCode = 1;
  }
}
