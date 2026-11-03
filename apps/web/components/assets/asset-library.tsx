'use client';
import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, errorMessage, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Select } from '@/components/ui';
import type { ArtCamera, ArtKind, ArtResolution, ArtRevision, ArtSpec } from './types';
import { artPreviewUrl } from './types';
import { browseArt, canSelectArt } from './browse-art';
import { useAssetText } from './messages';
import { ImageGeneration } from './image-generation';
import { useImageText } from './image-messages';
import { RegisterArt } from './register-art';
import { AssetGrants } from './asset-grants';
import styles from './assets.module.css';
import layout from './library-layout.module.css';
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
  const [kind, setKind] = useState<ArtKind | ''>(requiredKind ?? ''),
    [camera, setCamera] = useState<ArtCamera | ''>(requiredCamera ?? ''),
    [query, setQuery] = useState(''),
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
  const inspector = useRef<HTMLElement>(null);
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
    if (!valid || !kind || !camera) return;
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
  function clearSearch() {
    generation.current++;
    setBusy(false);
    setResults(null);
    setResolution(null);
    setError('');
  }
  function openRegistration(revision?: ArtRevision) {
    setBase(revision);
    setRegister(true);
    setSaved(false);
  }
  function inspect(revision: ArtRevision) {
    setSelected(revision);
    if (window.innerWidth < 1100)
      requestAnimationFrame(() =>
        inspector.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      );
  }
  const visible = browseArt(results ?? catalog.data ?? [], {
    query,
    kind,
    camera,
    tags: tagList,
    variant,
    minWidth,
    minHeight,
  });
  const current = visible.find((revision) => revision.id === selected?.id) ?? visible[0];
  return (
    <section className={`${styles.root} ${layout.library}`} aria-label={a('title')}>
      <header className={layout.heading}>
        <h2>{a('title')}</h2>
        <details className={layout.rightsHelp}>
          <summary>
            <ShieldCheck size={16} aria-hidden="true" />
            {a('rightsHelp')}
          </summary>
          <div>
            <p>{a('intro')}</p>
            <p>{a('drawn')}</p>
          </div>
        </details>
      </header>
      <div className={layout.workspace}>
        <div className={layout.browser}>
          <div className={layout.searchRow}>
            <label className={layout.searchBox}>
              <Search size={20} aria-hidden="true" />
              <Input
                type="search"
                aria-label={a('browseSearch')}
                placeholder={a('browseSearch')}
                value={query}
                maxLength={240}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button type="button" onClick={() => openRegistration()}>
              <Plus size={20} aria-hidden="true" />
              {a('register')}
            </Button>
          </div>
          <form
            className={layout.filterForm}
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <div className={layout.filters}>
              <Field label={a('kind')}>
                <Select
                  aria-label={a('kind')}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as ArtKind | '');
                    clearSearch();
                  }}
                >
                  <option value="">{a('anyKind')}</option>
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
                  onChange={(event) => {
                    setCamera(event.target.value as ArtCamera | '');
                    clearSearch();
                  }}
                >
                  <option value="">{a('anyCamera')}</option>
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
                  onChange={(event) => {
                    setTags(event.target.value);
                    clearSearch();
                  }}
                />
              </Field>
              <Field label={a('variant')}>
                <Input
                  value={variant}
                  maxLength={80}
                  onChange={(event) => {
                    setVariant(event.target.value);
                    clearSearch();
                  }}
                />
              </Field>
            </div>
            <details className={layout.advanced}>
              <summary>{a('matchOptions')}</summary>
              <div className={styles.fields}>
                <Field label={a('minWidth')}>
                  <Input
                    type="number"
                    min={1}
                    max={4096}
                    value={minWidth}
                    onChange={(event) => {
                      setWidth(Number(event.target.value));
                      clearSearch();
                    }}
                  />
                </Field>
                <Field label={a('minHeight')}>
                  <Input
                    type="number"
                    min={1}
                    max={4096}
                    value={minHeight}
                    onChange={(event) => {
                      setHeight(Number(event.target.value));
                      clearSearch();
                    }}
                  />
                </Field>
              </div>
              <p className={styles.notice}>{a('matchHint')}</p>
              <div className={styles.actions}>
                <Button type="submit" busy={busy} disabled={!valid || !kind || !camera}>
                  {a('search')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || !valid || !kind || !camera}
                  onClick={() => void search(true)}
                >
                  {a('resolve')}
                </Button>
              </div>
            </details>
          </form>
          <div className={layout.resultBar}>
            <p>{a(results === null ? 'catalogLimit' : 'searchLimit')}</p>
            <Button type="button" variant="ghost" onClick={refresh}>
              <RefreshCw size={15} aria-hidden="true" />
              {a('refresh')}
            </Button>
          </div>
          <ErrorBox message={error || catalog.error} />
          {resolution && (
            <p role="status">{a(resolution.decision === 'reuse' ? 'matched' : 'proposal')}</p>
          )}
          {saved && <p role="status">{a('saved')}</p>}
          {catalog.loading && <p role="status">{a('loading')}</p>}
          <div className={layout.artGrid}>
            {visible.map((revision) => (
              <article
                className={layout.artCard}
                key={revision.id}
                data-art-revision={revision.id}
                data-selected={current?.id === revision.id}
              >
                <button
                  type="button"
                  className={layout.cardImage}
                  aria-label={`${a('details')}: ${revision.metadata.title}`}
                  aria-pressed={current?.id === revision.id}
                  onClick={() => inspect(revision)}
                >
                  {artPreviewUrl(revision.url) ? (
                    <img
                      loading="lazy"
                      decoding="async"
                      width={revision.width}
                      height={revision.height}
                      src={artPreviewUrl(revision.url)}
                      alt={revision.metadata.title}
                    />
                  ) : (
                    <ImageIcon size={36} aria-hidden="true" />
                  )}
                </button>
                <div className={layout.cardBody}>
                  <h3>{revision.metadata.title}</h3>
                  <p className={layout.kind}>
                    <ImageIcon size={16} aria-hidden="true" />
                    {a(revision.metadata.kind)}
                  </p>
                  <div className={layout.cardMeta}>
                    <span>
                      {a('revision')} {revision.revision}
                    </span>
                    <span>{a(revision.owned ? 'own' : 'shared')}</span>
                  </div>
                  <div className={layout.cardActions}>
                    <Button type="button" variant="ghost" onClick={() => inspect(revision)}>
                      {a('details')}
                    </Button>
                    {onSelected && (
                      <Button
                        type="button"
                        disabled={!canSelectArt(revision, requiredKind, requiredCamera)}
                        onClick={() => onSelected(revision)}
                      >
                        {a('use')}
                      </Button>
                    )}
                    {revision.owned && (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={a('newRevision')}
                        onClick={() => openRegistration(revision)}
                      >
                        <Plus size={18} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!catalog.loading && !visible.length && (
            <div className={layout.empty}>
              <ImageIcon size={36} aria-hidden="true" />
              <p>{a('empty')}</p>
            </div>
          )}
        </div>
        <aside
          ref={inspector}
          className={layout.inspector}
          aria-label={a('selectedArt')}
          data-art-inspector
        >
          <h3>{a('selectedArt')}</h3>
          {current ? (
            <div className={layout.inspectorBody}>
              {artPreviewUrl(current.url) && (
                <img
                  className={layout.inspectorImage}
                  src={artPreviewUrl(current.url)}
                  width={current.width}
                  height={current.height}
                  alt={current.metadata.title}
                />
              )}
              <h4>{current.metadata.title}</h4>
              <p className={layout.kind}>
                <ImageIcon size={17} aria-hidden="true" />
                {a(current.metadata.kind)}
                <span className={layout.revision}>
                  {a('revision')} {current.revision}
                </span>
              </p>
              <dl className={layout.metadata}>
                <dt>{a('dimensions')}</dt>
                <dd>
                  {current.width} × {current.height}
                </dd>
                <dt>{a('camera')}</dt>
                <dd>{a(current.metadata.camera)}</dd>
                <dt>{a('variant')}</dt>
                <dd>{current.metadata.variant}</dd>
                <dt>{a('tagLabel')}</dt>
                <dd className={layout.tags}>
                  {current.metadata.tags.length
                    ? current.metadata.tags.map((tag) => <span key={tag}>{tag}</span>)
                    : '—'}
                </dd>
                <dt>{a('basis')}</dt>
                <dd>
                  {a(
                    current.metadata.rights.basis === 'owned'
                      ? 'rightsOwned'
                      : current.metadata.rights.basis === 'licensed'
                        ? 'rightsLicensed'
                        : 'rightsGenerated',
                  )}
                </dd>
                <dt>{a('license')}</dt>
                <dd>{current.metadata.rights.licenseLabel}</dd>
                {current.metadata.rights.attribution && (
                  <>
                    <dt>{a('attribution')}</dt>
                    <dd>{current.metadata.rights.attribution}</dd>
                  </>
                )}
                <dt>{a('provenance')}</dt>
                <dd>
                  {a(
                    current.metadata.provenance.source === 'upload'
                      ? 'uploadedSource'
                      : current.metadata.provenance.source === 'generated'
                        ? 'generatedSource'
                        : 'licensed-import',
                  )}
                </dd>
              </dl>
              <p className={styles.notice}>{a('immutable')}</p>
              <div className={styles.actions}>
                {onSelected && (
                  <Button
                    type="button"
                    disabled={!canSelectArt(current, requiredKind, requiredCamera)}
                    onClick={() => onSelected(current)}
                  >
                    {a('use')}
                  </Button>
                )}
                {current.owned && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => openRegistration(current)}
                  >
                    {a('newRevision')}
                  </Button>
                )}
              </div>
              {current.owned &&
                (selected?.id === current.id ? (
                  <AssetGrants key={current.id} revision={current} onChanged={refresh} />
                ) : (
                  <Button type="button" variant="ghost" onClick={() => setSelected(current)}>
                    {a('grants')}
                  </Button>
                ))}
            </div>
          ) : (
            <p className={layout.inspectorEmpty}>{a('selectHint')}</p>
          )}
        </aside>
      </div>
      {adventureId ? (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={
              !valid ||
              !kind ||
              !camera ||
              !['background', 'sprite', 'portrait', 'object'].includes(kind) ||
              !['top-down', 'portrait', 'unrestricted'].includes(camera)
            }
            onClick={() => setGenerationOpen((value) => !value)}
          >
            {g('title')}
          </Button>
          {generationOpen && kind && camera && (
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
