import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { startState } from '../../apps/web/components/game/start-state.ts';
import { mapPlanningMessage } from '../../apps/web/components/game/map-planning-message.ts';
import {
  createUnpaidFixtureCampaign,
  setUnpaidFixtureLocale,
  readUnpaidFixtureCampaign,
} from '../e2e/support/unpaid-fixture-campaign.ts';
import { providerSparkSubunits } from '../../apps/web/components/visual-authoring/spark-equivalent.ts';
import { LaunchGate } from '../../apps/web/components/home/launch-gate.ts';
class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const prepared = { id: 'prep', status: 'prepared', reused: false, campaignId: null, jobs: [] };
test('terminal jobs never suggest a new paid attempt before settlement', () => {
  for (const status of ['failed', 'rejected', 'stale', 'cancelled']) {
    for (const sparkStatus of [undefined, null, 'pending', 'held', 'reserved', 'captured'])
      assert.equal(startState({ ...prepared, jobs: [{ status, sparkStatus }] }), 'review');
    for (const sparkStatus of ['released', 'settled'])
      assert.equal(startState({ ...prepared, jobs: [{ status, sparkStatus }] }), 'failed');
  }
  assert.equal(
    startState({ ...prepared, jobs: [{ status: 'unknown', sparkStatus: 'pending' }] }),
    'unknown',
  );
  assert.equal(startState(prepared, true), 'checking');
});
async function harness(
  transport,
  saved = new Map(),
  selection = { heroId: '', ready: true, body: {} },
  client = { user: { id: 'u' }, loading: false },
  director = { profileId: 'coauthor', ready: true },
  saves = { data: { userId: 'u', adventureId: 'a', campaigns: [] }, loading: false },
) {
  const source = await readFile(
    new URL('../../apps/web/components/game/adventure-launch.tsx', import.meta.url),
    'utf8',
  );
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const cells = [],
    effects = [],
    timers = new Map(),
    gate = new LaunchGate(),
    paths = [],
    directorBindings = new Map();
  let cursor = 0,
    tree,
    timer = 0;
  const jsx = (type, props) => ({ type, props });
  const imports = {
    './map-image-notice': { MapImageNotice: 'MapImageNotice' },
    './map-planning-message': { mapPlanningMessage },
    '../visual-authoring/spark-equivalent': { providerSparkSubunits },
    react: {
      useState(initial) {
        const n = cursor++;
        cells[n] ??= { value: initial };
        return [
          cells[n].value,
          (value) => {
            cells[n].value = typeof value === 'function' ? value(cells[n].value) : value;
          },
        ];
      },
      useEffect(fn, deps) {
        const n = cursor++,
          old = cells[n];
        if (!old || deps.some((d, i) => d !== old.deps[i])) {
          cells[n] = { deps };
          effects.push(() => {
            old?.cleanup?.();
            cells[n].cleanup = fn();
          });
        }
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../story-return': { storyReturnPath: () => '/story', withStoryReturn: () => '/login' },
    './hero-selection': {
      HeroSelection: 'hero',
      useHeroSelection: () => selection,
    },
    './director-selection': {
      DirectorSelection: 'director',
      useDirectorSelection: (_scope, key) => {
        if (!directorBindings.has(key)) {
          const pinnedId = saved.get(key + ':director') || '';
          const legacy =
            !pinnedId && (saved.has(key + ':prepare') || saved.has(key + ':dispatch-pending'));
          directorBindings.set(key, { pinnedId: pinnedId || (legacy ? 'coauthor' : ''), legacy });
        }
        const binding = directorBindings.get(key);
        const profileId = binding.pinnedId || director.profileId;
        return {
          profileId,
          hydrated: true,
          ready: director.ready,
          legacy: binding.legacy,
          locked: !!binding.pinnedId,
          resource: { reload() {} },
          lock() {
            if (binding.pinnedId) return;
            binding.pinnedId = profileId;
            saved.set(key + ':director', profileId);
          },
          releaseCompleted() {
            binding.pinnedId = '';
            binding.legacy = false;
            saved.delete(key + ':director');
          },
          unlock() {
            if (binding.legacy) return;
            binding.pinnedId = '';
            saved.delete(key + ':director');
          },
          setProfileId(id) {
            if (!binding.pinnedId) director.profileId = id;
          },
        };
      },
    },
    './use-launch-gate': {
      useLaunchGate: (key) => {
        gate.select(key);
        return gate;
      },
    },
    './start-state': { startState },
    'next/link': 'link',
    'next/navigation': { useRouter: () => ({ push: (path) => paths.push(path) }) },
    '@dreamwalk/contracts': { formatSparkSubunits: String, selectAdventureText: (a) => a },
    '@/lib/client': {
      ApiError,
      coverUrl: () => '/images/observatory.webp',
      api: transport,
      errorMessage: (e) => e.message,
      useClient: () => client,
      useResource: (path) => (path?.startsWith('/game/campaigns?') ? saves : { loading: false }),
    },
    '@/lib/i18n': { useT: () => ({ t: (s) => s, taxonomy: (s) => s }) },
    '@/components/ui': {
      Button: 'button',
      ErrorBox: 'error',
      Modal: 'modal',
      Field: 'field',
      Select: 'select',
    },
  };
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'sessionStorage',
    'crypto',
    'setTimeout',
    'clearTimeout',
    code,
  )(
    (name) => {
      assert.ok(name in imports, name);
      return imports[name];
    },
    module,
    module.exports,
    {
      getItem: (k) => saved.get(k) ?? null,
      setItem: (k, v) => saved.set(k, v),
      removeItem: (k) => saved.delete(k),
    },
    { randomUUID: () => 'op' },
    (fn) => {
      timers.set(++timer, fn);
      return timer;
    },
    (id) => timers.delete(id),
  );
  const nodes = (node = tree) =>
    !node || typeof node !== 'object'
      ? []
      : [
          node,
          ...[]
            .concat(node.props?.children ?? [])
            .flatMap((child) => (child == null ? [] : nodes(child))),
        ];
  function render() {
    cursor = 0;
    tree = module.exports.AdventureLaunch({
      adventure: { id: 'a', slug: 'story', visibility: 'public', playableVersionId: 'v' },
    });
    while (effects.length) effects.shift()();
  }
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    render();
  };
  return {
    render,
    flush,
    paths,
    dispose: () => gate.dispose(),
    saved,
    timers,
    nodes,
    click: async (label) => {
      const b = nodes().find((n) => n.type === 'button' && n.props.children === label);
      assert.ok(b, label);
      b.props.onClick();
      await flush();
    },
    tick: async () => {
      const fn = timers.values().next().value;
      assert.ok(fn);
      timers.clear();
      fn();
      await flush();
    },
  };
}
const quote = {
  id: 'quote',
  expiresAt: '2099-01-01',
  sparks: { reserveSubunits: '100' },
  estimatedTotalMicros: 50,
};
test('estimate requires explicit consent; queued result polls GET then opens game', async () => {
  const calls = [];
  let dispatched = false,
    ready = false;
  const h = await harness(async (path, options = {}) => {
    calls.push([path, options.method ?? 'GET']);
    if (path.endsWith('/quote')) return quote;
    if (path.endsWith('/dispatch')) {
      dispatched = true;
      return { ...prepared, jobs: [{ status: 'queued' }] };
    }
    if (path === '/game/campaigns') return { campaignId: 'game' };
    if (dispatched && ready) return { ...prepared, status: 'ready' };
    return prepared;
  });
  h.render();
  await h.click('Начать прохождение');
  assert.equal(dispatched, false);
  assert.equal(h.nodes().filter((n) => n.type === 'button').length, 1);
  await h.click('Подтвердить и начать');
  assert.equal(dispatched, true);
  ready = true;
  await h.tick();
  assert.deepEqual(h.paths, ['/game/game']);
  assert.equal(calls.filter(([p]) => p.endsWith('/dispatch')).length, 1);
});
test('incomplete response with pending receipt shows failure and only status action', async () => {
  const h = await harness(async (path) =>
    path.endsWith('/quote')
      ? quote
      : path.endsWith('/dispatch')
        ? {
            ...prepared,
            jobs: [{ status: 'failed', error_code: 'PROVIDER_INCOMPLETE', sparkStatus: 'pending' }],
          }
        : prepared,
  );
  h.render();
  await h.click('Начать прохождение');
  await h.click('Подтвердить и начать');
  const buttons = h.nodes().filter((n) => n.type === 'button');
  assert.deepEqual(
    buttons.map((n) => n.props.children),
    ['Проверить состояние'],
  );
  assert.ok(h.nodes().some((n) => String(n.props.children).startsWith('Подготовка не удалась.')));
  assert.equal(h.timers.size, 0);
});
test('lost dispatch response preserves uncertainty across reload and never auto-dispatches', async () => {
  const saved = new Map(),
    calls = [];
  const transport = async (path, options = {}) => {
    calls.push([path, options.method ?? 'GET']);
    if (path.endsWith('/quote')) return quote;
    if (path.endsWith('/dispatch')) throw Error('offline');
    return prepared;
  };
  const h = await harness(transport, saved);
  h.render();
  await h.click('Начать прохождение');
  await h.click('Подтвердить и начать');
  assert.equal(saved.get('dreamwalk-start:u:v::coauthor:dispatch-pending'), 'yes');
  const restored = await harness(transport, saved);
  restored.render();
  await restored.flush();
  assert.deepEqual(
    restored
      .nodes()
      .filter((n) => n.type === 'button')
      .map((n) => n.props.children),
    ['Проверить состояние'],
  );
  assert.equal(calls.filter(([p]) => p.endsWith('/dispatch')).length, 1);
});
test('double confirmation cannot dispatch twice and pending request keeps a single action', async () => {
  let release,
    dispatches = 0;
  const h = await harness(async (path) => {
    if (path.endsWith('/quote')) return quote;
    if (path.endsWith('/dispatch')) {
      dispatches++;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return prepared;
  });
  h.render();
  await h.click('Начать прохождение');
  const click = h
    .nodes()
    .find((n) => n.type === 'button' && n.props.children === 'Подтвердить и начать').props.onClick;
  click();
  click();
  await h.flush();
  assert.equal(dispatches, 1);
  assert.equal(h.nodes().filter((n) => n.type === 'button').length, 1);
  release({ ...prepared, jobs: [{ status: 'unknown', sparkStatus: 'pending' }] });
  await h.flush();
  assert.deepEqual(
    h
      .nodes()
      .filter((n) => n.type === 'button')
      .map((n) => n.props.children),
    ['Проверить состояние'],
  );
  assert.equal(h.timers.size, 0);
});
test('polling network error leaves a usable read-only retry action', async () => {
  let dispatched = false,
    failRead = true;
  const h = await harness(async (path) => {
    if (path.endsWith('/quote')) return quote;
    if (path.endsWith('/dispatch')) {
      dispatched = true;
      return { ...prepared, jobs: [{ status: 'queued' }] };
    }
    if (dispatched && failRead) throw Error('offline');
    if (dispatched) return { ...prepared, status: 'started', campaignId: 'game' };
    return prepared;
  });
  h.render();
  await h.click('Начать прохождение');
  await h.click('Подтвердить и начать');
  await h.tick();
  const button = h.nodes().find((n) => n.type === 'button');
  assert.equal(button.props.children, 'Проверить состояние');
  assert.equal(button.props.disabled, false);
  assert.equal(button.props.busy, false);
  failRead = false;
  await h.click('Проверить состояние');
  assert.deepEqual(h.paths, ['/game/game']);
});
test('restore waits for saved hero loading then resumes without new dispatch', async () => {
  const calls = [],
    selection = { heroId: 'hero', ready: false, body: { heroId: 'hero' } };
  const saved = new Map([
    ['dreamwalk-start:u:v:hero:prepare', 'op'],
    ['dreamwalk-start:u:v:hero:dispatch-pending', 'yes'],
  ]);
  const h = await harness(
    async (path) => {
      calls.push(path);
      return { ...prepared, jobs: [{ status: 'failed', sparkStatus: 'pending' }] };
    },
    saved,
    selection,
  );
  h.render();
  await h.flush();
  assert.equal(calls.length, 0);
  selection.ready = true;
  h.render();
  await h.flush();
  assert.deepEqual(calls, ['/game/start-preparations/by-operation/op']);
  assert.ok(h.nodes().some((n) => String(n.props.children).startsWith('Подготовка не удалась.')));
});
test('primary action stays disabled throughout auth and existing-operation restoration', async () => {
  const client = { user: null, loading: true },
    selection = { heroId: '', ready: true, body: {} };
  let release;
  const saved = new Map([['dreamwalk-start:u:v::prepare', 'op']]);
  const h = await harness(
    async (path) => {
      if (path === '/game/start-preparations/by-operation/op')
        return new Promise((resolve) => {
          release = resolve;
        });
      return prepared;
    },
    saved,
    selection,
    client,
  );
  h.render();
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
  client.user = { id: 'u' };
  client.loading = false;
  h.render();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
  release(prepared);
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, false);
  assert.equal(h.paths.length, 0);
});
test('new hero restoration resumes after an old selection request finishes', async () => {
  const selection = { heroId: 'a', ready: true, body: { heroId: 'a' } },
    calls = [];
  const saved = new Map([
    ['dreamwalk-start:u:v:a:prepare', 'op-a'],
    ['dreamwalk-start:u:v:b:prepare', 'op-b'],
  ]);
  let release;
  const h = await harness(
    async (path) => {
      if (path.startsWith('/game/start-preparations/by-operation/')) {
        const hero = path.endsWith('op-a') ? 'a' : 'b';
        calls.push(hero);
        if (hero === 'a')
          return new Promise((resolve) => {
            release = resolve;
          });
      }
      return prepared;
    },
    saved,
    selection,
  );
  h.render();
  await h.flush();
  assert.deepEqual(calls, ['a']);
  selection.heroId = 'b';
  selection.body = { heroId: 'b' };
  h.render();
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
  release(prepared);
  await h.flush();
  await h.flush();
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, false);
  assert.deepEqual(h.paths, []);
});

