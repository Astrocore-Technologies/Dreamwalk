/** Synthetic local-only fixtures. No provider transport, URL references or credentials. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { storyInput } from '../game/support-authored.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sharp = require('sharp');
export const operationId = () => randomUUID();
export const failureCode = (code) => (error) => error?.getResponse?.().code === code;
export async function createStory(user) {
  return user.request('/studio/adventures', storyInput('private'));
}
export async function fixturePng(transparent = false) {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 110, g: 80, b: 130, alpha: transparent ? 0.5 : 1 },
    },
  })
    .png()
    .toBuffer();
}
export const fixtureMetadata = {
  title: 'Synthetic drawn image fixture',
  kind: 'background',
  style: 'drawn2D',
  camera: 'top-down',
  tags: ['image-acceptance'],
  variant: 'day',
  provenance: { source: 'upload', reference: 'synthetic-owned-fixture' },
  rights: {
    basis: 'owned',
    licenseLabel: 'Author owned fixture',
    attribution: 'Synthetic author',
    allowAuthorReuse: true,
    attested: true,
  },
};
export async function uploadFixture(user) {
  const form = new FormData();
  form.append('file', new Blob([await fixturePng()], { type: 'image/png' }), 'fixture.png');
  const response = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
    method: 'POST',
    headers: { cookie: user.cookie, origin: process.env.WEB_ORIGIN },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201);
  const blob = await response.json();
  return user.request('/asset-library/revisions', {
    operationId: operationId(),
    uploadId: blob.id,
    metadata: fixtureMetadata,
  });
}
