/** Real raster reuse attached to evolving campaign canon, never automatic image generation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  moveTo,
  command,
  operation,
  path,
  until,
} from './support-runtime.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sharp = require('sharp');
const base = process.env.TEST_GAME_API_URL;
async function raster(user, color) {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'director-fixture.png');
  const response = await fetch(base + '/assets', {
    method: 'POST',
    headers: { cookie: user.cookie, origin: process.env.WEB_ORIGIN },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201);
  const upload = await response.json();
  return user.request('/asset-library/revisions', {
    operationId: randomUUID(),
    uploadId: upload.id,
    metadata: {
      title: 'Actual reusable drawn floor',
      kind: 'background',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['floor'],
      variant: 'day',
      provenance: { source: 'upload', reference: 'PRIVATE_ART_PROVENANCE' },
      rights: {
        basis: 'owned',
        licenseLabel: 'Author owned',
        attribution: 'Synthetic fixture',
        allowAuthorReuse: true,
        attested: true,
      },
    },
  });
}
async function file(user, revision, campaign, expected) {
  const response = await fetch(
    `${base}/asset-library/revisions/${revision}/file?campaignId=${campaign}`,
    {
      headers: { cookie: user.cookie, origin: process.env.WEB_ORIGIN },
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(response.status, expected);
  if (response.ok) {
    assert.match(response.headers.get('content-type'), /image\/webp/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
}
await test(
  'new narrative scenes use immutable authorized raster pins without spending or altering the source',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        artist = await client().register(),
        outsider = await client().register();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const sourceBefore = (
        await db.query('SELECT checksum,package FROM game_playable_versions WHERE id=$1', [
          source.playableVersionId,
        ])
      ).rows[0];
      const art = await raster(artist, '#31233c'),
        hidden = await raster(outsider, '#b7aa86');
      const grant = await artist.request(`/asset-library/revisions/${art.id}/grants`, {
        operationId: randomUUID(),
        granteeHandle: owner.handle,
        consent: true,
        retainExistingPins: true,
      });
      const { campaignId: id } = await owner.request('/game/campaigns', {
        playableVersionId: source.playableVersionId,
      });
      await owner.request(path(id, 'invitations'), { username: guest.handle });
      await guest.request(path(id, 'accept'), {});
      const text = 'Find a new room to illustrate from its real geometry.';
      const quote = await owner.request(path(id, 'narrative/quote'), {
        text,
        expectedCanonRevision: 0,
      });
      const turn = await owner.request(path(id, 'narrative'), {
        text,
        expectedCanonRevision: 0,
        operationId: randomUUID(),
        quoteId: quote.id,
        consent: true,
      });
      const result = await until(
        () => owner.request(path(id, 'narrative')),
        (v) => v.turns.some((x) => x.id === turn.id && x.status === 'committed'),
        15000,
      );
      const committed = result.turns.find((x) => x.id === turn.id);
      const world = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0]
        .state;
      const link = world.maps.observatory.exits.find(
        (e) => e.destinationMapId === committed.sceneId,
      );
      for (const user of [owner, guest]) {
        await moveTo(user, id, { x: link.x, y: link.y });
        assert.equal(
          (await command(user, id, operation({ kind: 'transition', targetId: link.id }))).status,
          'committed',
        );
      }
      const body = {
        operationId: randomUUID(),
        expectedCanonRevision: 1,
        expectedMapId: committed.sceneId,
        kind: 'background',
        revisionId: art.id,
      };
      await t.test(
        'grounded library search excludes ungranted private assets and has no generation side effect',
        async () => {
          const before = (await db.query('SELECT count(*)::int n FROM image_generation_jobs'))
            .rows[0].n;
          const prep = await owner.request(path(id, 'media-preparation'), { kind: 'background' });
          assert.ok(prep.matches.some((r) => r.id === art.id));
          assert.ok(!prep.matches.some((r) => r.id === hidden.id));
          assert.equal(prep.grounding.mapId, committed.sceneId);
          assert.equal(prep.providerCalls, 0);
          assert.equal(prep.charge, 0);
          assert.ok(!JSON.stringify(prep).includes('PRIVATE_ART_PROVENANCE'));
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM image_generation_jobs')).rows[0].n,
            before,
          );
        },
      );
      await t.test(
        'only host can pin current canonical slot; CAS and immutable operation replay are enforced',
        async () => {
          await guest.request(path(id, 'media-bindings'), body, 'POST', 403);
          await owner.request(
            path(id, 'media-bindings'),
            { ...body, expectedCanonRevision: 0 },
            'POST',
            409,
          );
          const applied = await owner.request(path(id, 'media-bindings'), body);
          assert.equal(applied.charge, 0);
          assert.equal(applied.revisionId, art.id);
          const replay = await owner.request(path(id, 'media-bindings'), body);
          for (const field of ['status', 'slot', 'revisionId', 'charge'])
            assert.deepEqual(replay[field], applied[field]);
          await owner.request(
            path(id, 'media-bindings'),
            { ...body, revisionId: hidden.id },
            'POST',
            409,
          );
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM art_campaign_pins WHERE campaign_id=$1', [
                id,
              ])
            ).rows[0].n,
            1,
          );
          assert.deepEqual(
            (
              await db.query('SELECT checksum,package FROM game_playable_versions WHERE id=$1', [
                source.playableVersionId,
              ])
            ).rows[0],
            sourceBefore,
          );
        },
      );
      await t.test(
        'shared accepted players receive real raster after restart, outsider cannot use campaign URL',
        async () => {
          await file(owner, art.id, id, 200);
          await file(guest, art.id, id, 200);
          await file(outsider, art.id, id, 404);
          await stopApi('SIGKILL');
          await startApi();
          await file(guest, art.id, id, 200);
          const s = await snapshot(guest, id);
          assert.ok(JSON.stringify(s.projection).includes(art.id));
        },
      );
      await t.test(
        'revoking reuse grant blocks future pins but retains approved old pin until takedown',
        async () => {
          await artist.request(`/asset-library/revisions/${art.id}/grants/${grant.id}/revoke`, {
            operationId: randomUUID(),
          });
          await file(guest, art.id, id, 200);
          const next = await owner.request('/game/campaigns', {
            playableVersionId: source.playableVersionId,
          });
          await owner.request(
            path(next.campaignId, 'media-bindings'),
            {
              operationId: randomUUID(),
              expectedCanonRevision: 0,
              expectedMapId: 'observatory',
              kind: 'background',
              revisionId: art.id,
            },
            'POST',
            404,
          );
          await artist.request(`/asset-library/revisions/${art.id}/takedown`, {
            operationId: randomUUID(),
            confirm: true,
          });
          await file(owner, art.id, id, 404);
          await file(guest, art.id, id, 404);
          await until(
            () => snapshot(guest, id),
            (s) => !JSON.stringify(s.projection).includes(art.id),
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