test('unpaid browser fixture retries only an explicitly rejected rate-limit request once', async () => {
  const calls = [],
    waits = [];
  const rejected = {
    status: () => 429,
    json: async () => ({ code: 'RATE_LIMITED', retryable: true }),
  };
  const accepted = { status: () => 201 };
  const result = await createUnpaidFixtureCampaign(
    {
      post: async (path, body) => {
        calls.push([path, body]);
        return calls.length === 1 ? rejected : accepted;
      },
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(result, accepted);
  assert.deepEqual(waits, [61000]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    '/api/v1/game/campaigns',
    { data: { template: 'observatory-v1', turnBased: true } },
  ]);
  let count = 0;
  const stillLimited = await createUnpaidFixtureCampaign(
    {
      post: async () => {
        count++;
        return rejected;
      },
    },
    async () => {},
  );
  assert.equal(stillLimited, rejected);
  assert.equal(count, 2);
});
test('unpaid fixture never retries uncertain failures, server errors, or nonretryable limits', async () => {
  for (const status of [201, 500, 503, 429]) {
    let calls = 0;
    const response = {
      status: () => status,
      json: async () => ({ code: 'RATE_LIMITED', retryable: false }),
    };
    assert.equal(
      await createUnpaidFixtureCampaign(
        {
          post: async () => {
            calls++;
            return response;
          },
        },
        async () => assert.fail('must not wait'),
      ),
      response,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    createUnpaidFixtureCampaign(
      {
        post: async () => {
          calls++;
          throw Error('connection lost');
        },
      },
      async () => assert.fail('must not wait'),
    ),
    /connection lost/,
  );
  assert.equal(calls, 1);
});

test('locale fixture recovery is restricted to settings and read-only campaign resources', async () => {
  for (const resource of ['settings', 'snapshot', 'turns/feed']) {
    const calls = [],
      waits = [];
    const accepted = { status: () => 200 };
    const invoke = async (...args) => {
      calls.push(args);
      return calls.length === 1
        ? { status: () => 429, json: async () => ({ code: 'RATE_LIMITED', retryable: true }) }
        : accepted;
    };
    const wait = async (ms) => waits.push(ms);
    const result =
      resource === 'settings'
        ? await setUnpaidFixtureLocale({ patch: invoke }, 'uk', wait)
        : await readUnpaidFixtureCampaign({ get: invoke }, 'fixture', resource, wait);
    assert.equal(result, accepted);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(waits, [61000]);
    assert.equal(
      calls[0][0],
      resource === 'settings'
        ? '/api/v1/account/settings'
        : `/api/v1/game/campaigns/fixture/${resource}`,
    );
    if (resource === 'settings') assert.deepEqual(calls[0][1], { data: { language: 'uk' } });
  }
});

for (const code of [
  'GENERATION_POLICY_CHANGED',
  'AUTHORING_QUOTE_EXPIRED',
  'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
])
  test(`definite stale quote rejection ${code} requires a fresh estimate and consent`, async () => {
    let quotes = 0,
      dispatches = 0;
    const h = await harness(async (path) => {
      if (path.endsWith('/quote')) return { ...quote, id: `quote-${++quotes}` };
      if (path.endsWith('/dispatch')) {
        dispatches++;
        if (dispatches === 1) throw new ApiError('Get a new estimate', 409, code);
        return { ...prepared, jobs: [{ status: 'queued' }] };
      }
      return prepared;
    });
    h.render();
    await h.click('Начать прохождение');
    await h.click('Подтвердить и начать');
    assert.equal(h.saved.has('dreamwalk-start:u:v::coauthor:dispatch-pending'), false);
    assert.equal(dispatches, 1);
    assert.equal(quotes, 1);
    assert.equal(h.timers.size, 0);
    await h.click('Начать прохождение');
    assert.equal(quotes, 2);
    assert.equal(dispatches, 1, 'fresh estimate must not dispatch without renewed consent');
    await h.click('Подтвердить и начать');
    assert.equal(dispatches, 2);
  });
for (const error of [
  new ApiError('unknown outcome', 409, 'PROVIDER_OUTCOME_UNKNOWN'),
  new ApiError('server failed', 500, 'GENERATION_POLICY_CHANGED'),
  Object.assign(new Error('untrusted error shape'), {
    status: 409,
    code: 'GENERATION_POLICY_CHANGED',
  }),
])
  test(`uncertain dispatch preserves guard: ${error.message}`, async () => {
    const h = await harness(async (path) => {
      if (path.endsWith('/quote')) return quote;
      if (path.endsWith('/dispatch')) throw error;
      return prepared;
    });
    h.render();
    await h.click('Начать прохождение');
    await h.click('Подтвердить и начать');
    assert.equal(h.saved.get('dreamwalk-start:u:v::coauthor:dispatch-pending'), 'yes');
    assert.ok(
      h.nodes().some((n) => n.type === 'button' && n.props.children === 'Проверить состояние'),
    );
  });

test('schematic fallback is disclosed in the existing estimate without another confirmation or dispatch', async () => {
  let dispatches = 0;
  const h = await harness(async (path) => {
    if (path.endsWith('/quote')) return { ...quote, imageInputCount: 0, schematicMapCount: 1 };
    if (path.endsWith('/dispatch')) dispatches++;
    return prepared;
  });
  h.render();
  await h.click('Начать прохождение');
  const notice = h.nodes().find((node) => node.type === 'MapImageNotice');
  assert.equal(notice.props.schematicCount, 1);
  assert.equal(notice.props.count, 0);
  assert.equal(dispatches, 0);
});

test('a stale never-dispatched preparation can be replaced with a fresh estimate after a mode change', async () => {
  let attempts = 0,
    quotes = 0,
    dispatches = 0;
  const saved = new Map([['dreamwalk-start:u:v::prepare', 'old-operation']]);
  const h = await harness(async (path) => {
    if (path === '/game/start-preparations' && ++attempts === 1)
      throw new ApiError('Source changed safely', 409, 'START_PREPARATION_STALE');
    if (path.endsWith('/quote')) {
      quotes++;
      return quote;
    }
    if (path.endsWith('/dispatch')) dispatches++;
    return prepared;
  }, saved);
  h.render();
  await h.flush();
  assert.equal(saved.has('dreamwalk-start:u:v::prepare'), true);
  assert.equal(attempts, 0);
  await h.click('Начать прохождение');
  assert.equal(saved.has('dreamwalk-start:u:v::prepare'), false);
  await h.click('Начать прохождение');
  assert.equal(attempts, 2);
  assert.equal(quotes, 1);
  assert.equal(dispatches, 0);
});

for (const status of ['ready', 'started', 'queued', 'dispatched', 'unknown']) {
  test(`revisit ${status} restores with GET only and never enters without a new click`, async () => {
    const calls = [];
    let current = {
      ...prepared,
      status: ['ready', 'started'].includes(status) ? status : 'prepared',
      campaignId: status === 'started' ? 'existing' : null,
      jobs: ['queued', 'dispatched', 'unknown'].includes(status) ? [{ status }] : [],
    };
    const h = await harness(
      async (path, options = {}) => {
        calls.push([path, options.method ?? 'GET']);
        if (path === '/game/campaigns') return { campaignId: 'new' };
        return current;
      },
      new Map([['dreamwalk-start:u:v::prepare', 'legacy-operation']]),
    );
    h.render();
    await h.flush();
    assert.deepEqual(calls, [['/game/start-preparations/by-operation/legacy-operation', 'GET']]);
    assert.deepEqual(h.paths, []);
    assert.equal(h.nodes().filter((n) => n.type === 'modal').length, 0);
    if (['queued', 'dispatched'].includes(status)) {
      current = { ...prepared, status: 'ready' };
      await h.tick();
      assert.deepEqual(h.paths, []);
      assert.ok(calls.every(([, method]) => method === 'GET'));
    }
    if (status === 'unknown') {
      assert.equal(h.timers.size, 0);
      await h.click('Проверить состояние');
      assert.deepEqual(h.paths, []);
      assert.ok(calls.every(([, method]) => method === 'GET'));
    } else if (status === 'started') {
      await h.flush();
      assert.equal(h.nodes().find((n) => n.type === 'link').props.href, '/game/existing');
      assert.equal(h.saved.has('dreamwalk-start:u:v::prepare'), false);
      assert.deepEqual(h.paths, []);
      assert.ok(h.nodes().some((n) => n.type === 'button' && n.props.children === 'Начать заново'));
    } else {
      await h.click('Открыть игру');
      assert.deepEqual(h.paths, ['/game/new']);
      assert.equal(
        calls.filter(([, method]) => method === 'POST').length,
        status === 'started' ? 0 : 1,
      );
    }
  });
}
test('missing legacy operation and uncertain dispatch remain read-only on reload and polling', async () => {
  const calls = [];
  const h = await harness(
    async (path, options = {}) => {
      calls.push([path, options.method ?? 'GET']);
      return null;
    },
    new Map([
      ['dreamwalk-start:u:v::prepare', 'legacy-operation'],
      ['dreamwalk-start:u:v::dispatch-pending', 'yes'],
    ]),
  );
  h.render();
  await h.flush();
  await h.tick();
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.deepEqual(h.paths, []);
  assert.equal(h.saved.get('dreamwalk-start:u:v::dispatch-pending'), 'yes');
  assert.equal(h.nodes().filter((n) => n.type === 'modal').length, 0);
});

test('leaving during a status read prevents campaign creation and navigation', async () => {
  let release;
  const calls = [];
  const h = await harness(
    async (path, options = {}) => {
      calls.push([path, options.method ?? 'GET']);
      if (path.startsWith('/game/start-preparations/by-operation/'))
        return new Promise((resolve) => {
          release = resolve;
        });
      assert.fail('No other request is allowed after leaving');
    },
    new Map([['dreamwalk-start:u:v::prepare', 'legacy-operation']]),
  );
  h.render();
  h.dispose();
  release({ ...prepared, status: 'ready' });
  await h.flush();
  assert.deepEqual(h.paths, []);
  assert.equal(calls.length, 1);
});

test('selected director binds preparation, campaign and operation identity without changing paid consent', async () => {
  const calls = [];
  const h = await harness(
    async (path, options = {}) => {
      calls.push([path, options.body ? JSON.parse(options.body) : null]);
      if (path === '/game/campaigns') return { campaignId: 'with-director' };
      return { ...prepared, status: 'ready', directorProfileId: 'storyteller' };
    },
    new Map(),
    { heroId: '', ready: true, body: {} },
    { user: { id: 'u' }, loading: false },
    { profileId: 'storyteller', ready: true },
  );
  h.render();
  await h.click('Начать прохождение');
  assert.equal(
    calls.find(([path]) => path === '/game/start-preparations')[1].directorProfileId,
    'storyteller',
  );
  assert.equal(
    calls.find(([path]) => path === '/game/campaigns')[1].directorProfileId,
    'storyteller',
  );
  assert.equal(h.saved.get('dreamwalk-start:u:v::director'), 'storyteller');
  assert.equal(h.saved.get('dreamwalk-start:u:v::storyteller:prepare'), 'op');
  assert.deepEqual(h.paths, ['/game/with-director']);
  assert.equal(
    calls.some(([path]) => path.endsWith('/dispatch')),
    false,
  );
});

test('failed catalog load blocks a new start instead of silently choosing the default', async () => {
  const calls = [];
  const h = await harness(
    async (path) => {
      calls.push(path);
      return prepared;
    },
    new Map(),
    { heroId: '', ready: true, body: {} },
    { user: { id: 'u' }, loading: false },
    { profileId: '', ready: false },
  );
  h.render();
  assert.equal(h.nodes().find((node) => node.type === 'button').props.disabled, true);
  await h.click('Начать прохождение');
  assert.deepEqual(calls, []);
});

test('pinned director cannot switch operation identity while dispatch is uncertain', async () => {
  let dispatches = 0;
  const h = await harness(
    async (path) => {
      if (path.endsWith('/quote')) return quote;
      if (path.endsWith('/dispatch')) {
        dispatches++;
        throw Error('offline');
      }
      return { ...prepared, directorProfileId: 'storyteller' };
    },
    new Map(),
    { heroId: '', ready: true, body: {} },
    { user: { id: 'u' }, loading: false },
    { profileId: 'storyteller', ready: true },
  );
  h.render();
  await h.click('Начать прохождение');
  await h.click('Подтвердить и начать');
  const selector = h.nodes().find((node) => node.type === 'director');
  assert.equal(selector.props.locked, true);
  selector.props.selection.setProfileId('director');
  h.render();
  assert.equal(
    h.nodes().find((node) => node.type === 'director').props.selection.profileId,
    'storyteller',
  );
  assert.equal(h.saved.get('dreamwalk-start:u:v::storyteller:dispatch-pending'), 'yes');
  assert.equal(dispatches, 1);
});

test('a replaced legacy preparation preserves its director parameter on later reload replay', async () => {
  const saved = new Map([['dreamwalk-start:u:v::prepare', 'legacy-operation']]);
  const bodies = [];
  let rejectLegacy = true;
  const transport = async (path, options = {}) => {
    if (path === '/game/start-preparations') {
      bodies.push(JSON.parse(options.body));
      if (rejectLegacy) {
        rejectLegacy = false;
        throw new ApiError('source changed', 409, 'START_PREPARATION_STALE');
      }
    }
    if (path.endsWith('/quote')) return quote;
    return { ...prepared, directorProfileId: 'coauthor' };
  };
  const h = await harness(transport, saved);
  h.render();
  await h.flush();
  await h.click('Начать прохождение');
  await h.click('Начать прохождение');
  assert.equal(bodies[0].directorProfileId, undefined, 'old operation retains its original shape');
  assert.equal(bodies[1].directorProfileId, 'coauthor', 'new operation pins its profile');
  assert.equal(saved.get('dreamwalk-start:u:v::director-included'), 'yes');
  const restored = await harness(transport, saved);
  restored.render();
  await restored.flush();
  await restored.click('Начать прохождение');
  assert.deepEqual(bodies[2], bodies[1], 'replay uses the identical operation and profile');
});

test('story saves continue directly across revisions and new playthrough keeps billing consent', async () => {
  const calls = [];
  const saves = {
    data: {
      userId: 'u',
      adventureId: 'a',
      campaigns: [
        { id: 'recent', playableVersionId: 'older-revision', updatedAt: '2026-11-05T03:00:00Z' },
        { id: 'earlier', playableVersionId: 'v' },
      ],
    },
    loading: false,
  };
  const h = await harness(
    async (path, options = {}) => {
      calls.push([path, options.method ?? 'GET']);
      return path.endsWith('/quote') ? quote : prepared;
    },
    undefined,
    undefined,
    undefined,
    undefined,
    saves,
  );
  h.render();
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'link').props.href, '/game/recent');
  assert.equal(h.nodes().find((n) => n.type === 'link').props.className, 'button primary');
  assert.equal(
    h.nodes().find((n) => n.type === 'select').props['aria-label'],
    'Сохранённое прохождение',
  );
  h.nodes()
    .find((n) => n.type === 'select')
    .props.onChange({ target: { value: 'earlier' } });
  h.render();
  assert.equal(h.nodes().find((n) => n.type === 'link').props.href, '/game/earlier');
  assert.deepEqual(calls, [], 'continuation is a link, never a prepare or generation call');
  await h.click('Начать заново');
  assert.ok(h.nodes().some((n) => n.type === 'modal'));
  assert.ok(calls.every(([path]) => !path.endsWith('/dispatch')));
  assert.deepEqual(h.paths, []);
  assert.equal(saves.data.campaigns.length, 2);
});

