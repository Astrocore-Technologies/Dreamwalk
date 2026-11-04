import {
  createAuthoredDraft,
  compilePlayableDraft,
  createStateFromPlayable,
  initializeTurnController,
  projectState,
} from '@dreamwalk/game-core';
import {
  formatSparkSubunits,
  providerMicrosToSparkSubunits,
  gameEnvelopeSchema,
} from '@dreamwalk/contracts';
import { defaultDirectorCatalog } from '@dreamwalk/contracts/dist/director-style';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { settingsSchema } from '@dreamwalk/contracts';
import type {
  PolicyApply,
  PolicyProfile,
  PolicyReceipt,
  PolicyReview,
} from '../../apps/web/components/live-test/owner-policy-types';

// These are browser protocol fixtures, not API authorization or provider-billing tests.
// Every API route is fulfilled or aborted; no provider request can leave the context.
type Locale = 'uk' | 'en' | 'ru';
const acknowledgment =
  'I reviewed the models, rates, caps and evidence dates. I authorize only this displayed revision; existing liabilities remain.';
const unchanged =
  'Applying a policy does not reset spending, reservations or unknown charges. Existing requests retain their policy snapshots.';
const reviewTitles: Record<Locale, string> = {
  en: 'Generation policy review',
  uk: 'Перегляд політики генерації',
  ru: 'Пересмотр политики генерации',
};
const currentHash = 'a'.repeat(64),
  currentFingerprint = 'b'.repeat(64),
  proposedHash = 'c'.repeat(64),
  proposedFingerprint = 'd'.repeat(64);
const usd = (micros: number, locale = 'en') =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);

function profile(version: number): PolicyProfile {
  return {
    configFingerprint:
      version === 1 ? currentFingerprint : version === 2 ? proposedFingerprint : 'e'.repeat(64),
    totalCapMicros: version === 1 ? 1_500_000 : 3_000_000,
    textCapMicros: version === 1 ? 1_000_000 : 1_500_000,
    imageCapMicros: version === 1 ? 500_000 : 1_500_000,
    text: {
      model: `synthetic-text-v${version}`,
      contextTokens: 64_000 + version * 1_000,
      maxOutputTokens: 1_024 + version * 128,
      maxInputBytes: 48_000,
      inputMicrosPerMillion: 400_000 + version * 100_000,
      outputMicrosPerMillion: 2_000_000 + version * 100_000,
      pricing: {
        source: `https://pricing.example.test/text/v${version}`,
        reviewedAt: `2026-${version === 1 ? '10-01' : '11-01'}T00:00:00.000Z`,
        validUntil: `203${version}-01-01T00:00:00.000Z`,
      },
      estimation: {
        kind: 'operator_heuristic',
        textTokensPerKiBUtf8: version === 1 ? 320 : 400,
        textProtocolTokens: version === 1 ? 800 : 1200,
        marginBps: 2_500,
        fixedMarginMicros: 500,
      },
    },
    image: {
      model: `synthetic-image-v${version}`,
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      maxPromptUtf8Bytes: 8_000,
      maxReferenceImages: version === 1 ? 0 : 1,
      inputTextMicrosPerMillion: 5_000_000,
      inputImageMicrosPerMillion: 8_000_000,
      outputImageMicrosPerMillion: 30_000_000,
      estimatedTotalMicros: 45_880,
      reserveMicros: 100_000,
      pricing: {
        source: `https://pricing.example.test/images/v${version}`,
        reviewedAt: `2026-${version === 1 ? '10-02' : '11-02'}T00:00:00.000Z`,
        validUntil: `203${version}-02-01T00:00:00.000Z`,
      },
      estimation: {
        kind: 'operator_heuristic',
        outputImageTokens: version === 1 ? 196 : 256,
        referenceImageTokensPerImage: version === 1 ? 300 : 600,
        marginBps: 2_500,
        fixedMarginMicros: 500,
        referenceAllowanceMicros: version === 1 ? 0 : 1_000,
      },
    },
  };
}
function initialPolicy(authorizationId: string): PolicyReview {
  return {
    mode: 'owner',
    authorizationId,
    scopeId: 'synthetic-browser-policy-scope',
    active: {
      revision: 1,
      hash: currentHash,
      configFingerprint: currentFingerprint,
      profile: profile(1),
      acknowledgedAt: '2026-10-01T00:00:00.000Z',
      legacy: false,
    },
    proposed: {
      candidateFingerprint: proposedFingerprint,
      hash: proposedHash,
      profile: profile(2),
      canApply: true,
      blockers: [],
    },
    history: [],
    liabilities: {
      spentMicros: 150_000,
      heldMicros: 230_000,
      unknownMicros: 70_000,
      totalAccountedMicros: 380_000,
      text: { spentMicros: 50_000, heldMicros: 80_000, unknownMicros: 20_000 },
      image: { spentMicros: 100_000, heldMicros: 150_000, unknownMicros: 50_000 },
    },
    dispatchEnabled: false,
    blockers: [],
    legacyProfileStatus: 'available',
  };
}

