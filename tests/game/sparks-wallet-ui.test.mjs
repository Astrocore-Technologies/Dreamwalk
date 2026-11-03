import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSparksWallet } from '../../apps/web/lib/sparks-wallet.ts';
import { formatSparkSubunits } from '../../packages/contracts/src/sparks.ts';
const wallet = {
  ownerId: 'first',
  enabled: true,
  balanceSubunits: '500000',
  heldSubunits: '12345',
  availableSubunits: '487655',
  subunitsPerSpark: '10000',
  ledger: [],
};
test('actual usage wallet is read with exact integer arithmetic, independently of demo credits', () => {
  assert.equal(readSparksWallet(wallet, 'first').availableSubunits, '487655');
  assert.equal(formatSparkSubunits('500000'), '50.00');
  assert.equal(formatSparkSubunits('487655', 'ru', 'exact'), '48,7655');
  const huge = '9223372036854775807';
  assert.equal(
    readSparksWallet(
      {
        ...wallet,
        balanceSubunits: huge,
        heldSubunits: '0',
        availableSubunits: huge,
      },
      'first',
    ).availableSubunits,
    huge,
  );
});
test('unavailable, malformed or inconsistent wallet never becomes fake zero', () => {
  for (const value of [
    null,
    { ...wallet, ownerId: 'another-account' },
    {},
    { ...wallet, subunitsPerSpark: '100' },
    { ...wallet, balanceSubunits: 500000 },
    { ...wallet, availableSubunits: '-1' },
    { ...wallet, availableSubunits: '500000' },
    { ...wallet, heldSubunits: '0.5' },
    { ...wallet, balanceSubunits: '0500000' },
    {
      ...wallet,
      balanceSubunits: '9223372036854775808',
      heldSubunits: '0',
      availableSubunits: '9223372036854775808',
    },
    {
      ...wallet,
      ledger: [{ id: '1', kind: 'starter_grant', amountSubunits: 'x', createdAt: '2026-11-02' }],
    },
  ])
    assert.throws(() => readSparksWallet(value, 'first'));
});
test('header is scoped to account and refreshes after mutations and asynchronous settlement', async () => {
  const source = async (path) =>
    readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
  const shell = await source('components/shell.tsx');
  assert.match(shell, /<SparksBalance key=\{user.id\} ownerId=\{user.id\}/);
  assert.doesNotMatch(shell, /<small>DEMO/);
  const hook = await source('lib/use-sparks-wallet.ts');
  assert.match(hook, /state\?\.ownerId === ownerId/);
  assert.match(hook, /active && request === sequence/);
  assert.match(hook, /setInterval\(visibleRefresh, 15000\)/);
  assert.match(hook, /removeEventListener\(SPARKS_REFRESH_EVENT/);
  assert.match(hook, /api<unknown>\('\/sparks\/wallet'\)/);
  assert.doesNotMatch(hook, /'\/wallet'/);
  assert.match(
    await source('lib/client.tsx'),
    /dispatchEvent\(new Event\(SPARKS_REFRESH_EVENT\)\)/,
  );
  assert.doesNotMatch(
    await source('components/personal.tsx'),
    /sparks\.data\?\.(?:available|held)Subunits \?\? '0'/,
  );
});

test('wallet and admin UI use actual Sparks without duplicate explanation or demo cards', async () => {
  const source = (path) => readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
  const personal = await source('components/personal.tsx');
  const page = personal.slice(
    personal.indexOf('export function WalletPage()'),
    personal.indexOf('export function NotificationsPage()'),
  );
  assert.match(page, /useSparksWallet\(user\?\.id\)/);
  assert.match(page, /formatSparkSubunits\(sparks.data.availableSubunits, locale\)/);
  assert.doesNotMatch(
    page,
    /\/wallet|DEMO|Магия без сюрпризов|Искры за использование AI|Зарезервировано искр|Тестовая операция/,
  );
  const admin = (await source('components/admin.tsx')).split('function AdminCredits()')[1];
  assert.match(admin, /readSparksWallet\(wallet, userId\)/);
  assert.match(admin, /aria-label=\{t\('Пользователь'\)\}/);
  assert.match(admin, /formatSparkSubunits\(result.availableSubunits, locale\)/);
  assert.doesNotMatch(admin, /DEMO|demo ledger|demo Искр|Тестовая валюта/);
  assert.equal(
    readSparksWallet(
      {
        ...wallet,
        ledger: [
          {
            id: '2',
            kind: 'admin_credit',
            amountSubunits: '1000000',
            createdAt: '2026-11-02',
            reason: 'Reward',
          },
        ],
      },
      'first',
    ).ledger[0].reason,
    'Reward',
  );
});
test('hidden NPC controls retain saved profile/model fields in both editor drafts', async () => {
  const standalone = await readFile(
    new URL('../../apps/web/components/studio/npc-library.tsx', import.meta.url),
    'utf8',
  );
  const scoped = await readFile(
    new URL('../../apps/web/components/studio/story-npc-editor.tsx', import.meta.url),
    'utf8',
  );
  for (const source of [standalone, scoped]) {
    assert.doesNotMatch(source, /<NpcCharacterProfile|label=\{t\('Стиль поведения'\)\}/);
  }
  assert.match(standalone, /characterProfile: n.characterProfile/);
  assert.match(standalone, /modelProfileId: n.modelProfileId/);
  assert.match(scoped, /Object.entries\(data\).*key in npcSchema.shape/);
});

test('header balance stays prominent and is not hidden with the compact wallet label', async () => {
  const source = (path) => readFile(new URL(`../../apps/web/${path}`, import.meta.url), 'utf8');
  const balance = await source('components/sparks-balance.tsx');
  const css = await source('app/globals.css');
  assert.match(balance, /<strong\s+className="sparks-balance"/);
  assert.match(balance, /aria-live="polite"/);
  const rule = css.match(/\.wallet-chip \.sparks-balance\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /font-size: 16px/);
  assert.match(rule, /font-weight: 700/);
  assert.match(rule, /font-variant-numeric: tabular-nums/);
  assert.doesNotMatch(
    css,
    /\.wallet-chip\s*>\s*(?:strong|\.sparks-balance)[^{]*\{[^}]*display:\s*none/,
  );
});