test('completed preparation retires only its local identity before a genuinely independent start', async () => {
  const saved = new Map([
    ['dreamwalk-start:u:v::coauthor:prepare', 'completed-operation'],
    ['dreamwalk-start:u:v::director', 'coauthor'],
    ['dreamwalk-start:u:another-version::coauthor:prepare', 'unrelated-operation'],
  ]);
  const calls = [];
  const h = await harness(async (path, options = {}) => {
    calls.push([path, options.method ?? 'GET', options.body && JSON.parse(options.body)]);
    if (path.endsWith('/completed-operation'))
      return { ...prepared, status: 'started', campaignId: 'old-save' };
    if (path === '/game/campaigns') return { campaignId: 'new-save' };
    return { ...prepared, id: 'new-preparation', status: 'ready', reused: true };
  }, saved);
  h.render();
  await h.flush();
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'link').props.href, '/game/old-save');
  assert.equal(h.nodes().find((n) => n.type === 'director').props.locked, false);
  assert.deepEqual(h.paths, []);
  assert.ok(calls.every(([, method]) => method === 'GET'));
  await h.click('Начать заново');
  const body = calls.find(([path]) => path === '/game/start-preparations')[2];
  assert.notEqual(body.operationId, 'completed-operation');
  assert.equal(body.directorProfileId, 'coauthor');
  assert.deepEqual(h.paths, ['/game/new-save']);
  assert.equal(
    saved.get('dreamwalk-start:u:another-version::coauthor:prepare'),
    'unrelated-operation',
  );
  assert.equal(calls.filter(([path]) => path === '/game/campaigns').length, 1);
  assert.ok(calls.every(([, method]) => !['DELETE', 'PATCH'].includes(method)));
});