async function fixture(
  page: Page,
  options: {
    locale?: Locale;
    role?: 'admin' | 'user';
    outcome?: 'success' | 'unknown' | 'stale';
    holdApply?: boolean;
    blocker?: string;
  } = {},
) {
  const locale = options.locale ?? 'en',
    authorizationId = randomUUID(),
    userId = randomUUID();
  const user = {
    id: userId,
    email: `synthetic-policy-${userId}@example.test`,
    name: 'Synthetic browser policy owner',
    handle: `policy_${userId.replaceAll('-', '').slice(0, 10)}`,
    bio: '',
    avatarAssetId: null,
    role: options.role ?? 'admin',
    onboarded: true,
    emailVerified: false,
    settings: settingsSchema.parse({ language: locale }),
    createdAt: new Date().toISOString(),
  };
  const policy = initialPolicy(authorizationId);
  if (options.blocker) {
    policy.proposed!.canApply = false;
    policy.proposed!.blockers = [options.blocker];
    policy.proposed!.profile.totalCapMicros = 100_000;
    policy.proposed!.profile.textCapMicros = 25_000;
    policy.proposed!.profile.imageCapMicros = 75_000;
  }
  const calls = {
    policyGets: 0,
    apply: [] as PolicyApply[],
    operationGets: [] as string[],
    unexpected: [] as string[],
    paid: [] as string[],
  };
  let receipt: PolicyReceipt | null = null,
    receiptVisible = options.outcome !== 'unknown',
    releaseApply = () => {};
  const applyGate = options.holdApply
    ? new Promise<void>((resolve) => {
        releaseApply = resolve;
      })
    : Promise.resolve();
  const status = () => ({
    mode: 'owner',
    enabled: true,
    authorizationId,
    sessionId: authorizationId,
    state: 'active',
    expiresAt: null,
    pricingValidUntil: '2032-01-01T00:00:00.000Z',
    capMicros: policy.active?.profile?.totalCapMicros ?? 1_500_000,
    textCapMicros: policy.active?.profile?.textCapMicros ?? 1_000_000,
    imageCapMicros: policy.active?.profile?.imageCapMicros ?? 500_000,
    usedMicros: policy.liabilities.spentMicros,
    heldMicros: policy.liabilities.heldMicros,
    remainingMicros: 1_120_000,
    textRemainingMicros: 870_000,
    imageRemainingMicros: 1_250_000,
    priorHeldReservations: 2,
    imagesEnabled: true,
    stopCode: null,
    imageBlockCode: null,
    policyRevision: policy.active?.revision,
    policyHash: policy.active?.hash,
    configFingerprint: policy.active?.configFingerprint,
    activeConfigFingerprint: policy.active?.configFingerprint,
    imageConfiguration: {
      requestProfile: { maxReferenceImages: policy.active?.profile?.image.maxReferenceImages ?? 0 },
    },
    text: {
      model: policy.active?.profile?.text.model ?? 'synthetic-unavailable',
      upperMicros: 20_000,
      maxOutputTokens: 2_048,
      contextTokens: 64_000,
      costEvidence: 'synthetic-browser-fixture',
    },
  });
  function commit(body: PolicyApply) {
    const active = policy.active!,
      candidate = policy.proposed!;
    policy.history.push({
      revision: active.revision,
      hash: active.hash,
      configFingerprint: active.configFingerprint,
      acknowledgedAt: active.acknowledgedAt!,
      operationId: randomUUID(),
      profile: structuredClone(active.profile),
    });
    policy.active = {
      revision: active.revision + 1,
      hash: candidate.hash,
      configFingerprint: candidate.candidateFingerprint,
      profile: structuredClone(candidate.profile),
      acknowledgedAt: '2026-11-01T12:00:00.000Z',
      legacy: false,
    };
    policy.proposed = null;
    policy.dispatchEnabled = true;
    receipt = {
      operationId: body.operationId,
      status: 'applied',
      revision: policy.active.revision,
      hash: policy.active.hash,
      candidateFingerprint: body.candidateFingerprint,
      acknowledgedAt: policy.active.acknowledgedAt!,
    };
    return receipt;
  }
  await page.addInitScript(
    (language) => localStorage.setItem('dreamwalk-language', language),
    locale,
  );
  await page.context().route(/https?:\/\/(?:api\.)?openai\.com\//, async (route) => {
    calls.paid.push(route.request().url());
    await route.abort();
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (method === 'GET' && path === '/api/v1/taxonomy')
      return route.fulfill({ json: { genres: [], tags: [], genreDefinitions: [], revision: 0 } });
    if (method === 'GET' && path === '/api/v1/auth/me') return route.fulfill({ json: { user } });
    // Header balance is a read-only local fixture, never a paid provider request.
    if (method === 'GET' && path === '/api/v1/currencies/wallet')
      return route.fulfill({
        json: {
          dreams: {
            ownerId: userId,
            currency: 'dreams',
            balanceSubunits: '500000',
            heldSubunits: '0',
            availableSubunits: '500000',
            subunitsPerDream: '10000',
            spendingAvailable: true,
            ledger: [],
          },
        },
      });
    if (method === 'GET' && path === '/api/v1/sparks/wallet')
      return route.fulfill({
        json: {
          ownerId: userId,
          enabled: true,
          balanceSubunits: '500000',
          heldSubunits: '0',
          availableSubunits: '500000',
          subunitsPerSpark: '10000',
          ledger: [],
        },
      });
    if (
      method === 'GET' &&
      [
        '/api/v1/heroes',
        '/api/v1/npcs',
        '/api/v1/visual-authoring/projects',
        '/api/v1/visual-authoring/packages',
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    if (method === 'GET' && path === '/api/v1/admin/overview')
      return route.fulfill({ json: { users: 1, adventures: 0, pendingReview: 0, openReports: 0 } });
    if (method === 'GET' && path === '/api/v1/generation/status')
      return route.fulfill({ json: status() });
    if (method === 'GET' && path === '/api/v1/generation/policy') {
      calls.policyGets++;
      return route.fulfill({ json: policy });
    }
    if (method === 'POST' && path === '/api/v1/generation/policy/revisions') {
      const body = request.postDataJSON() as PolicyApply;
      expect(Object.keys(body).sort()).toEqual(
        [
          'operationId',
          'expectedRevision',
          'expectedHash',
          'candidateFingerprint',
          'consent',
        ].sort(),
      );
      expect(body).toMatchObject({
        expectedRevision: policy.active!.revision,
        expectedHash: policy.active!.hash,
        candidateFingerprint: policy.proposed!.candidateFingerprint,
        consent: true,
      });
      expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
      calls.apply.push(body);
      await applyGate;
      if (options.outcome === 'stale') {
        // A different operator wins the compare-and-swap before this request.
        commit({ ...body, operationId: randomUUID() });
        policy.proposed = {
          candidateFingerprint: 'e'.repeat(64),
          hash: 'f'.repeat(64),
          profile: profile(3),
          canApply: true,
          blockers: [],
        };
        return route.fulfill({ status: 409, json: { code: 'GENERATION_POLICY_STALE' } });
      }
      const result = commit(body);
      if (options.outcome === 'unknown') return route.abort();
      return route.fulfill({ json: result });
    }
    if (method === 'GET' && path.startsWith('/api/v1/generation/policy/operations/')) {
      const operationId = path.split('/').at(-1)!;
      calls.operationGets.push(operationId);
      expect(operationId).toBe(calls.apply[0]?.operationId);
      return route.fulfill({
        json: receiptVisible && receipt ? receipt : { operationId, status: 'not_found' },
      });
    }
    // This catch-all also intercepts image, NPC, old live-test and world-turn routes.
    // An unhandled mutation is a test failure, never a route.continue() to a provider.
    if (method !== 'GET') calls.paid.push(`${method} ${path}`);
    calls.unexpected.push(`${method} ${path}`);
    await route.abort();
  });
  return {
    user,
    status,
    policy,
    calls,
    releaseApply,
    revealReceipt: () => {
      receiptVisible = true;
    },
  };
}
test('ordinary author cannot open the technical policy editor or trigger an amendment from the workshop', async ({
  page,
}) => {
  const f = await fixture(page, { role: 'user' });
  await page.goto('/studio/visuals');
  await expect(page.getByTestId('live-test-panel')).toHaveCount(0);
  await expect(page.getByTestId('owner-policy-review')).toHaveCount(0);
  await expect(page.getByTestId('owner-policy-dialog')).toHaveCount(0);
  expect(f.calls.apply).toHaveLength(0);
  expect(f.calls.policyGets).toBe(0);
  noPaidOrUnexpected(f);
});
async function openReview(page: Page) {
  await page.getByTestId('owner-policy-review').getByRole('button').click();
  const dialog = page.getByTestId('owner-policy-dialog');
  await expect(dialog.locator('table').first()).toBeVisible();
  return dialog;
}
function comparisonCells(dialog: ReturnType<Page['getByTestId']>, label: string | RegExp) {
  return dialog
    .locator('table')
    .first()
    .getByRole('rowheader', { name: label, exact: typeof label === 'string' })
    .locator('..')
    .getByRole('cell');
}
function noPaidOrUnexpected(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.calls.paid).toEqual([]);
  expect(f.calls.unexpected).toEqual([]);
}
test.use({ timezoneId: 'UTC', serviceWorkers: 'block' });

