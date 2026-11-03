import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function setup(page: Page) {
  const ownerId = randomUUID(),
    heroId = randomUUID(),
    projectId = randomUUID(),
    revisionId = randomUUID(),
    jobId = randomUUID();
  const project = { id: projectId, revision: 1, kind: 'character', status: 'concept' };
  const revision = {
    id: revisionId,
    familyId: randomUUID(),
    revision: 1,
    owned: true,
    canReuse: true,
    width: 1024,
    height: 1024,
    url: `/api/v1/asset-library/revisions/${revisionId}/file`,
    metadata: {
      title: 'Owned full-body concept',
      kind: 'sprite',
      camera: 'top-down',
      style: 'drawn2D',
      tags: [],
    },
  };
  const counters = { quote: 0, dispatch: 0, reuse: 0 };
  let quote: Record<string, unknown> | null = null;
  let jobStatus: string | null = null;
  let selected = false;
  let ttl = 60000;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let json: unknown = {};
    if (path === '/auth/me')
      json = {
        user: {
          id: ownerId,
          role: 'user',
          name: 'Sprite QA',
          handle: 'sprite_qa',
          onboarded: true,
          settings: { language: 'en', theme: 'dark' },
        },
      };
    else if (path === '/heroes')
      json = [
        {
          id: heroId,
          name: 'Aster',
          backstory: 'An adult fictional traveler',
          notes: '',
          traits: [],
          portraitAssetId: null,
        },
      ];
    else if (path === '/generation/status')
      json = {
        enabled: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
        state: 'active',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        remainingMicros: 1000000,
        imagesEnabled: true,
      };
    else if (path === '/visual-authoring/character-sprite/prepare') json = project;
    else if (path === `/visual-authoring/projects/${projectId}/generation`)
      json = {
        projectId,
        projectRevision: 1,
        mode: 'external',
        requiredRoles: ['concept'],
        items: [
          {
            role: 'concept',
            stage: 'concept',
            status: jobStatus || (selected ? 'admitted' : quote ? 'quoted' : 'idle'),
            quote: quote ? { decision: 'quote', matches: [], quote } : null,
            ...(jobStatus
              ? {
                  job: {
                    id: jobId,
                    status: jobStatus,
                    mode: 'external',
                    heldMicros: 100000,
                    canCancel: false,
                  },
                }
              : {}),
            ...(selected
              ? {
                  revisionId,
                  url: revision.url,
                  validation: { valid: true, width: 1024, height: 1024 },
                }
              : {}),
          },
        ],
        configuration: {
          externalEnabled: true,
          externalBlockReasons: [],
          verifiedUpperMicros: 100000,
        },
        readyForReview: selected,
        automaticRetry: false,
        humanVisualReviewRequired: true,
      };
    else if (path.endsWith('/generation/quote')) {
      counters.quote++;
      quote = {
        id: randomUUID(),
        mode: 'external',
        upperMicros: 100000,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        rightsAttestationRequired: true,
        sparks: {
          quoteId: randomUUID(),
          reserveSubunits: '100000',
          rateVersion: 'test',
          walletCharging: true,
        },
      };
    } else if (path.endsWith('/generation/dispatch')) {
      counters.dispatch++;
      const body = route.request().postDataJSON();
      expect(body.consent).toBe(true);
      expect(body.quoteId).toBe(quote?.id);
      expect(body.operationId).toBeTruthy();
      jobStatus = 'dispatched';
    } else if (path.endsWith('/generation/reuse')) {
      counters.reuse++;
      expect(route.request().postDataJSON().semanticReview).toBe(true);
      expect(route.request().postDataJSON().revisionId).toBe(revisionId);
      selected = true;
    } else if (path === '/asset-library')
      json = [
        revision,
        {
          ...revision,
          id: randomUUID(),
          owned: false,
          metadata: { ...revision.metadata, title: 'Not owned' },
        },
      ];
    else if (path === `/asset-library/revisions/${revisionId}`) json = revision;
    else if (path.endsWith('/file'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    return route.fulfill({ json });
  });
  await page.addInitScript(() => localStorage.setItem('dreamwalk-language', 'en'));
  await page.goto('/my-characters');
  await page.getByRole('button', { name: 'Prepare sprite', exact: true }).click();
  return {
    counters,
    setTtl(value: number) {
      ttl = value;
    },
    setJobStatus(value: string) {
      jobStatus = value;
    },
  };
}

test('character generation has two actions, expires safely and shows honest pending/unknown status', async ({
  page,
}) => {
  const fixture = await setup(page);
  const stages = page.getByTestId('external-generation');
  const concept = stages.locator('[data-generation-role="concept"]');
  await expect(concept.getByRole('button')).toHaveCount(2);
  await expect(stages.getByRole('button', { name: 'Refresh stages', exact: true })).toHaveCount(0);
  fixture.setTtl(1500);
  await concept.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await expect(concept.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await expect(concept.locator('[data-spark-quote-price]')).toBeVisible();
  expect(fixture.counters.dispatch).toBe(0);
  await expect(concept.getByRole('button', { name: 'Estimate cost', exact: true })).toBeVisible({
    timeout: 5000,
  });
  await expect(concept.getByRole('button', { name: 'Generate', exact: true })).toHaveCount(0);
  fixture.setTtl(60000);
  await concept.getByRole('button', { name: 'Estimate cost', exact: true }).click();
  await concept.getByRole('button', { name: 'Generate', exact: true }).dblclick();
  await expect(concept.locator('[data-generation-progress="dispatched"]')).toBeVisible();
  expect(fixture.counters.dispatch).toBe(1);
  fixture.setJobStatus('unknown');
  await expect(concept.locator('[data-generation-progress]')).toHaveCount(0);
  await expect(concept.getByRole('button', { name: 'Generate', exact: true })).toHaveCount(0);
  await expect(concept.getByRole('button', { name: 'Estimate cost', exact: true })).toHaveCount(0);
  expect(fixture.counters.dispatch).toBe(1);
});

test('owned library selection is available before estimating and never dispatches', async ({
  page,
}) => {
  const fixture = await setup(page);
  const concept = page.locator('[data-generation-role="concept"]');
  await concept.getByRole('button', { name: 'Take from library', exact: true }).click();
  const library = page.getByRole('dialog');
  await expect(library.getByText('Owned full-body concept', { exact: true })).toBeVisible();
  await expect(library.getByText('Not owned', { exact: true })).toHaveCount(0);
  await library.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(library).toHaveCount(0);
  expect(fixture.counters.reuse).toBe(1);
  expect(fixture.counters.quote).toBe(0);
  expect(fixture.counters.dispatch).toBe(0);
});
