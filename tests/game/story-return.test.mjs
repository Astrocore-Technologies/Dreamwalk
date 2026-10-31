import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  safeStoryReturn,
  storyReturnPath,
  readStoryReturn,
  withStoryReturn,
  storyAfterAuth,
  storyWithHero,
  authFormKey,
} from '../../apps/web/components/story-return.ts';
const hero = '9f7a2c16-8da9-4a03-9b76-112233445566';
test('selected public story and optional hero survive auth switching and onboarding without starting a campaign', () => {
  const target = storyReturnPath('old-observatory', hero);
  assert.equal(target, `/adventures/old-observatory?heroId=${hero}`);
  for (const path of [
    '/auth/sign-in',
    '/auth/sign-up',
    '/auth/reset-password',
    '/onboarding',
    '/my-characters',
  ]) {
    const url = withStoryReturn(path, target);
    assert.equal(readStoryReturn(new URL(url, 'https://local.invalid').searchParams), target);
  }
  assert.equal(storyAfterAuth(true, target), target);
  assert.equal(storyAfterAuth(false, target), withStoryReturn('/onboarding', target));
  assert.equal(storyAfterAuth(true, null), '/home');
  assert.equal(storyWithHero('/adventures/old-observatory', hero), target);
});
test('return-intent allowlist rejects redirects, encoded paths, commands, fragments and ambiguous params', () => {
  for (const unsafe of [
    'https://evil.test',
    '//evil.test',
    'javascript:alert(1)',
    '/game/123',
    '/api/v1/game/campaigns',
    '/admin',
    '/adventures/../admin',
    '/adventures/foo/bar',
    '/adventures/foo#fragment',
    '/adventures/foo?next=https://evil.test',
    '/adventures/foo?heroId=bad',
    `/adventures/foo?heroId=${hero}&heroId=${hero}`,
    '/adventures/%2f%2fevil.test',
    '/adventures/foo\\bar',
    '/adventures/foo\n',
    '/adventures/foo?heroId=',
    '/adventures/foo?heroId=%39f7a2c16-8da9-4a03-9b76-112233445566',
  ]) {
    assert.equal(safeStoryReturn(unsafe), null, unsafe);
    assert.equal(storyAfterAuth(true, unsafe), '/home', unsafe);
  }
  assert.equal(
    readStoryReturn(
      new URLSearchParams('returnTo=%2Fadventures%2Fone&returnTo=%2Fadventures%2Ftwo'),
    ),
    null,
  );
  assert.equal(readStoryReturn(new URLSearchParams('returnTo=%252F%252Fevil.test')), null);
  assert.equal(storyWithHero('/game/123', hero), null);
});
test('actual auth and entry points preserve explicit destination and stale-navigation guard without auto campaign creation', async () => {
  const account = await readFile(
    new URL('../../apps/web/components/account.tsx', import.meta.url),
    'utf8',
  );
  assert.match(account, /storyAfterAuth\(r.user.onboarded, returnTo\)/);
  assert.match(account, /storyAfterAuth\(true, returnTo\)/);
  assert.match(account, /authGate.accepts\(lease\)/);
  assert.match(account, /onboardingGate.accepts\(lease\)/);
  assert.match(account, /language: locale/);
  assert.doesNotMatch(account, /\/game\/campaigns/);
  for (const path of ['home/home-page.tsx', 'game/adventure-launch.tsx']) {
    const source = await readFile(
      new URL(`../../apps/web/components/${path}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /withStoryReturn\(/);
    assert.match(source, /storyReturnPath\(/);
  }
  const heroes = await readFile(
    new URL('../../apps/web/components/personal.tsx', import.meta.url),
    'utf8',
  );
  assert.match(heroes, /storyWithHero\(returnTo, hero.id\)/);
});

test('auth mode and validated destination remount the form without accepting untrusted return keys', async () => {
  const signin = authFormKey(false, false, '/adventures/old-observatory');
  assert.notEqual(authFormKey(true, false, '/adventures/old-observatory'), signin);
  assert.notEqual(authFormKey(false, true, '/adventures/old-observatory'), signin);
  assert.notEqual(authFormKey(false, false, '/adventures/another-story'), signin);
  assert.equal(authFormKey(false, false, 'https://evil.test'), authFormKey(false, false, null));
  const source = await readFile(
    new URL('../../apps/web/components/account.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<AuthForm\s+key=\{authFormKey\(signup, reset, returnTo\)\}/);
  assert.ok(source.indexOf('function AuthForm(') < source.indexOf('const [error, setError]'));
  assert.match(source, /if \(!authGate.accepts\(lease\)\) return;\s+setUser\(r.user\)/);
});