test('review compares saved and proposed policy, cancel clears consent, and apply preserves liabilities', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/studio/visuals');
  expect(f.calls.policyGets).toBe(0);
  const dialog = await openReview(page);
  await expect(page.getByRole('dialog')).toHaveAccessibleName(reviewTitles.en);
  await expect(dialog).toContainText(unchanged);
  await expect(
    dialog.getByRole('columnheader', { name: 'Active policy', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('columnheader', { name: 'Proposed policy', exact: true }),
  ).toBeVisible();
  await expect(comparisonCells(dialog, 'Text cap')).toHaveText([usd(1_000_000), usd(1_500_000)]);
  await expect(comparisonCells(dialog, 'Image cap')).toHaveText([usd(500_000), usd(1_500_000)]);
  await expect(comparisonCells(dialog, /^Text.*model$/i)).toHaveText([
    'synthetic-text-v1',
    'synthetic-text-v2',
  ]);
  await expect(comparisonCells(dialog, /^Images.*model$/i)).toHaveText([
    'synthetic-image-v1',
    'synthetic-image-v2',
  ]);
  const evidence = comparisonCells(dialog, /^Text.*Pricing evidence$/);
  await expect(evidence.nth(0)).toContainText('https://pricing.example.test/text/v1');
  await expect(evidence.nth(1)).toContainText('https://pricing.example.test/text/v2');
  await expect(evidence.nth(0)).toContainText(
    new Date(profile(1).text.pricing.reviewedAt).toLocaleString('en', { timeZone: 'UTC' }),
  );
  await expect(evidence.nth(1)).toContainText(
    new Date(profile(2).text.pricing.validUntil).toLocaleString('en', { timeZone: 'UTC' }),
  );
  await page.screenshot({ path: test.info().outputPath('policy-comparison-desktop.png') });
  for (const [label, expected] of [
    [
      /^Text.*Complete reserve estimator settings$/,
      [
        ['textTokensPerKiBUtf8', 320, 400],
        ['textProtocolTokens', 800, 1200],
      ],
    ],
    [
      /^Images.*Complete reserve estimator settings$/,
      [
        ['outputImageTokens', 196, 256],
        ['referenceImageTokensPerImage', 300, 600],
      ],
    ],
  ] as const) {
    const cells = comparisonCells(dialog, label);
    for (const index of [0, 1]) {
      await cells
        .nth(index)
        .getByText('Complete reserve estimator settings', { exact: true })
        .click();
      for (const [key, oldValue, newValue] of expected)
        await expect(cells.nth(index).locator('pre')).toContainText(
          `"${key}": ${index === 0 ? oldValue : newValue}`,
        );
    }
  }
  await page.screenshot({ path: test.info().outputPath('policy-estimator-details-desktop.png') });
  const liabilities = await dialog.getByTestId('policy-liabilities').textContent();
  await expect(dialog.getByTestId('policy-liabilities')).toContainText(usd(70_000));
  const apply = dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true });
  await expect(apply).toBeDisabled();
  await dialog.getByLabel(acknowledgment, { exact: true }).check();
  await expect(apply).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close without applying', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.calls.apply).toHaveLength(0);
  const reopened = await openReview(page);
  await expect(reopened.getByLabel(acknowledgment, { exact: true })).not.toBeChecked();
  await expect(
    reopened.getByRole('button', { name: 'Apply reviewed revision', exact: true }),
  ).toBeDisabled();
  await reopened.getByLabel(acknowledgment, { exact: true }).check();
  await reopened.getByRole('button', { name: 'Apply reviewed revision', exact: true }).click();
  await expect(reopened).toContainText(
    'The new revision is acknowledged. Existing liabilities were preserved.',
  );
  await expect(reopened).toContainText('There are no proposed changes to apply.');
  await expect(reopened.getByTestId('policy-liabilities')).toHaveText(liabilities!);
  await expect(comparisonCells(reopened, /^Text.*model$/i)).toHaveText(['synthetic-text-v2']);
  await reopened.getByText('Acknowledgement history (1)', { exact: true }).click();
  await expect(reopened.getByRole('heading', { name: 'Revision 1', exact: true })).toBeVisible();
  await expect(reopened).toContainText(currentHash);
  expect(f.calls.apply).toHaveLength(1);
  expect(f.calls.operationGets).toHaveLength(0);
  noPaidOrUnexpected(f);
});

test('duplicate apply clicks submit one operation while the first result is pending', async ({
  page,
}) => {
  const f = await fixture(page, { holdApply: true });
  try {
    await page.goto('/studio/visuals');
    const dialog = await openReview(page);
    await dialog.getByLabel(acknowledgment, { exact: true }).check();
    const apply = dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true });
    await apply.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => f.calls.apply.length).toBe(1);
    // Persisting the in-flight operation changes this control's accessible name.
    await expect(
      dialog.getByRole('button', { name: 'Retry the same reviewed operation', exact: true }),
    ).toBeDisabled();
    f.releaseApply();
    await expect(dialog).toContainText('The new revision is acknowledged.');
    expect(f.calls.apply).toHaveLength(1);
    noPaidOrUnexpected(f);
  } finally {
    f.releaseApply();
  }
});

test('unknown apply survives reload and reconciles only by GET, including an inconclusive not_found', async ({
  page,
}) => {
  const f = await fixture(page, { outcome: 'unknown' });
  await page.goto('/studio/visuals');
  const dialog = await openReview(page);
  await dialog.getByLabel(acknowledgment, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true }).click();
  await expect(dialog).toContainText('The apply result is uncertain.');
  expect(f.calls.apply).toHaveLength(1);
  expect(f.calls.operationGets).toHaveLength(0);
  const operationId = f.calls.apply[0].operationId;
  await page.reload();
  const review = page.getByTestId('owner-policy-review');
  await expect(
    review.getByRole('button', { name: 'Check apply result', exact: true }),
  ).toBeVisible();
  const recovered = await openReview(page);
  const reconcile = recovered.getByRole('button', { name: 'Check apply result', exact: true });
  await reconcile.click();
  await expect(recovered).toContainText(
    'This does not prove cancellation; no new request is sent.',
  );
  expect(f.calls.operationGets).toEqual([operationId]);
  expect(f.calls.apply).toHaveLength(1);
  await expect(reconcile).toBeEnabled();
  f.revealReceipt();
  await reconcile.click();
  await expect(recovered).toContainText('The new revision is acknowledged.');
  await expect(
    recovered.getByRole('button', { name: 'Check apply result', exact: true }),
  ).toHaveCount(0);
  expect(f.calls.operationGets).toEqual([operationId, operationId]);
  expect(f.calls.apply).toHaveLength(1);
  noPaidOrUnexpected(f);
});