test('failed restoration exposes only read-only recovery, not a mislabeled fresh launch', async () => {
  const saved = new Map([['dreamwalk-start:u:v::prepare', 'uncertain-operation']]);
  const calls = [];
  let failRead = true;
  const h = await harness(async (path, options = {}) => {
    calls.push([path, options.method ?? 'GET']);
    if (failRead) throw Error('offline');
    return { ...prepared, status: 'started', campaignId: 'recovered-save' };
  }, saved);
  h.render();
  await h.flush();
  assert.equal(h.nodes().find((n) => n.type === 'button').props.children, 'Проверить состояние');
  assert.equal(saved.get('dreamwalk-start:u:v::prepare'), 'uncertain-operation');
  failRead = false;
  await h.click('Проверить состояние');
  await h.flush();
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.equal(h.nodes().find((n) => n.type === 'link').props.href, '/game/recovered-save');
  assert.deepEqual(h.paths, []);
});

test('save loading blocks a new start and stale account/story data never provides continuation', async () => {
  const saves = {
    data: { userId: 'other', adventureId: 'a', campaigns: [{ id: 'private-save' }] },
    loading: true,
  };
  const h = await harness(
    async () => {
      throw Error('No mutation expected');
    },
    undefined,
    undefined,
    undefined,
    undefined,
    saves,
  );
  h.render();
  await h.flush();
  assert.equal(h.nodes().filter((n) => n.type === 'link').length, 0);
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
  saves.data.userId = 'u';
  saves.data.adventureId = 'other-story';
  saves.loading = false;
  h.render();
  assert.equal(h.nodes().filter((n) => n.type === 'link').length, 0);
  assert.equal(h.nodes().find((n) => n.type === 'button').props.disabled, true);
});

