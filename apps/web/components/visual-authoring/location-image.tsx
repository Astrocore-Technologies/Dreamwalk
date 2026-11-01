'use client';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { api, ApiError, errorMessage, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Modal, Select, Textarea } from '../ui';
import { AssetLibrary } from '../assets/asset-library';
import { ImageGeneration, type PreparedStudioLocationRequest } from '../assets/image-generation';
import { artPreviewUrl, type ArtRevision } from '../assets/types';
import { LiveTestPanel, useLiveTestStatus } from '../live-test/live-test-panel';
import { formatUsd, liveSessionActive } from '../live-test/types';
import { useLocationImageText } from './location-image-messages';
import { ownerImageEstimateAvailable, type ImageConfiguration } from './generation-types';
import styles from './workshop.module.css';

type Preparation = {
  request: PreparedStudioLocationRequest;
  sourceHash: string;
  sourceRevision: number;
  location: { id: string; name: string };
  binding: null | { revisionId: string; sourceHash: string; stale: boolean; mapId?: string };
  playable: { revision: number; artRevision: number; maps: { id: string; label: string }[] };
};
export function useLocationImageConfiguration() {
  const config = useResource<ImageConfiguration>('/image-generation/config');
  const live = useLiveTestStatus();
  return { config: config.data, configError: config.error, live };
}
type Configuration = ReturnType<typeof useLocationImageConfiguration>;
const verified = (config: ImageConfiguration | null) =>
  typeof config?.verifiedUpperMicros === 'number' &&
  Number.isFinite(config.verifiedUpperMicros) &&
  config.verifiedUpperMicros >= 0;
const estimateAllowed = (settings: Configuration) =>
  settings.live.status?.mode === 'owner' && ownerImageEstimateAvailable(settings.config);