test('stale proposal reloads the comparison and requires fresh acknowledgment', async ({
  page,
}) => {
  const f = await fixture(page, { outcome: 'stale' });
  await page.goto('/studio/visuals');
  const dialog = await openReview(page);
  await dialog.getByLabel(acknowledgment, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true }).click();
  await expect(dialog).toContainText(
    'The policy changed. Reload and review it again before confirming.',
  );
  await expect(comparisonCells(dialog, /^Text.*model$/i)).toHaveText([
    'synthetic-text-v2',
    'synthetic-text-v3',
  ]);
  await expect(dialog.getByLabel(acknowledgment, { exact: true })).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true }),
  ).toBeDisabled();
  expect(f.calls.policyGets).toBeGreaterThanOrEqual(2);
  expect(f.calls.apply).toHaveLength(1);
  expect(f.calls.operationGets).toHaveLength(0);
  noPaidOrUnexpected(f);
});

test('historical liability blocker disables acknowledgment and application', async ({ page }) => {
  const f = await fixture(page, { blocker: 'GENERATION_CAP_BELOW_HISTORICAL_SPEND' });
  await page.goto('/studio/visuals');
  const dialog = await openReview(page);
  await expect(dialog).toContainText('GENERATION_CAP_BELOW_HISTORICAL_SPEND');
  await expect(dialog.getByLabel(acknowledgment, { exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true }),
  ).toBeDisabled();
  expect(f.calls.apply).toHaveLength(0);
  noPaidOrUnexpected(f);
});

