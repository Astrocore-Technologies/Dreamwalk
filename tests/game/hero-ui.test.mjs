import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (path) =>
  readFile(new URL(`../../apps/web/components/${path}`, import.meta.url), 'utf8');
test('hero choice travels through every campaign launch and membership acceptance', async () => {
  for (const file of [
    'home/home-page.tsx',
    'game/adventure-launch.tsx',
    'game/game-page.tsx',
    'studio/playable-map-editor.tsx',
  ]) {
    const text = await source(file);
    assert.match(text, /HeroSelection/);
    if (file === 'home/home-page.tsx') {
      assert.match(text, /storyReturnPath\(active\.slug, heroSelection\.heroId\)/);
      assert.doesNotMatch(text, /api\('\/game\/campaigns'/);
    } else assert.match(text, /heroSelection\.body/);
    assert.match(text, /heroSelection\.ready/);
    assert.match(text, /\.accepts\(lease\)/);
  }
  assert.match(
    await source('game/game-page.tsx'),
    /accept`[\s\S]*JSON\.stringify\(heroSelection\.body\)/,
  );
});
test('hero cards have a gameplay entry and private pinned data is fetched only from own scoped endpoint', async () => {
  assert.match(await source('personal.tsx'), /\/game\?heroId=\$\{encodeURIComponent\(hero\.id\)/);
  const selection = await source('game/hero-selection.tsx');
  assert.match(selection, /\/game\/campaigns\/\$\{campaignId\}\/hero/);
  assert.match(selection, /<details>/);
  assert.doesNotMatch(selection, /localStorage|\/heroes\/\$\{.*campaign/);
  for (const text of [
    'Hero for this campaign',
    'Герой для этого прохождения',
    'Герой для цього проходження',
  ])
    assert.ok(selection.includes(text));
});

test('hero portrait uses the shared paid-image flow outside the hero form and excludes notes', async () => {
  const personal = await source('personal.tsx');
  const control = await source('hero-portrait-control.tsx');
  assert.match(personal, /<\/form>\s*<HeroPortraitControl/);
  assert.match(personal, /form="hero-editor"/);
  assert.match(control, /<ImageGeneration/);
  assert.match(control, /externalOnly/);
  assert.doesNotMatch(control, /\.notes|notes:/);
  assert.match(control, /active\.current/);
  assert.match(control, /lock\.current/);
  assert.match(control, /!revision\.owned/);
  assert.match(control, /hero-portraits\/\$\{revision\.id\}\/asset/);
  assert.doesNotMatch(control, /api\([^\n]*['"]\/heroes/);
  for (const value of ['Сгенерировать арт героя', 'Generate hero art', 'Згенерувати арт героя'])
    assert.ok(control.includes(value));
});

test('hero composition scopes portrait cards and wide editor without dropping consent controls', async () => {
  const personal = await source('personal.tsx');
  const css = await source('heroes.module.css');
  assert.match(personal, /<details className={styles.appearance}>[\s\S]*?<CharacterSpriteControl/);
  assert.match(personal, /className={styles.editor}/);
  assert.match(personal, /styles.editorActions/);
  assert.match(personal, /setTraitsText\(hero.traits.join/);
  assert.match(personal, /\.filter\(Boolean\)/);
  assert.match(css, /object-position: center 25%/);
  assert.match(css, /overflow: auto/);
  assert.match(css, /max-height: 92dvh/);
});

test('expanded hero presentation reuses owned selection without commands, private notes or a second controller', async () => {
  const selection = await source('game/hero-selection.tsx');
  const launch = await source('game/adventure-launch.tsx');
  const view = selection.slice(
    selection.indexOf('export function HeroSelection('),
    selection.indexOf('export function CampaignHero('),
  );
  assert.match(view, /selection\.resource\.data\?\.map/);
  assert.match(view, /assetId=\{hero\.portraitAssetId\}/);
  assert.match(view, /hero\.traits\.join/);
  assert.doesNotMatch(
    view,
    /hero\.(notes|backstory)|\bapi\(|router\.|launch\(|useHeroSelection\(\)/,
  );
  assert.match(view, /fieldset className=\{styles\.choices\} disabled=\{blocked\}/);
  assert.match(view, /const blocked = disabled \|\| selection\.resource\.loading/);
  assert.match(view, /type="radio"/);
  assert.match(view, /checked=\{selection\.heroId === hero.id\}/);
  assert.match(view, /checked=\{selection\.heroId === ''\}/);
  assert.match(view, /onClose=\{closePicker\}/);
  assert.match(view, /data-hero-choice-trigger/);
  assert.match(view, /requestAnimationFrame/);
  assert.match(view, /trigger && !trigger.disabled \? trigger : root.current/);
  assert.match(view, /tabIndex=\{compact \? -1 : undefined\}/);
  assert.match(view, /presentation.synopsis/);
  assert.match(view, /disabled=\{blocked \|\| !selection\.valid\}/);
  assert.match(view, /selection\.resource\.error/);
  assert.match(view, /h\('missing'\)/);
  assert.match(launch, /disabled=\{busy \|\| directorSelection.locked \|\| state !== 'estimate'\}/);
  assert.equal((launch.match(/useHeroSelection\(\)/g) || []).length, 1);
  assert.match(launch, /storyReturnPath\(adventure.slug, heroSelection.heroId\)/);
  assert.match(selection, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(selection, /assetUrl\(assetId\)/);
});

test('hero dialog keeps the authoritative selection when reopened and reacts to a new lock', async () => {
  const { transformSync } = await import('esbuild');
  const code = transformSync(await source('game/hero-selection.tsx'), {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
  }).code;
  const cells = [];
  let cursor = 0;
  const selection = {
    enabled: true,
    heroId: '',
    valid: true,
    resource: {
      data: [{ id: 'owned', name: 'Owned', traits: ['Kind'], portraitAssetId: 'portrait' }],
      loading: false,
      error: '',
      reload() {},
    },
    setHeroId(id) {
      selection.heroId = id;
    },
  };
  const imports = {
    react: {
      useId: () => 'hero-choice',
      useRef: () => ({ current: null }),
      useState(initial) {
        const i = cursor++;
        if (!(i in cells)) cells[i] = initial;
        return [
          cells[i],
          (value) => {
            cells[i] = value;
          },
        ];
      },
    },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: 'fragment',
    },
    'next/navigation': {},
    'next/link': { default: 'a' },
    'lucide-react': {
      BookOpen: 'book',
      Sparkles: 'sparkles',
      Check: 'check',
      Plus: 'plus',
      UserRound: 'silhouette',
    },
    './hero-choice.module.css': { default: {} },
    '@/lib/i18n': { useT: () => ({ locale: 'en' }) },
    '@/lib/client': { assetUrl: (id) => '/assets/' + id },
    '@/components/ui': {
      Button: 'button',
      ErrorBox: 'error',
      Field: 'field',
      Modal: 'modal',
      Select: 'select',
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'requestAnimationFrame', code)(
    (name) => {
      assert.ok(name in imports, `Unexpected dependency ${name}`);
      return imports[name];
    },
    module,
    module.exports,
    (callback) => callback(),
  );
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
  function render(disabled = false) {
    cursor = 0;
    return flatten(module.exports.HeroSelection({ selection, compact: true, disabled }));
  }
  let nodes = render();
  nodes.find((n) => n.props?.['aria-haspopup'] === 'dialog').props.onClick();
  nodes = render();
  nodes.find((n) => n.type === 'input' && n.props.value === 'owned').props.onChange();
  assert.equal(selection.heroId, 'owned');
  nodes = render(true);
  assert.equal(nodes.find((n) => n.type === 'fieldset').props.disabled, true);
  assert.equal(nodes.find((n) => n.props?.['aria-haspopup'] === 'dialog').props.disabled, true);
  nodes.find((n) => n.type === 'modal').props.onClose();
  assert.equal(
    render().some((n) => n.type === 'modal'),
    false,
  );
  render()
    .find((n) => n.props?.['aria-haspopup'] === 'dialog')
    .props.onClick();
  assert.equal(
    render().find((n) => n.type === 'input' && n.props.value === 'owned').props.checked,
    true,
  );
});
