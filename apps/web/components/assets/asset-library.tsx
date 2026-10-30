'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Select } from '@/components/ui';
import type { ArtCamera, ArtKind, ArtResolution, ArtRevision, ArtSpec } from './types';
import { artCameraMatches, artPreviewUrl } from './types';
import { useAssetText } from './messages';
import { ImageGeneration } from './image-generation';
import { useImageText } from './image-messages';
import { RegisterArt } from './register-art';
import { AssetGrants } from './asset-grants';
import styles from './assets.module.css';
export function AssetLibrary({
  onSelected,
  requiredKind,
  requiredCamera,
  adventureId,
}: {
  onSelected?: (revision: ArtRevision) => void;
  requiredKind?: ArtKind;
  requiredCamera?: ArtCamera;
  adventureId?: string;
}) {
  const g = useImageText();
  const [generationOpen, setGenerationOpen] = useState(false);
  const a = useAssetText(),
    catalog = useResource<ArtRevision[]>('/asset-library');
  const [kind, setKind] = useState<ArtKind>(requiredKind ?? 'background'),
    [camera, setCamera] = useState<ArtCamera>(requiredCamera ?? 'top-down'),
    [tags, setTags] = useState(''),
    [variant, setVariant] = useState(''),
    [minWidth, setWidth] = useState(1),
    [minHeight, setHeight] = useState(1),
    [results, setResults] = useState<ArtRevision[] | null>(null),
    [resolution, setResolution] = useState<ArtResolution | null>(null),
    [selected, setSelected] = useState<ArtRevision | null>(null),
    [register, setRegister] = useState(false),
    [base, setBase] = useState<ArtRevision | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const tagList = [
    ...new Set(
      tags
        .split(',')
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
  const valid =
    tagList.length <= 24 &&
    tagList.every((tag) => tag.length <= 48) &&
    [minWidth, minHeight].every((value) => Number.isInteger(value) && value >= 1 && value <= 4096);
  async function search(resolve = false) {
    if (!valid) return;
    const request = ++generation.current;
    setBusy(true);
    setError('');
    setResolution(null);
    const spec: ArtSpec = {
      kind,
      style: 'drawn2D',
      camera,
      tags: tagList,
      minWidth,
      minHeight,
      ...(variant.trim() ? { variant: variant.trim() } : {}),
    };
    try {
      if (resolve) {
        const result = await api<ArtResolution>('/asset-library/resolve', {
          method: 'POST',
          body: JSON.stringify(spec),
        });
        if (request === generation.current) {
          setResolution(result);
          setResults(result.revision ? [result.revision, ...result.alternatives] : []);
        }
      } else {
        const result = await api<ArtRevision[]>('/asset-library/search', {
          method: 'POST',
          body: JSON.stringify(spec),
        });
        if (request === generation.current) setResults(result);
      }
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  function refresh() {
    generation.current++;
    setBusy(false);
    setResults(null);
    setResolution(null);
    setSelected(null);
    catalog.reload();
  }
  const visible = results ?? catalog.data ?? [];
  return (
    <section className={styles.root} aria-label={a('title')}>
      <header>
        <h2>{a('title')}</h2>
        <p>{a('intro')}</p>
        <p className={styles.notice}>{a('drawn')}</p>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <fieldset disabled={busy}>
          <div className={styles.fields}>
            <Field label={a('kind')}>
              <Select
                aria-label={a('kind')}
                value={kind}
                onChange={(event) => setKind(event.target.value as ArtKind)}
              >
                {(['background', 'portrait', 'sprite', 'object', 'effect', 'ui'] as const).map(
                  (key) => (
                    <option key={key} value={key}>
                      {a(key)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label={a('camera')}>
              <Select
                aria-label={a('camera')}
                value={camera}
                onChange={(event) => setCamera(event.target.value as ArtCamera)}
              >
                {(['top-down', 'side', 'isometric', 'portrait', 'unrestricted'] as const).map(
                  (key) => (
                    <option key={key} value={key}>
                      {a(key)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label={a('tags')}>
              <Input
                value={tags}
                maxLength={1200}
                onChange={(event) => setTags(event.target.value)}
              />
            </Field>
            <Field label={a('variant')}>
              <Input
                value={variant}
                maxLength={80}
                onChange={(event) => setVariant(event.target.value)}
              />
            </Field>
            <Field label={a('minWidth')}>
              <Input
                type="number"
                min={1}
                max={4096}
                value={minWidth}
                onChange={(event) => setWidth(Number(event.target.value))}
              />
            </Field>
            <Field label={a('minHeight')}>
              <Input
                type="number"
                min={1}
                max={4096}
                value={minHeight}
                onChange={(event) => setHeight(Number(event.target.value))}
              />
            </Field>
          </div>
          <div className={styles.actions}>
            <Button type="submit" disabled={!valid}>
              {a('search')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!valid}
              onClick={() => void search(true)}
            >
              {a('resolve')}
            </Button>
          </div>
        </fieldset>
      </form>
      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={refresh}>
          {a('refresh')}
        </Button>
        <Button
          type="button"
          onClick={() => {
            setBase(undefined);
            setRegister(true);
            setSaved(false);
          }}
        >
          {a('register')}
        </Button>
      </div>
      <ErrorBox message={error || catalog.error} />
      {resolution && (
        <p role="status">{a(resolution.decision === 'reuse' ? 'matched' : 'proposal')}</p>
      )}
      {saved && <p role="status">{a('saved')}</p>}
      {catalog.loading && <p>{a('loading')}</p>}
      <p>{a(results === null ? 'catalogLimit' : 'searchLimit')}</p>
      <div className={styles.grid}>
        {visible.map((revision) => (
          <article className={styles.card} key={revision.id} data-art-revision={revision.id}>
            {artPreviewUrl(revision.url) && (
              <img
                loading="lazy"
                decoding="async"
                width={revision.width}
                height={revision.height}
                src={artPreviewUrl(revision.url)}
                alt={revision.metadata.title}
              />
            )}
            <h3>{revision.metadata.title}</h3>
            <p>
              {a('revision')} {revision.revision} · {revision.width} × {revision.height}
            </p>
            <p>{a(revision.owned ? 'own' : 'shared')}</p>
            <p>{revision.metadata.tags.join(', ')}</p>
            <p>{revision.metadata.rights.attribution}</p>
            <div className={styles.actions}>
              <Button type="button" variant="secondary" onClick={() => setSelected(revision)}>
                {a('details')}
              </Button>
              {onSelected && (
                <Button
                  type="button"
                  disabled={
                    !revision.canReuse ||
                    (!!requiredKind && revision.metadata.kind !== requiredKind) ||
                    !artCameraMatches(requiredCamera, revision.metadata.camera)
                  }
                  onClick={() => onSelected(revision)}
                >
                  {a('use')}
                </Button>
              )}
              {revision.owned && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setBase(revision);
                    setRegister(true);
                    setSaved(false);
                  }}
                >
                  {a('newRevision')}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!catalog.loading && !visible.length && <p>{a('empty')}</p>}
      {selected?.owned && <AssetGrants key={selected.id} revision={selected} onChanged={refresh} />}
      {adventureId ? (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={
              !valid ||
              !['background', 'sprite', 'portrait', 'object'].includes(kind) ||
              !['top-down', 'portrait', 'unrestricted'].includes(camera)
            }
            onClick={() => setGenerationOpen((value) => !value)}
          >
            {g('title')}
          </Button>
          {generationOpen && (
            <ImageGeneration
              adventureId={adventureId}
              spec={{
                kind,
                style: 'drawn2D',
                camera,
                tags: tagList,
                minWidth,
                minHeight,
                ...(variant.trim() ? { variant: variant.trim() } : {}),
              }}
              onSelected={onSelected}
              onAdmitted={() => catalog.reload()}
            />
          )}
        </>
      ) : (
        <p>{g('source')}</p>
      )}
      {register && (
        <RegisterArt
          key={base?.id || 'new'}
          base={base}
          onCancel={() => setRegister(false)}
          onSaved={(revision) => {
            setRegister(false);
            setSaved(true);
            setSelected(revision);
            setResults(null);
            catalog.reload();
          }}
        />
      )}
    </section>
  );
}