for (const locale of ['uk', 'en', 'ru'] as const)
  test(`policy review is localized and usable at mobile width (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page, { locale });
    await page.goto('/studio/visuals');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const dialog = await openReview(page);
    await expect(page.getByRole('dialog')).toHaveAccessibleName(reviewTitles[locale]);
    await expect(dialog.getByRole('checkbox')).toHaveAccessibleName(/.+/);
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog).not.toContainText('Invalid Date');
    await expect(dialog).toContainText('synthetic-text-v1');
    await expect(dialog).toContainText('synthetic-text-v2');
    await expect(dialog.getByTestId('policy-liabilities')).toContainText(usd(70_000, locale));
    const bounds = await page.getByRole('dialog').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await dialog.getByRole('checkbox').check();
    const buttons = dialog.locator('button');
    await expect(buttons).toHaveCount(3);
    await buttons.last().click();
    await expect(dialog).toHaveCount(0);
    expect(f.calls.apply).toHaveLength(0);
    noPaidOrUnexpected(f);
  });

type QuoteVariant = 'valid' | 'stale-policy' | 'pricing-mismatch' | 'broken-margin';
async function imageFixture(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  variant: QuoteVariant = 'valid',
) {
  const projectId = randomUUID(),
    pricingProfileId = randomUUID(),
    pricingProfileHash = '1'.repeat(64),
    providerFingerprint = '2'.repeat(64);
  const project = {
    id: projectId,
    kind: 'character',
    name: 'Synthetic policy-bound character',
    sourceHash: '3'.repeat(64),
    status: 'concept',
    revision: 1,
    provider: 'external',
    generationReady: false,
    conceptUrl: null,
    plan: null,
    projection: null,
  };
  const configuration = () => ({
    generationMode: 'owner',
    mockAvailable: false,
    externalEnabled: true,
    externalBlockReasons: [],
    ownerEstimateEnabled: true,
    estimateRiskConsentRequired: true,
    providerEnforcesQuotedCap: false,
    costStatus: 'approved_estimate',
    costBasis: 'approved_estimate',
    verifiedUpperMicros: null,
    // These are baseline configuration values. A valid request quote must differ.
    estimatedTotalMicros: 45_880,
    reserveMicros: 100_000,
    requestEstimationEnabled: true,
    pricingProfileId,
    pricingProfileHash,
    providerFingerprint,
    requestProfile: {
      provider: 'synthetic',
      model: f.policy.active!.profile!.image.model,
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      maxReferenceImages: 1,
    },
  });
  function makeQuote(serial: number) {
    const inputTextMicros = serial * 1_000,
      outputImageMicros = 7_680,
      inputImageMicros = 4_800,
      estimatedTotalMicros = inputTextMicros + inputImageMicros + outputImageMicros,
      percentageMarginMicros = estimatedTotalMicros / 4,
      reserveMicros = estimatedTotalMicros + percentageMarginMicros + 500 + 1_000;
    const estimate = {
      schemaVersion: 1,
      id: randomUUID(),
      fingerprint: serial.toString(16).repeat(64),
      basis: 'operator_heuristic',
      costBasis: 'operator_estimate',
      providerEnforcesQuotedCap: false,
      promptUtf8Bytes: serial * 400,
      promptSha256: '4'.repeat(64),
      referenceCount: 1,
      uncertainReferences: true,
      inputTextTokensEstimate: serial * 200,
      inputImageTokensEstimate: 600,
      outputImageTokensEstimate: 256,
      inputTextMicros,
      inputImageMicros,
      outputImageMicros,
      estimatedTotalMicros,
      marginBps: 2_500,
      percentageMarginMicros,
      fixedMarginMicros: 500,
      referenceAllowanceMicros: 1_000,
      reserveMicros,
      providerFingerprint,
      pricingProfileId,
      pricingProfileHash,
      assumptions: { source: 'synthetic browser protocol fixture', providerInvoiceCap: false },
    };
    const pricing = {
      id: pricingProfileId,
      fingerprint: pricingProfileHash,
      model: configuration().requestProfile.model,
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      format: 'png',
      maxPromptUtf8Bytes: 8_000,
      maxReferenceImages: 1,
      inputTextMicrosPerMillion: 5_000_000,
      inputImageMicrosPerMillion: 8_000_000,
      outputImageMicrosPerMillion: 30_000_000,
      pricing: f.policy.active!.profile!.image.pricing,
      estimation: f.policy.active!.profile!.image.estimation,
      providerEnforcesQuotedCap: false,
    };
    const quote = {
      id: randomUUID(),
      mode: 'external',
      generationMode: 'owner',
      estimateRiskConsentRequired: true,
      providerEnforcesQuotedCap: false,
      costBasis: 'approved_estimate',
      upperMicros: null,
      estimatedTotalMicros,
      reserveMicros,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      rightsAttestationRequired: true,
      estimateSnapshot: estimate,
      estimateSnapshotId: estimate.id,
      estimateSnapshotHash: estimate.fingerprint,
      pricingProfileSnapshot: pricing,
      pricingProfileId,
      pricingProfileHash,
      policyRevision: f.policy.active!.revision,
      policyHash: f.policy.active!.hash,
    };
    if (variant === 'stale-policy') {
      quote.policyRevision = 1;
      quote.policyHash = currentHash;
    }
    if (variant === 'pricing-mismatch') quote.pricingProfileSnapshot.fingerprint = '9'.repeat(64);
    if (variant === 'broken-margin') quote.estimateSnapshot.percentageMarginMicros++;
    return quote;
  }
  const quotes: ReturnType<typeof makeQuote>[] = [],
    dispatches: Record<string, unknown>[] = [];
  let job: object | undefined;
  await page.route('**/api/v1/image-generation/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/v1/image-generation/config')
      return route.fulfill({ json: configuration() });
    f.calls.paid.push(`${request.method()} ${path}`);
    await route.abort();
  });
  await page.route('**/api/v1/visual-authoring/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (method === 'GET' && path.endsWith('/packages')) return route.fulfill({ json: [] });
    if (method === 'GET' && path.endsWith('/projects')) return route.fulfill({ json: [project] });
    if (method === 'GET' && path.endsWith(projectId)) return route.fulfill({ json: project });
    if (method === 'GET' && path.endsWith('/generation')) {
      const quote = quotes.at(-1);
      return route.fulfill({
        json: {
          projectId,
          mode: 'external',
          requiredRoles: ['concept'],
          items: [
            {
              role: 'concept',
              stage: 'concept',
              status: job ? 'admitted' : quote ? 'quoted' : 'idle',
              ...(quote ? { quote: { decision: 'quote', matches: [], quote } } : {}),
              ...(job ? { job } : {}),
            },
          ],
          readyForReview: false,
          automaticRetry: false,
          humanVisualReviewRequired: true,
          configuration: configuration(),
        },
      });
    }
    if (method === 'POST' && path.endsWith('/generation/quote')) {
      expect(request.postDataJSON()).toMatchObject({
        expectedRevision: 1,
        role: 'concept',
        liveTestSessionId: f.policy.authorizationId,
      });
      const quote = makeQuote(quotes.length + 1);
      quotes.push(quote);
      return route.fulfill({ json: { decision: 'quote', matches: [], quote } });
    }
    if (method === 'POST' && path.endsWith('/generation/dispatch')) {
      expect(variant).toBe('valid');
      const body = request.postDataJSON(),
        quote = quotes.at(-1)!;
      expect(body).toMatchObject({
        expectedRevision: 1,
        role: 'concept',
        quoteId: quote.id,
        consent: true,
        estimateRiskConsent: true,
      });
      expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(quote.policyRevision).toBe(f.policy.active!.revision);
      expect(quote.policyHash).toBe(f.policy.active!.hash);
      dispatches.push(body);
      job = {
        id: randomUUID(),
        operationId: body.operationId,
        status: 'admitted',
        mode: 'external',
        heldMicros: 0,
        actualMicros: quote.estimatedTotalMicros,
        createdAt: new Date().toISOString(),
        canCancel: false,
      };
      return route.fulfill({ json: job });
    }
    f.calls.unexpected.push(`${method} ${path}`);
    if (method !== 'GET') f.calls.paid.push(`${method} ${path}`);
    await route.abort();
  });
  return { quotes, dispatches, configuration };
}
async function applyThenOpenImage(page: Page) {
  await page.goto('/studio/visuals');
  const dialog = await openReview(page);
  await dialog.getByLabel(acknowledgment, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply reviewed revision', exact: true }).click();
  await expect(dialog).toContainText('There are no proposed changes to apply.');
  await dialog.getByRole('button', { name: 'Close without applying', exact: true }).click();
  await page.goto('/studio/visuals');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const stage = page.locator('[data-generation-role="concept"]');
  await expect(stage).toBeVisible();
  await stage.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await expect(stage.locator('[data-image-quote-price]')).toBeVisible();
  return stage;
}

test('after a policy change each image uses its own reserve snapshot and requires fresh request consent', async ({
  page,
}) => {
  const f = await fixture(page),
    images = await imageFixture(page, f),
    stage = await applyThenOpenImage(page);
  expect(f.policy.active!.revision).toBe(2);
  expect(f.policy.active!.profile!.image.maxReferenceImages).toBe(1);
  await expect(
    page
      .getByRole('combobox', { name: 'Character', exact: true })
      .getByRole('option', { name: 'From photo', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/The configured image profile accepts text only/)).toHaveCount(0);
  expect(images.quotes).toHaveLength(1);
  const first = images.quotes[0];
  expect(first.reserveMicros).not.toBe(images.configuration().reserveMicros);
  expect(first.estimatedTotalMicros).not.toBe(images.configuration().estimatedTotalMicros);
  const reserve = stage.locator('[data-image-quote-price]');
  await expect(reserve).toHaveCount(1);
  await expect(stage.getByTestId('request-reserve')).toHaveCount(0);
  expect(first.reserveMicros).toBe(
    first.estimatedTotalMicros +
      first.estimateSnapshot.percentageMarginMicros +
      first.estimateSnapshot.fixedMarginMicros +
      first.estimateSnapshot.referenceAllowanceMicros,
  );
  await expect(reserve).toContainText(
    formatSparkSubunits(providerMicrosToSparkSubunits(String(first.reserveMicros)), 'en', 'exact'),
  );
  await expect(stage).toContainText(
    'The estimate does not cap the provider invoice: actual cost may be higher.',
  );
  await reserve.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('single-image-estimate-desktop.png') });
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await reserve.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('single-image-estimate-mobile.png') });
  await page.setViewportSize(originalViewport);
  const dispatch = stage.getByRole('button', { name: 'Confirm and generate', exact: true });
  await expect(dispatch).toBeEnabled();
  expect(images.dispatches).toHaveLength(0);
  await stage.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await expect.poll(() => images.quotes.length).toBe(2);
  const second = images.quotes[1];
  expect(second.id).not.toBe(first.id);
  expect(second.estimateSnapshotId).not.toBe(first.estimateSnapshotId);
  expect(second.reserveMicros).not.toBe(first.reserveMicros);
  await expect(reserve).toContainText(
    formatSparkSubunits(providerMicrosToSparkSubunits(String(second.reserveMicros)), 'en', 'exact'),
  );
  await expect(dispatch).toBeEnabled();
  await dispatch.click();
  await expect.poll(() => images.dispatches.length).toBe(1);
  expect(f.calls.apply).toHaveLength(1);
  noPaidOrUnexpected(f);
});
for (const variant of ['stale-policy', 'pricing-mismatch', 'broken-margin'] as const)
  test(`image quote rejects ${variant} despite an otherwise active owner authorization`, async ({
    page,
  }) => {
    const f = await fixture(page),
      images = await imageFixture(page, f, variant),
      stage = await applyThenOpenImage(page);
    await expect(
      stage.getByRole('button', { name: 'Confirm and generate', exact: true }),
    ).toBeDisabled();
    await expect(stage.locator('[data-image-confirmation] input[type=checkbox]')).toHaveCount(0);
    expect(images.quotes).toHaveLength(1);
    expect(images.dispatches).toHaveLength(0);
    expect(f.policy.active!.revision).toBe(2);
    noPaidOrUnexpected(f);
  });

for (const locale of ['uk', 'en', 'ru'] as const) {
  test(`context and reply limits stay separate from money in ${locale}`, async ({ page }) => {
    const f = await fixture(page, { locale });
    const text = f.policy.proposed!.profile.text;
    text.contextTokens = 128000;
    text.contextBudgetTokens = 256000;
    text.maxOutputTokens = 8192;
    text.maxInputBytes = 4194304;
    await page.goto('/studio/visuals');
    const dialog = await openReview(page);
    await expect(dialog).toContainText(
      {
        en: 'Available history may be shorter than the actual-token limit.',
        ru: 'Доступная история может быть короче лимита фактических токенов.',
        uk: 'Доступна історія може бути коротшою за межу фактичних токенів.',
      }[locale],
    );
    const labels = {
      en: [
        'Model context capacity',
        'Requested window per request, including reply',
        'Effective window within model capacity',
        'Separate reply limit, tokens',
      ],
      ru: [
        'Ёмкость контекста модели',
        'Выбранное окно на запрос, включая ответ',
        'Доступное окно с учётом модели',
        'Отдельный предел ответа, токенов',
      ],
      uk: [
        'Місткість контексту моделі',
        'Вибране вікно на запит, включно з відповіддю',
        'Доступне вікно з урахуванням моделі',
        'Окрема межа відповіді, токенів',
      ],
    }[locale];
    for (const [index, value] of [128000, 256000, 128000, 8192].entries())
      await expect(comparisonCells(dialog, labels[index]).nth(1)).toHaveText(String(value));
    await dialog.getByRole('rowheader', { name: labels[0], exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`text-context-${locale}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('rowheader', { name: labels[3], exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect(dialog.getByRole('rowheader', { name: labels[1], exact: true })).toBeInViewport();
    await expect(dialog.getByRole('rowheader', { name: labels[3], exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`text-context-${locale}-mobile.png`) });
    expect(f.calls.apply).toHaveLength(0);
    noPaidOrUnexpected(f);
  });
}

