import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { LaunchGate } from '../../apps/web/components/home/launch-gate.ts';
import { dictionaries, supportedLocales } from '../../apps/web/lib/locales.ts';
const source = (path) => readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
const flatten = (node) =>
  !node || typeof node !== 'object'
    ? []
    : [
        node,
        ...[]
          .concat(node.props?.children || [])
          .flat(Infinity)
          .flatMap(flatten),
      ];
const jsx = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'fragment',
};
function evaluate(text, dependencies) {
  const code = transformSync(text, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
async function historyHarness(transport = async () => ({})) {
  const calls = [],
    navigations = [],
    states = [];
  const gate = new LaunchGate();
  const selection = { heroId: 'hero-a', ready: true, body: { heroId: 'hero-a' } };
  const resource = {
    data: {
      campaigns: [
        { id: 'old-save', membership: 'accepted', title: 'Old save' },
        { id: 'new-save', membership: 'accepted', title: 'New save' },
        { id: 'invitation', membership: 'pending', title: 'Shared save' },
      ],
    },
    loading: false,
    error: '',
    reload() {},
    setData() {},
  };
  let cursor = 0;
  const { CampaignHistory } = evaluate(await source('components/game/campaign-history.tsx'), {
    react: {
      useState(initial) {
        const i = cursor++;
        if (!(i in states)) states[i] = initial;
        return [
          states[i],
          (value) => {
            states[i] = value;
          },
        ];
      },
    },
    'react/jsx-runtime': jsx,
    'next/link': { __esModule: true, default: 'link' },
    'next/navigation': { useRouter: () => ({ push: (href) => navigations.push(href) }) },
    '@/lib/client': {
      api: async (path, options) => {
        calls.push({ path, ...options });
        return transport();
      },
      errorMessage: (error) => error.message,
    },
    '@/lib/i18n': { useT: () => ({ t: (text) => text }) },
    '@/components/ui': {
      Button: 'button',
      ButtonLink: 'link',
      Empty: 'empty',
      ErrorBox: 'error',
      Loading: 'loading',
    },
    './hero-selection': { HeroSelection: 'hero-selection', useHeroSelection: () => selection },
    './use-launch-gate': {
      useLaunchGate: (id) => {
        gate.select(id);
        return gate;
      },
    },
    './game.module.css': { default: {} },
  });
  return {
    calls,
    navigations,
    gate,
    selection,
    resource,
    render() {
      cursor = 0;
      return flatten(CampaignHistory({ resource }));
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('history keeps every save and pending invitation without creating or accepting on render', async () => {
  const harness = await historyHarness();
  for (let i = 0; i < 3; i++) {
    const nodes = harness.render();
    assert.deepEqual(
      nodes.filter((node) => node.type === 'article').map((node) => node.props['data-campaign-id']),
      ['old-save', 'new-save', 'invitation'],
    );
    assert.deepEqual(
      nodes.filter((node) => node.type === 'link').map((node) => node.props.href),
      ['/game/old-save', '/game/new-save'],
    );
    assert.equal(nodes.filter((node) => node.type === 'hero-selection').length, 1);
    assert.equal(nodes.filter((node) => node.type === 'button').length, 1);
  }
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.navigations, []);
});

test('invitation requires hero readiness and explicit click; duplicates send the original payload once', async () => {
  const pending = deferred();
  const harness = await historyHarness(() => pending.promise);
  harness.selection.ready = false;
  let button = harness.render().find((node) => node.type === 'button');
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  assert.equal(harness.calls.length, 0);
  harness.selection.ready = true;
  button = harness.render().find((node) => node.type === 'button');
  button.props.onClick();
  button.props.onClick();
  assert.deepEqual(harness.calls, [
    {
      path: '/game/campaigns/invitation/accept',
      method: 'POST',
      body: JSON.stringify({ heroId: 'hero-a' }),
    },
  ]);
  assert.equal(harness.render().find((node) => node.type === 'button').props.busy, true);
  pending.resolve();
  await settle();
  assert.deepEqual(harness.navigations, ['/game/invitation']);
});

for (const interrupted of ['unmounted', 'changed hero']) {
  test(`late invitation response does not navigate after ${interrupted}`, async () => {
    const pending = deferred();
    const harness = await historyHarness(() => pending.promise);
    harness
      .render()
      .find((node) => node.type === 'button')
      .props.onClick();
    if (interrupted === 'unmounted') harness.gate.dispose();
    else {
      harness.selection.heroId = 'hero-b';
      harness.render();
    }
    pending.resolve();
    await settle();
    assert.deepEqual(harness.navigations, []);
    assert.equal(harness.calls.length, 1);
  });
}

test('failed acceptance shows an error and allows an explicit retry, never an automatic retry', async () => {
  const harness = await historyHarness(async () => {
    throw new Error('SOURCE_ACCESS_REQUIRED');
  });
  harness
    .render()
    .find((node) => node.type === 'button')
    .props.onClick();
  await settle();
  const nodes = harness.render();
  assert.ok(
    nodes.some((node) => node.type === 'error' && node.props.message === 'SOURCE_ACCESS_REQUIRED'),
  );
  assert.equal(nodes.find((node) => node.type === 'button').props.busy, false);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.navigations, []);
});

test('history handles loading, fetch failure and empty results without a test-world launcher', async () => {
  const harness = await historyHarness();
  harness.resource.loading = true;
  assert.ok(harness.render().some((node) => node.type === 'loading'));
  harness.resource.loading = false;
  harness.resource.data = null;
  harness.resource.error = 'Fetch failed';
  let nodes = harness.render();
  assert.ok(
    nodes.some((node) => node.type === 'error' && node.props.retry === harness.resource.reload),
  );
  assert.ok(!nodes.some((node) => node.type === 'empty'));
  harness.resource.error = '';
  nodes = harness.render();
  assert.equal(nodes.find((node) => node.type === 'empty').props.action.props.href, '/explore');
  assert.deepEqual(harness.calls, []);
});

test('legacy redirect replaces history, safely preserves only hero intent, and never launches', async () => {
  const page = await source('components/game/game-page.tsx');
  const redirect = page.slice(
    page.indexOf('function LegacyGameRedirect()'),
    page.indexOf('function CampaignRoom('),
  );
  for (const heroId of [null, '', 'hero-one', 'hero&tab=history', 'javascript:alert(1)']) {
    const replaced = [],
      effects = [];
    const { LegacyGameRedirect } = evaluate(
      `import { useEffect } from 'react'; import { useRouter, useSearchParams } from 'next/navigation'; import { Loading } from '@/components/ui'; export ${redirect}`,
      {
        react: { useEffect: (effect) => effects.push(effect) },
        'react/jsx-runtime': jsx,
        'next/navigation': {
          useRouter: () => ({ replace: (href) => replaced.push(href) }),
          useSearchParams: () => ({ get: () => heroId }),
        },
        '@/components/ui': { Loading: 'loading' },
      },
    );
    assert.equal(LegacyGameRedirect().type, 'loading');
    effects.forEach((effect) => effect());
    assert.deepEqual(replaced, [
      `/explore${heroId ? `?heroId=${encodeURIComponent(heroId)}` : ''}`,
    ]);
  }
  assert.doesNotMatch(page, /CampaignLobby|observatory-v1|useDirectorSelection|Новая кампания/);
  assert.equal((page.match(/href="\/explore" className=\{`game-return/g) || []).length, 2);
  const shell = await source('components/shell.tsx');
  assert.match(shell, /href="\/explore" className="game-return"/);
  const routes = await source('app/[[...path]]/page.tsx');
  assert.match(routes, /path === '\/game'\) content = <GamePage \/>/);
  assert.match(
    routes,
    /path\.startsWith\('\/game\/'\)[\s\S]*?<Protected>[\s\S]*?<GamePage campaignId=/,
  );
  assert.match(routes, /<KnownNpcSettlementPage campaignId=/);
});

test('Library history reads all campaigns and derives tabs from URL for refresh and browser history', async () => {
  const library = await source('components/personal.tsx');
  assert.match(library, /useResource<\{ campaigns: CampaignSummary\[\] \}>\('\/game\/campaigns'\)/);
  assert.match(library, /const requestedTab = params.get\('tab'\)/);
  assert.match(library, /\['shared', 'invitations', 'playable', 'drafts', 'history'\]\.includes/);
  assert.match(library, /router.push\(`\/library\?\$\{query\}`, \{ scroll: false \}\)/);
  assert.match(library, /\['history', tr\('Прохождения'\), campaigns.data\?\.campaigns.length\]/);
  assert.match(library, /<CampaignHistory resource=\{campaigns\} \/>/);
  assert.doesNotMatch(library, /Игровые сессии появятся на следующем этапе/);
  assert.match(library, /\/explore\?heroId=\$\{encodeURIComponent\(hero.id\)\}/);
  const home = await source('components/home/home-page.tsx');
  assert.match(
    home,
    /\/explore\$\{heroSelection.heroId \? `\?heroId=\$\{encodeURIComponent\(heroSelection.heroId\)\}` : ''\}/,
  );
  const history = await source('components/game/campaign-history.tsx');
  assert.doesNotMatch(history, /observatory-v1|DirectorSelection|api\(['"]\/game\/campaigns['"]/);
  for (const key of [
    'Прохождения',
    'Открыть миры',
    'Сохранённое прохождение',
    'Принять приглашение в кампанию',
    'Продолжить приключение',
    'Пока нет сохранений',
    'Найти новый мир',
  ])
    for (const locale of supportedLocales)
      assert.ok(dictionaries[locale][key], `${locale}: ${key}`);
});

// Execute the actual Library handlers/hooks, omitting only the presentation tree.
async function libraryResponseHarness(transport) {
  const text = await source('components/personal.tsx');
  const start = text.indexOf('export function LibraryPage()');
  const end = text.indexOf('  return (\n    <div className={walletStyles.library}>', start);
  assert.ok(start >= 0 && end > start);
  const hooks = [],
    calls = [],
    navigations = [],
    notices = [],
    reloads = [];
  let cursor = 0;
  let query = 'tab=invitations&heroId=hero-a';
  const dependencies = {
    useDate: () => () => '',
    useT: () => ({ t: (value) => value, locale: 'ru' }),
    useClient: () => ({ toast: (message) => notices.push(message) }),
    useSearchParams: () => new URLSearchParams(query),
    useRouter: () => ({ push: (href) => navigations.push(href) }),
    useResource: (path) => ({ reload: () => reloads.push(path) }),
    useRef: (initial) => {
      const i = cursor++;
      hooks[i] ??= { current: initial };
      return hooks[i];
    },
    useEffect: (effect) => {
      const i = cursor++;
      hooks[i] ??= { effect, cleanup: effect() };
    },
    useState: (initial) => {
      const i = cursor++;
      hooks[i] ??= { value: initial };
      return [
        hooks[i].value,
        (value) => {
          hooks[i].value = value;
        },
      ];
    },
    api: (path, options) => {
      calls.push({ path, ...options });
      return transport();
    },
    errorMessage: (error) => error.message,
  };
  const { LibraryPage } = evaluate(
    `import { ${Object.keys(dependencies).join(', ')} } from 'harness';\n${text.slice(start, end)} return { respond, setTab, busy }; }`,
    { harness: dependencies },
  );
  return {
    calls,
    navigations,
    notices,
    reloads,
    render(next = query) {
      query = next;
      cursor = 0;
      return LibraryPage();
    },
    unmount() {
      for (const hook of hooks) hook.cleanup?.();
    },
    reactivate() {
      for (const hook of hooks) if (hook.effect) hook.cleanup = hook.effect();
    },
  };
}

for (const decision of ['accept', 'decline']) {
  test(`current private invitation ${decision} retains its explicit response and refresh`, async () => {
    const harness = await libraryResponseHarness(async () => ({}));
    await harness.render().respond('world-invitation', decision);
    assert.deepEqual(harness.calls, [
      {
        path: '/invitations/world-invitation/respond',
        method: 'POST',
        body: JSON.stringify({ decision }),
      },
    ]);
    assert.deepEqual(harness.reloads, ['/invitations', '/library']);
    assert.equal(harness.notices.length, 1);
    assert.deepEqual(
      harness.navigations,
      decision === 'accept' ? ['/library?tab=shared&heroId=hero-a'] : [],
    );
    assert.equal(harness.render().busy, null);
  });
}

for (const transition of ['unmount', 'tab click', 'Back/Forward round trip', 'reactivate']) {
  for (const failed of [false, true]) {
    test(`late private invitation ${failed ? 'failure' : 'success'} is fenced after ${transition}`, async () => {
      const pending = deferred();
      const harness = await libraryResponseHarness(async () => {
        await pending.promise;
        if (failed) throw new Error('Late failure');
        return {};
      });
      const view = harness.render();
      const response = view.respond('world-invitation', 'accept');
      assert.equal(harness.render().busy, 'world-invitation');
      if (transition === 'tab click') view.setTab('favorites');
      else if (transition === 'Back/Forward round trip') {
        harness.render('tab=favorites&heroId=hero-a');
        harness.render('tab=invitations&heroId=hero-a');
      } else {
        harness.unmount();
        if (transition === 'reactivate') harness.reactivate();
      }
      const navigations = [...harness.navigations];
      pending.resolve();
      await response;
      assert.deepEqual(harness.navigations, navigations);
      assert.deepEqual(harness.notices, []);
      assert.deepEqual(harness.reloads, []);
      assert.equal(harness.calls.length, 1);
      if (transition !== 'unmount') assert.equal(harness.render().busy, null);
    });
  }
}

test('current private invitation error remains retryable without automatic dispatch', async () => {
  let fail = true;
  const harness = await libraryResponseHarness(async () => {
    if (fail) throw new Error('SOURCE_ACCESS_REQUIRED');
    return {};
  });
  await harness.render().respond('world-invitation', 'accept');
  assert.deepEqual(harness.notices, ['SOURCE_ACCESS_REQUIRED']);
  assert.equal(harness.render().busy, null);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.navigations, []);
  fail = false;
  await harness.render().respond('world-invitation', 'accept');
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.navigations, ['/library?tab=shared&heroId=hero-a']);
});
