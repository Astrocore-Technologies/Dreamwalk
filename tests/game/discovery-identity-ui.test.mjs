import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDiscoveryStory } from '../../apps/web/lib/discovery.ts';
import { registerSchema } from '../../packages/contracts/src/index.ts';
const story = {
  slug: 'old-observatory',
  author: { name: 'Dreamwalk', handle: 'dreamwalk' },
  visibility: 'public',
  status: 'published',
};

test('normal discovery hides only bundled editorial stories, without deleting user stories', () => {
  for (const handle of ['dreamwalk', 'dreamwalk_editorial']) {
    for (const slug of [
      'old-observatory',
      'whispering-forest',
      'tidekeepers',
      'city-of-lanterns',
    ]) {
      assert.equal(
        isDiscoveryStory({ ...story, slug, author: { ...story.author, handle } }),
        false,
      );
    }
  }
  assert.equal(
    isDiscoveryStory({ ...story, author: { name: 'Dreamwalk', handle: 'real_author' } }),
    true,
  );
  assert.equal(isDiscoveryStory({ ...story, slug: 'a-new-user-story' }), true);
  assert.equal(
    isDiscoveryStory({ ...story, slug: 'a-new-user-story', visibility: 'private' }),
    false,
  );
  assert.equal(isDiscoveryStory({ ...story, slug: 'a-new-user-story', status: 'pending' }), false);
});
test('login identity fits existing registration contract without changing historical names or URLs', () => {
  const legacy = {
    handle: 'existing_user',
    name: 'Historical Display Name',
    email: 'old@example.test',
    password: 'strong-password',
  };
  assert.equal(registerSchema.parse(legacy).name, legacy.name);
  const signup = { ...legacy, name: legacy.handle };
  assert.equal(registerSchema.parse(signup).name, legacy.handle);
  assert.equal(registerSchema.safeParse({ ...signup, handle: 'not a valid login' }).success, false);
});
test('signup has only login, email and password and shell keeps Studio without duplicate creation or early-access footer', async () => {
  const account = await readFile(
    new URL('../../apps/web/components/account.tsx', import.meta.url),
    'utf8',
  );
  const auth = account.slice(0, account.indexOf('export function OnboardingPage'));
  assert.doesNotMatch(auth, /name="name"|Как тебя называть|Адрес профиля/);
  assert.match(auth, /if \(signup\) data.name = data.handle/);
  assert.match(auth, /name="handle"/);
  assert.match(auth, /name="email"/);
  assert.match(auth, /name="password"/);
  const shell = await readFile(
    new URL('../../apps/web/components/shell.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(shell, /studio-promo|Игровой прототип|mini-tag|user\.name/);
  assert.doesNotMatch(shell, /href="\/studio\/adventures\/new"/);
  assert.match(shell, /href="\/studio"/);
  assert.doesNotMatch(shell, /sidebar-footer|Платформа · ранний доступ/);
  assert.match(shell, /href="\/account\/settings"/);
  assert.match(shell, /href="\/help"/);
  for (const file of ['public.tsx', 'home/home-page.tsx']) {
    const source = await readFile(
      new URL(`../../apps/web/components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /isDiscoveryStory/);
  }
});

test('taxonomy language field labels exist in every UI locale', async () => {
  const { dictionaries } = await import('../../apps/web/lib/locales.ts');
  for (const locale of ['ru', 'en', 'uk']) {
    for (const label of ['Украинский', 'Английский', 'Русский']) {
      assert.ok(dictionaries[locale][label], `${locale}: ${label}`);
    }
  }
});