async function preflightFixture(
  page: Page,
  locale: Locale,
  unreviewed = false,
  lost = false,
  illustrated = false,
) {
  const f = await fixture(page, { locale }),
    id = randomUUID(),
    requestId = randomUUID(),
    actor = 'count-player';
  const compiled = compilePlayableDraft(createAuthoredDraft('courtyard'));
  const state = initializeTurnController(createStateFromPlayable(compiled.playable!, [actor]), [
    actor,
  ]).state;
  const projection = projectState(state, actor);
  if (illustrated) projection.map.backgroundMode = 'schematic';
  const imageId = randomUUID();
  projection.turn = {
    ...projection.turn!,
    phase: illustrated ? 'player' : 'world',
    activeActorId: illustrated ? actor : null,
    ownTurn: illustrated,
    phaseEpoch: 7,
  };
  const envelope = gameEnvelopeSchema.parse({
    type: 'snapshot',
    streamId: 'synthetic-count-stream',
    connectionEpoch: 1,
    projectionRevision: projection.revision,
    projection,
  });
  const turnFence = { roundId: projection.turn.roundId, phaseEpoch: 7, rulesetVersion: 1 };
  const r = {
    id: requestId,
    subjectId: 'Keeper',
    purpose: 'speech',
    permitState: null,
    upperMicros: 20000,
    reserveMicros: 20000,
    policyRevision: 1,
    policyHash: currentHash,
    configFingerprint: currentFingerprint,
    counting: {
      blockCode: unreviewed ? 'TEXT_COUNT_COST_REVIEW_REQUIRED' : null,
      candidateFingerprint: 'a'.repeat(64),
      historyRecords: 150,
      reserveMicros: unreviewed ? null : 7,
      attempts: 0,
      maxAttempts: 3,
      latest: null as null | Record<string, unknown>,
    },
  };
  const counts: Record<string, unknown>[] = [],
    gets: string[] = [],
    moves: { x: number; y: number }[] = [];
  let illustrationAvailable = illustrated;
  await page.routeWebSocket(
    (url) => url.pathname === '/api/v1/game/socket',
    (ws) => {
      if (!illustrated) return ws.close();
      ws.onMessage(() => ws.send(JSON.stringify(envelope)));
    },
  );
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (path.endsWith(`/game/campaigns/${id}/snapshot`)) return route.fulfill({ json: envelope });
    // Director discovery is read-only. Keep the unexpected-route guard strict for writes.
    if (method === 'GET' && path === '/api/v1/game/directors')
      return route.fulfill({ json: defaultDirectorCatalog() });
    if (method === 'GET' && path === `/api/v1/game/campaigns/${id}/director`) {
      const catalog = defaultDirectorCatalog();
      return route.fulfill({
        json: {
          profileId: catalog.defaultProfileId,
          revision: 1,
          profile: catalog.profiles.find((profile) => profile.id === catalog.defaultProfileId),
          canChange: true,
        },
      });
    }
    if (illustrated && method === 'POST' && path.endsWith(`/game/campaigns/${id}/move`)) {
      const body = route.request().postDataJSON();
      expect(body.turnFence).toEqual(turnFence);
      moves.push(body.target);
      const player = envelope.projection.entities.find((entity) => entity.id === actor)!;
      Object.assign(player, body.target);
      envelope.projection.revision++;
      envelope.projectionRevision = envelope.projection.revision;
      return route.fulfill({
        json: { ...envelope, status: 'committed', operationId: body.operationId, events: [] },
      });
    }
    if (path.endsWith(`/game/campaigns/${id}/members`))
      return route.fulfill({
        json: {
          ownerId: f.user.id,
          members: [{ userId: f.user.id, actorId: actor, username: 'Owner', status: 'accepted' }],
        },
      });
    if (path.endsWith(`/asset-library/campaigns/${id}/manifest`))
      return route.fulfill({
        json: {
          bindings: [],
          sceneIllustration: illustrationAvailable
            ? {
                mapId: projection.map.id,
                slot: `map:${projection.map.id}:background`,
                revisionId: imageId,
                sha256: 'a'.repeat(64),
                mime: 'image/png',
                width: 1024,
                height: 1024,
                url: `/api/v1/asset-library/revisions/${imageId}/file?campaignId=${id}`,
                attribution: 'Synthetic scene',
                licenseLabel: 'Test fixture',
              }
            : null,
        },
      });
    if (illustrated && path.endsWith(`/asset-library/revisions/${imageId}/file`))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqvYc1ERUr4h7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHmxYUUucLoCvAAAAAElFTkSuQmCC',
          'base64',
        ),
      });
    if (path.endsWith(`/game/campaigns/${id}/turns/feed`))
      return route.fulfill({
        json: {
          entries: [],
          turns: [],
          canonRevision: 0,
          canSubmit: false,
          configuration: {
            provider: 'mock',
            enabled: true,
            externalCallsEnabled: false,
            demo: true,
            creditPrice: 0,
            providerUpperMicros: 0,
          },
        },
      });
    // Read-only readiness is not token counting, consent or provider dispatch.
    if (method === 'GET' && path.endsWith(`/game/campaigns/${id}/world-generation`))
      return route.fulfill({ json: { available: false, pending: false } });
    if (path.endsWith(`/game/campaigns/${id}/hero`)) return route.fulfill({ json: { hero: null } });
    if (path.endsWith(`/game/campaigns/${id}/chat`))
      return route.fulfill({ json: { messages: [] } });
    if (path.endsWith(`/game/campaigns/${id}/ai/sponsors`))
      return route.fulfill({
        json: { sponsors: [], configuration: { creditPrice: 0, providerUpperMicros: 0 } },
      });
    if (path.endsWith(`/game/campaigns/${id}/ai`))
      return route.fulfill({
        json: {
          configuration: { enabled: true, provider: 'mock', creditPrice: 0 },
          jobs: [],
          wallet: { balance: 0, available: 0, reserved: 0 },
        },
      });
    if (path.endsWith(`/generation/campaigns/${id}/requests`) && method === 'GET')
      return route.fulfill({ json: { turnFence, requests: [r] } });
    if (
      path.endsWith(`/generation/campaigns/${id}/requests/${requestId}/preflight`) &&
      method === 'POST'
    ) {
      const body = route.request().postDataJSON();
      expect(body.turnFence).toEqual(turnFence);
      expect(body.candidateFingerprint).toBe(r.counting.candidateFingerprint);
      expect(body.consent).toBe(true);
      counts.push(body);
      r.counting.attempts++;
      r.counting.latest = {
        id: randomUUID(),
        status: 'succeeded',
        inputTokens: 130000,
        actualMicros: 7,
        resultCode: null,
        costBasis: 'owner_reviewed_fixed_rate',
        invoiceExact: false,
      };
      if (lost) return route.abort();
      return route.fulfill({ json: r.counting.latest });
    }
    if (path.includes('/generation/text-counts/operations/') && method === 'GET') {
      gets.push(path);
      return route.fulfill({ json: r.counting.latest });
    }
    return route.fallback();
  });
  await page.goto(`/game/${id}`);
  await expect(page.getByTestId('unified-story')).toBeVisible();
  await expect(page.getByTestId('live-test-panel')).toHaveCount(0);
  const widget = page.getByTestId('text-count-preflight');
  await expect(widget).toHaveCount(0);
  return {
    ...f,
    id,
    counts,
    gets,
    widget,
    r,
    moves,
    projection: envelope.projection,
    withdrawIllustration: () => {
      illustrationAvailable = false;
    },
  };
}
for (const locale of ['uk', 'en', 'ru'] as const)
  test(`gameplay hides manual token diagnostics and never starts background preflight (${locale})`, async ({
    page,
  }) => {
    const f = await preflightFixture(page, locale, true);
    await expect(f.widget).toHaveCount(0);
    expect(f.counts).toHaveLength(0);
    expect(f.gets).toHaveLength(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await expect(page.getByTestId('unified-story')).toBeVisible();
    await expect(f.widget).toHaveCount(0);
    expect(f.counts).toHaveLength(0);
    expect(f.gets).toHaveLength(0);
    noPaidOrUnexpected(f);
  });
test('a known preflight price does not authorize counting or reconciliation in gameplay', async ({
  page,
}) => {
  const f = await preflightFixture(page, 'en');
  await expect(f.widget).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('unified-story')).toBeVisible();
  expect(f.counts).toHaveLength(0);
  expect(f.gets).toHaveLength(0);
  noPaidOrUnexpected(f);
});