test('map planning failures explain the established category without inventing an image cause', () => {
  for (const locale of ['ru', 'en', 'uk']) {
    const uncertain = mapPlanningMessage('MAP_IMAGE_UNCERTAIN', locale);
    const placement = mapPlanningMessage('MAP_IMAGE_UNSAFE_NPC', locale);
    const mismatch = mapPlanningMessage('MAP_IMAGE_SOURCE_MISMATCH', locale);
    const missing = mapPlanningMessage('MAP_IMAGE_UNAVAILABLE', locale);
    assert.equal(new Set([uncertain, placement, mismatch, missing]).size, 4);
    assert.ok(
      [uncertain, placement, mismatch, missing].every(
        (text) => typeof text === 'string' && text.length > 20,
      ),
    );
    assert.equal(mapPlanningMessage('SOMETHING_ELSE', locale), null);
    assert.equal(mapPlanningMessage(undefined, locale), null);
  }
  assert.match(mapPlanningMessage('MAP_IMAGE_UNCERTAIN', 'en'), /positions.*confidently/);
  assert.doesNotMatch(
    mapPlanningMessage('MAP_IMAGE_UNCERTAIN', 'en'),
    /illustration|floor|courtyard|wall|water|safe spawn/i,
  );
  assert.match(mapPlanningMessage('MAP_IMAGE_UNSAFE_NPC', 'en'), /placement.*validation/);
});

test('unprepared image framing keeps location-map meaning in every locale', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/visual-authoring/image-framing-notice.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /остаётся картой локации/);
  assert.match(source, /remains the location map/);
  assert.match(source, /залишається картою локації/);
  assert.doesNotMatch(source, /illustration, not a map|Это иллюстрация|Це ілюстрація/);
});

test('unanalysed saved map consent does not promise fabricated grid positions', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/map-image-notice.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /Play starts without exact positions/);
  assert.match(source, /image analysis is not included in this estimate/);
  assert.doesNotMatch(source, /shown with its grid|показана с сеткой|показано із сіткою/);
});
