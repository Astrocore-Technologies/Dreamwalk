'use client';
import { useEffect, useState } from 'react';
import { useResource } from '@/lib/client';
import { Button, ErrorBox } from '@/components/ui';
import type { ArtRevision } from './types';
import { artPreviewUrl } from './types';
import { useAssetText } from './messages';
import styles from './assets.module.css';
type Manifest = {
  checksum: string;
  bindings: { slot: string; revision: ArtRevision | { id: string; unavailable: true } }[];
};
export function PinnedArtReview({
  versionId,
  onReady,
}: {
  versionId: string;
  onReady: (value: boolean) => void;
}) {
  const a = useAssetText(),
    resource = useResource<Manifest>(`/asset-library/versions/${versionId}/manifest`);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setLoaded([]);
    setFailed(false);
    setAttempt((value) => value + 1);
    resource.reload();
  };
  const ready =
    !failed &&
    !!resource.data &&
    !resource.loading &&
    !resource.error &&
    resource.data.bindings.every(
      (binding) => !('unavailable' in binding.revision) && loaded.includes(binding.slot),
    );
  useEffect(() => {
    onReady(ready);
    return () => onReady(false);
  }, [ready, onReady]);
  return (
    <section className={styles.root} aria-label={a('review')}>
      <h3>{a('review')}</h3>
      <p>{a('immutable')}</p>
      <ErrorBox message={resource.error} retry={retry} />
      {failed && (
        <>
          <p role="alert">{a('unavailable')}</p>
          <Button type="button" onClick={retry}>
            {a('refresh')}
          </Button>
        </>
      )}
      {resource.loading && <p>{a('loading')}</p>}
      <div className={styles.grid}>
        {resource.data?.bindings.map((binding) => (
          <article className={styles.card} key={binding.slot}>
            <code>{binding.slot}</code>
            {'unavailable' in binding.revision ? (
              <p role="alert">{a('unavailable')}</p>
            ) : (
              <>
                <img
                  key={`${binding.slot}:${attempt}`}
                  loading="lazy"
                  decoding="async"
                  width={binding.revision.width}
                  height={binding.revision.height}
                  src={artPreviewUrl(binding.revision.url)}
                  alt={binding.revision.metadata.title}
                  onLoad={() =>
                    setLoaded((values) =>
                      values.includes(binding.slot) ? values : [...values, binding.slot],
                    )
                  }
                  onError={() => setFailed(true)}
                />
                <h4>{binding.revision.metadata.title}</h4>
                <p>
                  {a('revision')} {binding.revision.revision} · {binding.revision.width} ×{' '}
                  {binding.revision.height}
                </p>
                <p>{binding.revision.metadata.rights.attribution}</p>
                <p>{binding.revision.metadata.rights.licenseLabel}</p>
                <code>{binding.revision.sha256}</code>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