for (const locale of ['uk', 'en', 'ru'] as const)
  test(`saved location art keeps the grid, player, NPC and interactions (${locale})`, async ({
    page,
  }) => {
    const f = await preflightFixture(page, locale, false, false, true);
    const scene = page.locator('[data-battlemap-grid]');
    await expect(scene).toBeVisible();
    await expect(scene.locator('canvas')).toBeVisible();
    await expect(scene).toHaveAttribute('data-battlemap-grid', '24x24');
    await expect(scene).toHaveAttribute('data-art-loaded', '1');
    await expect(scene).toHaveAttribute('data-rendered-players', '1');
    await expect(scene).toHaveAttribute(
      'data-rendered-npcs',
      String(f.projection.entities.filter((e) => e.kind === 'npc').length),
    );
    expect(f.projection.entities.some((e) => e.kind === 'npc')).toBe(true);
    await expect(page.locator('[data-location-illustration]')).toHaveCount(0);
    const actor = f.projection.entities.find((e) => e.id === f.projection.actorId)!;
    await expect(scene).toHaveAttribute('data-rendered-actor-x', String(actor.x));
    await expect(scene).toHaveAttribute('data-rendered-actor-y', String(actor.y));
    const cellPoint = async (x: number, y: number) => {
      await scene.scrollIntoViewIfNeeded();
      return scene.evaluate(
        (element, point) => {
          const rect = element.getBoundingClientRect(),
            data = (element as HTMLElement).dataset;
          return {
            x: rect.left + Number(data.cameraX) + (point.x + 0.5) * 48 * Number(data.cameraScale),
            y: rect.top + Number(data.cameraY) + (point.y + 0.5) * 48 * Number(data.cameraScale),
          };
        },
        { x, y },
      );
    };
    const npc = f.projection.entities.find((e) => e.kind === 'npc')!;
    const actionsLabel = { ru: 'Действия', en: 'Actions', uk: 'Дії' }[locale];
    const actions = page.getByRole('button', { name: actionsLabel, exact: true });
    await actions.focus();
    await actions.press('Enter');
    const menu = page.getByRole('dialog', { name: actionsLabel, exact: true });
    for (const entity of f.projection.entities.filter((e) => e.id !== actor.id))
      await expect(menu.locator(`[data-map-target="${entity.id}"]`)).toBeVisible();
    expect(await menu.locator('section').count()).toBe(
      f.projection.entities.length - 1 + f.projection.map.exits.length,
    );
    const npcActions = menu.locator(`[data-map-target="${npc.id}"]`);
    const npcLabel = await npcActions.locator('strong').innerText();
    const say = npcActions.getByRole('button', {
      name: { ru: 'Сказать', en: 'Say', uk: 'Сказати' }[locale],
      exact: true,
    });
    await say.focus();
    await say.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(actions).toBeFocused();
    await expect(page.getByTestId('unified-story')).toContainText(
      `${{ ru: 'Собеседник', en: 'Recipient', uk: 'Співрозмовник' }[locale]}: ${npcLabel}`,
    );

    const npcPoint = await cellPoint(npc.x, npc.y);
    await page.mouse.click(npcPoint.x, npcPoint.y, { button: 'right' });
    await expect(page.locator(`[data-map-target="${npc.id}"]`)).toBeVisible();
    await menu.press('Escape');
    await expect(menu).toHaveCount(0);
    // A clear, real cell is chosen from the saved projection, not from image pixels.
    const target = Array.from({ length: 24 * 24 }, (_, index) => ({
      x: index % 24,
      y: Math.floor(index / 24),
    })).find(
      (point) =>
        point.x > 1 &&
        point.y > 1 &&
        !f.projection.map.blocked.some((b) => b.x === point.x && b.y === point.y) &&
        !f.projection.entities.some(
          (e) => Math.abs(e.x - point.x) < 2 && Math.abs(e.y - point.y) < 2,
        ) &&
        !f.projection.map.exits.some((e) => e.x === point.x && e.y === point.y),
    )!;
    const targetPoint = await cellPoint(target.x, target.y);
    await page.mouse.click(targetPoint.x, targetPoint.y);
    await expect.poll(() => f.moves).toEqual([target]);
    await expect(scene).toHaveAttribute('data-rendered-actor-x', String(target.x));
    await expect(scene).toHaveAttribute('data-rendered-actor-y', String(target.y));
    await page.screenshot({ path: test.info().outputPath(`location-grid-${locale}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(scene.locator('canvas')).toBeVisible();
    await expect(scene).toHaveAttribute('data-battlemap-grid', '24x24');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`location-grid-${locale}-mobile.png`) });
    await page.reload();
    await expect(scene).toHaveAttribute('data-art-loaded', '1');
    await expect(scene).toHaveAttribute('data-rendered-actor-x', String(target.x));
    await expect(scene).toHaveAttribute(
      'data-rendered-npcs',
      String(f.projection.entities.filter((e) => e.kind === 'npc').length),
    );
    f.withdrawIllustration();
    await expect(scene).toHaveAttribute('data-art-loaded', '0');
    await expect(scene).toHaveAttribute('data-battlemap-grid', '24x24');
    await expect(scene).toHaveAttribute('data-rendered-players', '1');
    expect(f.counts).toHaveLength(0);
    noPaidOrUnexpected(f);
  });

for (const locale of ['ru', 'en', 'uk'] as const)
  test(`live round cost and both balances stay visible without automatic consent (${locale})`, async ({
    page,
  }) => {
    const f = await preflightFixture(page, locale, false, false, true);
    const quotes: Record<string, unknown>[] = [];
    const consents: Record<string, unknown>[] = [];
    let pending = false;
    let unknown = false;
    let estimate = '12500';
    await page.route(`**/api/v1/game/campaigns/${f.id}/world-generation`, (route) =>
      route.fulfill({
        json: {
          available: f.projection.turn!.phase === 'world' && !pending,
          pending,
          unknown,
          forecast: {
            estimatedSparkSubunits: estimate,
            estimatedTotalMicros: 6250,
            requestCount: 2,
            basis: 'local_round_forecast',
            includesMapAnalysis: false,
            finalQuoteRequired: true,
          },
        },
      }),
    );
    await page.route(`**/api/v1/game/campaigns/${f.id}/world-generation/quote`, (route) => {
      quotes.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          quote: {
            id: 'synthetic-live-world-quote',
            external: true,
            requiresConsent: true,
            provider: 'synthetic-no-dispatch',
            providerUpperMicros: 12500,
            credits: 0,
            chargeUnit: 'sparks',
            sparkReservedSubunits: '12500',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            funding: {
              policyVersion: 'dreams-first-v1',
              dreamsReservedSubunits: '12500',
              sparksReservedSubunits: '0',
              totalReservedSubunits: '12500',
              maxSparksSubunits: '12500',
              allocation: 'estimate',
            },
          },
        },
      });
    });
    await page.route(`**/api/v1/game/campaigns/${f.id}/world-generation/consent`, (route) => {
      consents.push(route.request().postDataJSON());
      pending = true;
      return route.fulfill({ json: { accepted: true, pending: true } });
    });
    const wallet = page.getByTestId('game-wallet');
    await expect(wallet).toBeVisible();
    await expect(wallet.getByTestId('sparks-balance')).toHaveText(
      formatSparkSubunits('500000', locale),
    );
    await expect(wallet.getByTestId('dreams-balance')).toHaveText(
      formatSparkSubunits('500000', locale),
    );
    const forecast = page.getByTestId('world-cost-forecast');
    await expect(forecast).toContainText(formatSparkSubunits(estimate, locale));
    estimate = '25000';
    await expect(forecast).toContainText(formatSparkSubunits(estimate, locale));
    expect(quotes).toHaveLength(0);
    expect(consents).toHaveLength(0);
    await page.screenshot({
      path: test.info().outputPath(`live-round-cost-${locale}-desktop.png`),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(wallet).toBeVisible();
    await expect(wallet.getByTestId('sparks-balance')).toBeInViewport();
    await expect(wallet.getByTestId('dreams-balance')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`live-round-cost-${locale}-mobile.png`) });

    // Prior unknown billing remains visible even while the player has input control.
    pending = true;
    unknown = true;
    const reconciliation = {
      ru: 'Стоимость прошлого запроса ещё на сверке.',
      en: 'The previous request’s cost is still being reconciled.',
      uk: 'Вартість попереднього запиту ще на звірці.',
    }[locale];
    await expect(page.getByTestId('world-generation-confirmation')).toContainText(reconciliation);
    await expect(forecast).toHaveCount(0);
    expect(quotes).toHaveLength(0);
    expect(consents).toHaveLength(0);

    // A complete world roster is auto-priced; only the explicit click admits it.
    pending = false;
    unknown = false;
    f.projection.turn = {
      ...f.projection.turn!,
      phase: 'world',
      activeActorId: null,
      ownTurn: false,
      phaseEpoch: f.projection.turn!.phaseEpoch + 1,
    };
    await page.reload();
    const confirmation = page.getByTestId('story-reply-confirmation');
    const confirm = confirmation.getByRole('button', {
      name: { ru: 'Подтвердить ход', en: 'Confirm turn', uk: 'Підтвердити хід' }[locale],
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    expect(quotes).toHaveLength(1);
    expect(consents).toHaveLength(0);
    await expect(confirmation.locator('[data-wallet-funding]')).toBeVisible();
    await confirmation.screenshot({
      path: test.info().outputPath(`live-round-approval-${locale}.png`),
    });
    await confirm.click();
    await expect.poll(() => consents.length).toBe(1);
    expect(consents[0]).toEqual({
      operationId: quotes[0].operationId,
      quoteId: 'synthetic-live-world-quote',
      consent: true,
    });
    expect(quotes).toHaveLength(1);
    noPaidOrUnexpected(f);
  });