function LocationImageStatus({ settings, saved }: { settings: Configuration; saved: boolean }) {
  const m = useLocationImageText(),
    { locale } = useT(),
    config = settings.config;
  return (
    <div className={styles.locationImageStatus}>
      {!config ? (
        <p>{m('loading')}</p>
      ) : (
        <>
          <p>
            {m('provider')}: {config.requestProfile?.provider ?? m('notConfigured')} · {m('model')}:{' '}
            {config.requestProfile?.model ?? m('notConfigured')}
          </p>
          {typeof config.estimatedTotalMicros === 'number' && (
            <p>
              {m('estimate')}: {formatUsd(config.estimatedTotalMicros, locale)}
            </p>
          )}
          {typeof config.reserveMicros === 'number' && (
            <p>
              {m('reserve')}: {formatUsd(config.reserveMicros, locale)}
            </p>
          )}
          {verified(config) ? (
            <p>
              {m('bound')}: {formatUsd(config.verifiedUpperMicros!, locale)}
            </p>
          ) : (
            <p role="status">{m(estimateAllowed(settings) ? 'estimateRisk' : 'unverified')}</p>
          )}
          {!config.externalEnabled && <p>{m('unavailable')}</p>}
          {config.externalBlockReasons?.map((code) => (
            <small key={code}>
              <code>{code}</code>
            </small>
          ))}
          {saved && !liveSessionActive(settings.live.status) && (
            <p>{m(settings.live.status?.mode === 'owner' ? 'ownerAuthorization' : 'session')}</p>
          )}
        </>
      )}
      {!saved && <p>{m('saveFirst')}</p>}
      <ErrorBox message={settings.configError} />
    </div>
  );
}
export function LocationImageAction({
  settings,
  locationId,
  saved,
  disabled,
  onOpen,
}: {
  settings: Configuration;
  locationId: string;
  saved: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const m = useLocationImageText();
  const allowed =
    settings.config?.externalEnabled &&
    (verified(settings.config) || estimateAllowed(settings)) &&
    liveSessionActive(settings.live.status) &&
    !!settings.live.status?.imagesEnabled;
  return (
    <section
      className={styles.locationImage}
      data-location-art={locationId}
      aria-label={m('title')}
    >
      <strong>{m('title')}</strong>
      <p>{m('intro')}</p>
      <LocationImageStatus settings={settings} saved={saved} />
      <div className={styles.toolbar}>
        <Button type="button" disabled={disabled || !saved || !allowed} onClick={onOpen}>
          <ImagePlus size={16} />
          {m('generate')}
        </Button>
        <Button type="button" variant="secondary" disabled={disabled || !saved} onClick={onOpen}>
          {m('manage')}
        </Button>
      </div>
      <small>{m('geometry')}</small>
    </section>
  );
}
export function LocationImageDialog({
  adventureId,
  locationId,
  settings,
  beforePrepare,
  playableDirty,
  onSaved,
  onClose,
}: {
  adventureId: string;
  locationId: string;
  settings: Configuration;
  beforePrepare: () => Promise<unknown>;
  playableDirty: boolean;
  onSaved: (mapAttached: boolean) => void;
  onClose: () => void;
}) {
  const m = useLocationImageText();
  const [prepared, setPrepared] = useState<Preparation | null>(null),
    [selected, setSelected] = useState<ArtRevision | null>(null),
    [bound, setBound] = useState<ArtRevision | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [mapId, setMapId] = useState(''),
    [libraryOpen, setLibraryOpen] = useState(false),
    [refreshVersion, setRefreshVersion] = useState(0),
    [libraryVersion, setLibraryVersion] = useState(0);
  const epoch = useRef(0),
    locked = useRef(false),
    pending = useRef<{ key: string; id: string } | null>(null),
    flush = useRef(beforePrepare);
  // Unsaved geometry is never part of this operation. Match the visibly selected
  // illustration-only mode even when an older saved binding supplied mapId.
  const attachmentMapId = playableDirty ? '' : mapId;
  flush.current = beforePrepare;
  async function prepare() {
    return api<Preparation>('/image-generation/studio-locations/prepare', {
      method: 'POST',
      body: JSON.stringify({ adventureId, locationId }),
    });
  }
  useEffect(() => {
    const stamp = ++epoch.current;
    setLoading(true);
    setError('');
    setNotice('');
    setPrepared(null);
    setSelected(null);
    setBound(null);
    setReviewed(false);
    pending.current = null;
    void (async () => {
      await flush.current();
      const result = await api<Preparation>('/image-generation/studio-locations/prepare', {
        method: 'POST',
        body: JSON.stringify({ adventureId, locationId }),
      });
      if (stamp !== epoch.current) return;
      setPrepared(result);
      setMapId(
        result.binding?.mapId &&
          result.playable.maps.some((map) => map.id === result.binding?.mapId)
          ? result.binding.mapId
          : '',
      );
      if (result.binding) {
        try {
          const revision = await api<ArtRevision>(
            `/asset-library/revisions/${result.binding.revisionId}`,
          );
          if (stamp === epoch.current) setBound(revision);
        } catch {
          if (stamp === epoch.current) setError(m('missing'));
        }
      }
    })()
      .catch((e) => {
        if (stamp === epoch.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (stamp === epoch.current) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, [adventureId, locationId, refreshVersion]);
  async function choose(revision: ArtRevision) {
    setSelected(revision);
    setReviewed(false);
    setError('');
    setNotice('');
  }
  async function admitted(revisionId?: string) {
    setLibraryVersion((v) => v + 1);
    if (!revisionId || prepared?.binding?.revisionId === revisionId) return;
    const stamp = epoch.current;
    try {
      const revision = await api<ArtRevision>(`/asset-library/revisions/${revisionId}`);
      if (stamp === epoch.current) await choose(revision);
    } catch {
      if (stamp === epoch.current) setError(m('missing'));
    }
  }
  async function bind() {
    if (!prepared || !selected?.canReuse || !reviewed || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const stamp = epoch.current;
    try {
      await flush.current();
      const fresh = await prepare();
      if (stamp !== epoch.current) return;
      if (
        fresh.sourceHash !== prepared.sourceHash ||
        (attachmentMapId &&
          (fresh.playable.revision !== prepared.playable.revision ||
            fresh.playable.artRevision !== prepared.playable.artRevision))
      ) {
        setPrepared(fresh);
        setReviewed(false);
        setError(m('stale'));
        return;
      }
      const body = {
        adventureId,
        locationId,
        revisionId: selected.id,
        expectedSourceHash: prepared.sourceHash,
        ...(attachmentMapId
          ? {
              mapId: attachmentMapId,
              expectedPlayableRevision: prepared.playable.revision,
              expectedArtRevision: prepared.playable.artRevision,
            }
          : {}),
      };
      const key = JSON.stringify(body);
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
      await api('/image-generation/studio-locations/bind', {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: pending.current.id }),
      });
      pending.current = null;
      if (stamp === epoch.current) {
        setBound(selected);
        setReviewed(false);
        setNotice(m('saved'));
        setPrepared(await prepare());
        onSaved(!!attachmentMapId);
      }
    } catch (e) {
      if (stamp === epoch.current) {
        setError(e instanceof ApiError && e.code === 'STALE_STATE' ? m('stale') : errorMessage(e));
        setReviewed(false);
      }
    } finally {
      locked.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  const realAllowed =
    !!settings.config?.externalEnabled &&
    (verified(settings.config) || estimateAllowed(settings)) &&
    liveSessionActive(settings.live.status) &&
    !!settings.live.status?.imagesEnabled;
  return (
    <Modal title={m('title')} onClose={onClose}>
      <div className={styles.workshop} data-testid="location-image-dialog">
        <p>{m('intro')}</p>
        <p>{m('geometry')}</p>
        <LocationImageStatus settings={settings} saved />
        <LiveTestPanel onStatusChange={settings.live.setStatus} />
        <ErrorBox message={error} />
        {notice && <p role="status">{notice}</p>}
        {loading && <p>{m('loading')}</p>}
        {prepared && (
          <>
            <h3>{prepared.location.name}</h3>
            <Field label={m('prompt')}>
              <Textarea readOnly value={prepared.request.prompt} />
            </Field>
            {bound && (
              <div className={styles.generationItem}>
                <h4>{m('current')}</h4>
                {artPreviewUrl(bound.url) && (
                  <img
                    className={styles.generationPreview}
                    src={artPreviewUrl(bound.url)}
                    alt={bound.metadata.title}
                  />
                )}
                {prepared.binding?.stale && <p>{m('stale')}</p>}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || !bound.canReuse}
                  onClick={() => void choose(bound)}
                >
                  {m('reuseCurrent')}
                </Button>
              </div>
            )}
            <ImageGeneration
              key={prepared.sourceHash}
              adventureId={adventureId}
              preparedRequest={prepared.request}
              externalOnly
              authorization={settings.live.status}
              externalDispatchAllowed={realAllowed}
              liveTestSessionId={settings.live.status?.sessionId ?? undefined}
              spec={{
                kind: 'background',
                style: 'drawn2D',
                camera: 'top-down',
                tags: prepared.request.tags,
                minWidth: 1,
                minHeight: 1,
              }}
              onSelected={(revision) => void choose(revision)}
              onAdmitted={(id) => void admitted(id)}
            />
            <Button type="button" variant="secondary" onClick={() => setLibraryOpen(!libraryOpen)}>
              {m('library')}
            </Button>
            {libraryOpen && (
              <AssetLibrary
                key={libraryVersion}
                requiredKind="background"
                requiredCamera="top-down"
                onSelected={(revision) => void choose(revision)}
              />
            )}
            {selected && (
              <section className={styles.generationItem} data-testid="location-image-selection">
                <h4>{m('candidate')}</h4>
                {artPreviewUrl(selected.url) && (
                  <img
                    className={styles.generationPreview}
                    src={artPreviewUrl(selected.url)}
                    alt={selected.metadata.title}
                  />
                )}
                <strong>{selected.metadata.title}</strong>
                <Field label={m('attach')}>
                  <Select
                    aria-label={m('attach')}
                    value={attachmentMapId}
                    disabled={busy || playableDirty}
                    onChange={(e) => {
                      setMapId(e.target.value);
                      setReviewed(false);
                    }}
                  >
                    <option value="">{m('illustration')}</option>
                    {prepared.playable.maps.map((map) => (
                      <option key={map.id} value={map.id}>
                        {m('map')}: {map.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {!prepared.playable.maps.length && <p>{m('noMap')}</p>}
                {playableDirty && <p>{m('dirtyMap')}</p>}
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy || !selected.canReuse}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  {m('review')}
                </label>
                <Button
                  type="button"
                  busy={busy}
                  disabled={!reviewed || !selected.canReuse}
                  onClick={() => void bind()}
                >
                  {m('bind')}
                </Button>
              </section>
            )}
          </>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={busy || loading}
          onClick={() => setRefreshVersion((v) => v + 1)}
        >
          {m('refresh')}
        </Button>
      </div>
    </Modal>
  );
}
