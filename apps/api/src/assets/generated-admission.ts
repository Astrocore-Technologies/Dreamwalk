import type { PoolClient } from 'pg';
import { storeRasterTx, type NormalizedRaster } from './raster';
import { AssetReuseService } from './reuse.service';
import type { GenerationRequest } from '../image-generation/contracts';
/** Same transaction as job admission; IDs were assigned durably at enqueue, never regenerated. */
export async function admitGeneratedRaster(
  c: PoolClient,
  assets: AssetReuseService,
  job: {
    id: string;
    actor_id: string;
    upload_id: string;
    family_id: string;
    revision_id: string;
    request_hash: string;
  },
  input: GenerationRequest,
  raster: NormalizedRaster,
  provider: string,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `art-owner:${job.actor_id}`,
  ]);
  await storeRasterTx(c, job.actor_id, job.upload_id, raster, job.id);
  return assets.registerTx(
    c,
    job.actor_id,
    {
      operationId: job.id,
      uploadId: job.upload_id,
      metadata: {
        title: input.title,
        kind: input.kind,
        style: 'drawn2D',
        camera: input.camera,
        tags: input.tags,
        variant: 'generated',
        provenance: { source: 'generated', provider, reference: job.request_hash },
        rights: input.rights,
      },
    },
    { familyId: job.family_id, revisionId: job.revision_id },
  );
}
