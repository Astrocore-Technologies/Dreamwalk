'use client';
import { GenerationProgress } from './generation-progress';
import { imageFramingEvidenceMatches } from '@dreamwalk/contracts';
import { ImageConfirmation } from '../assets/image-confirmation';
import { ImageFramingNotice } from './image-framing-notice';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useClient } from '@/lib/client';
import { useSparkCosts, SparkQuotePrice, SparkQuoteNotice, SparkReceiptCost } from './sparks-cost';
import { Button, ErrorBox, Select, Field } from '../ui';
import { useAssetText } from '../assets/messages';
import { useImageText } from '../assets/image-messages';
import type { ArtRevision } from '../assets/types';
import { artPreviewUrl } from '../assets/types';
import type { PreparedStudioLocationRequest } from '../assets/image-generation';
import {
  imageSessionActive,
  generationAuthorizationId,
  generationRemaining,
} from '../live-test/types';
import { ownerImageQuoteMatches, type GenerationQuote } from './generation-types';
import { useLocationImageText } from './location-image-messages';
import { useLocationInlineText } from './location-inline-messages';
import { ImageRejectionRecovery } from './image-rejection-recovery';
import type { useLocationImageConfiguration } from './location-image';
import styles from './workshop.module.css';
type Preparation = {
  request: PreparedStudioLocationRequest;
  sourceHash: string;
  binding: null | { revisionId: string; mapId?: string };
  playable: { revision: number; artRevision: number; maps: { id: string; label: string }[] };
};
type Job = {
  sparkStatus?: string;
  sparkReservedSubunits?: string;
  sparkCapturedSubunits?: string | null;

  id: string;
  status: string;
  studioLocationId?: string;
  revisionId?: string;
  heldMicros: number;
  diagnostic?: { httpStatus: number; providerCode?: string; requestId?: string };
  errorCode?: string;
};
type Quoted = {
  preparation: Preparation;
  quote: GenerationQuote;
  key: string;
  matches: ArtRevision[];
};
type Props = {
  adventureId: string;
  locationId: string;
  sourceKey: string;
  saved: boolean;
  disabled: boolean;
  settings: ReturnType<typeof useLocationImageConfiguration>;
  beforePrepare: () => Promise<unknown>;
  playableDirty: boolean;
  onSaved: (attached: boolean) => void;
  onOpen: () => void;
};
export function LocationImageInline(p: Props) {
  const m = useLocationInlineText(),
    g = useImageText(),
    a = useAssetText(),
    l = useLocationImageText(),
    { s, amount } = useSparkCosts(),
    { user } = useClient();
  const [share, setShare] = useState(false),
    [quote, setQuote] = useState<Quoted | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]),
    [selected, setSelected] = useState<ArtRevision | null>(null),
    [savedImage, setSavedImage] = useState<ArtRevision | null>(null),
    [mapId, setMapId] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [now, setNow] = useState(Date.now()),
    [refresh, setRefresh] = useState(0),
    [binding, setBinding] = useState<Preparation | null>(null);
  const epoch = useRef(0),
    lock = useRef(false),
    cancelledQuotes = useRef(new Set<string>()),
    operation = useRef<{ quoteId: string; id: string } | null>(null),
    bindOperation = useRef<{ key: string; id: string } | null>(null),
    seen = useRef(new Set<string>()),
    lastStatuses = useRef(new Map<string, string>()),
    callbacks = useRef(p);
  callbacks.current = p;
  const status = p.settings.live.status,
    config = p.settings.config;
  const stopped = status?.state === 'stopped' && status.imageOnlyAdmission !== true;
  const allowed =
    !!config?.externalEnabled && !!status?.imagesEnabled && imageSessionActive(status);
  const key = JSON.stringify({
    source: p.sourceKey,
    share,
    authorization: status?.mode === 'release' ? user?.id : generationAuthorizationId(status),
    policy: status?.policyHash,
    revision: status?.policyRevision,
    config,
  });
  const currentKey = useRef(key);
  currentKey.current = key;
  const quoteCurrent = quote?.key === key && Date.parse(quote.quote.expiresAt) > now;
  const estimate = quote?.quote.upperMicros === null;
  const matched =
    !!quote &&
    imageFramingEvidenceMatches(quote.preparation.request, quote.quote) &&
    (estimate
      ? ownerImageQuoteMatches(quote.quote, config, status)
      : quote.quote.upperMicros === config?.verifiedUpperMicros);
  const reserve = quote?.quote.reserveMicros ?? quote?.quote.upperMicros ?? Infinity;
  useEffect(() => {
    setQuote(null);
    epoch.current++;
  }, [p.sourceKey, user?.id]);
  useEffect(() => {
    let active = true;
    if (p.saved)
      void api<Preparation>('/image-generation/studio-locations/prepare', {
        method: 'POST',
        body: JSON.stringify({ adventureId: p.adventureId, locationId: p.locationId }),
      })
        .then(async (prepared) => {
          if (!active) return;
          setBinding(prepared);
          if (prepared.binding) {
            const image = await api<ArtRevision>(
              `/asset-library/revisions/${prepared.binding.revisionId}`,
            );
            if (active) setSavedImage(image);
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    return () => {
      active = false;
    };
  }, [p.adventureId, p.locationId, p.saved, user?.id]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true,
      pending = false;
    async function poll() {
      if (pending || !p.saved) return;
      pending = true;
      try {
        const result = await api<{ jobs: Job[] }>(
          `/image-generation/jobs?adventureId=${p.adventureId}`,
        );
        if (!active) return;
        const scoped = result.jobs.filter((j) => j.studioLocationId === p.locationId);
        setJobs(scoped);
        let refreshAuthorization = false;
        for (const job of scoped) {
          const prior = lastStatuses.current.get(job.id);
          if (
            prior &&
            prior !== job.status &&
            ['unknown', 'admitted', 'rejected', 'cancelled', 'expired'].includes(job.status)
          )
            refreshAuthorization = true;
          lastStatuses.current.set(job.id, job.status);
        }
        if (refreshAuthorization) void callbacks.current.settings.live.refresh();
        const job = scoped.find(
          (j) => j.status === 'admitted' && j.revisionId && !seen.current.has(j.id),
        );
        if (job) {
          for (const value of scoped) if (value.status === 'admitted') seen.current.add(value.id);
          const revision = await api<ArtRevision>(`/asset-library/revisions/${job.revisionId}`);
          const prepared = await api<Preparation>('/image-generation/studio-locations/prepare', {
            method: 'POST',
            body: JSON.stringify({ adventureId: p.adventureId, locationId: p.locationId }),
          });
          if (active) {
            setBinding(prepared);
            setMapId(
              prepared.binding?.mapId ??
                (prepared.playable.maps.length === 1 ? prepared.playable.maps[0].id : ''),
            );
            setSelected(revision);
          }
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [p.adventureId, p.locationId, p.saved, refresh, user?.id]);
  useEffect(() => {
    epoch.current++;
    setQuote(null);
    setError('');
  }, [key, allowed, p.saved, p.disabled]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function prepareQuote() {
    if (lock.current || !allowed || !p.saved || p.disabled || uncertain) return;
    lock.current = true;
    const stamp = ++epoch.current;
    setQuote(null);
    setError('');
    setBusy(true);
    try {
      await callbacks.current.beforePrepare();
      const preparation = await api<Preparation>('/image-generation/studio-locations/prepare', {
        method: 'POST',
        body: JSON.stringify({ adventureId: p.adventureId, locationId: p.locationId }),
      });
      if (stamp !== epoch.current) return;
      const response = await api<{
        decision: string;
        quote?: GenerationQuote;
        matches: ArtRevision[];
      }>('/image-generation/quotes', {
        method: 'POST',
        body: JSON.stringify({
          ...preparation.request,
          generationAuthorizationId:
            status?.mode === 'release'
              ? undefined
              : (generationAuthorizationId(status) ?? undefined),
          declineReuse: true,
          rights: {
            basis: 'generated',
            licenseLabel: "Generated asset; reuse requires owner's permission",
            attribution: '',
            allowAuthorReuse: share,
            attested: true,
          },
        }),
      });
      if (
        stamp === epoch.current &&
        response.quote &&
        imageFramingEvidenceMatches(preparation.request, response.quote)
      ) {
        setQuote({ preparation, quote: response.quote, key, matches: response.matches });
        setBinding(preparation);
        setMapId(
          preparation.binding?.mapId ??
            (preparation.playable.maps.length === 1 ? preparation.playable.maps[0].id : ''),
        );
      }
    } catch (e) {
      if (stamp === epoch.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function generate(confirmedQuoteId: string) {
    if (
      lock.current ||
      cancelledQuotes.current.has(confirmedQuoteId) ||
      confirmedQuoteId !== quote?.quote.id ||
      quote.key !== currentKey.current ||
      Date.parse(quote.quote.expiresAt) <= Date.now() ||
      p.disabled ||
      !quoteCurrent ||
      !quote ||
      !matched ||
      !allowed ||
      uncertain ||
      reserve > generationRemaining(status, 'image')
    )
      return;
    lock.current = true;
    const stamp = epoch.current;
    setBusy(true);
    setError('');
    if (operation.current?.quoteId !== quote.quote.id)
      operation.current = { quoteId: quote.quote.id, id: crypto.randomUUID() };
    try {
      const job = await api<Job>('/image-generation/jobs', {
        method: 'POST',
        body: JSON.stringify({
          quoteId: quote.quote.id,
          operationId: operation.current.id,
          consent: true,
          ...(estimate ? { estimateRiskConsent: true } : {}),
        }),
      });
      if (stamp !== epoch.current) return;
      lastStatuses.current.set(job.id, job.status);
      setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
      setQuote(null);
    } catch (e) {
      if (stamp !== epoch.current) return;
      setError(errorMessage(e));
      setUncertain(true);
      setQuote(null);
    } finally {
      lock.current = false;
      setBusy(false);
      void p.settings.live.refresh();
    }
  }
  async function bind() {
    if (lock.current || !binding || !selected?.canReuse) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await p.beforePrepare();
      const fresh = await api<Preparation>('/image-generation/studio-locations/prepare', {
        method: 'POST',
        body: JSON.stringify({ adventureId: p.adventureId, locationId: p.locationId }),
      });
      const attached = !p.playableDirty && mapId;
      if (
        fresh.sourceHash !== binding.sourceHash ||
        (attached &&
          (fresh.playable.revision !== binding.playable.revision ||
            fresh.playable.artRevision !== binding.playable.artRevision))
      )
        throw Error(l('stale'));
      const body = {
        adventureId: p.adventureId,
        locationId: p.locationId,
        revisionId: selected.id,
        expectedSourceHash: binding.sourceHash,
        ...(attached
          ? {
              mapId,
              expectedPlayableRevision: binding.playable.revision,
              expectedArtRevision: binding.playable.artRevision,
            }
          : {}),
      };
      const bindKey = JSON.stringify(body);
      if (bindOperation.current?.key !== bindKey)
        bindOperation.current = { key: bindKey, id: crypto.randomUUID() };
      await api('/image-generation/studio-locations/bind', {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: bindOperation.current.id }),
      });
      p.onSaved(!!attached);
      setBinding({
        ...fresh,
        binding: { revisionId: selected.id, ...(attached ? { mapId } : {}) },
      });
      setSavedImage(selected);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function refreshStatus() {
    setRefresh((v) => v + 1);
    void p.settings.live.refresh();
  }
  return (
    <section
      className={styles.locationImage}
      data-location-art={p.locationId}
      aria-label={l('title')}
    >
      {user?.role === 'admin' && config?.requestProfile && (
        <small>
          {config.requestProfile.model} · {config.requestProfile.size} ·{' '}
          {config.requestProfile.quality}
        </small>
      )}
      <ErrorBox message={error || p.settings.configError || p.settings.live.error} />
      {binding && (
        <ImageFramingNotice
          {...binding.request}
          approvedSize={config?.requestProfile?.size}
          approvedPolicy={config?.requestProfile?.framingPolicy}
        />
      )}
      {!p.saved && <p>{l('saveFirst')}</p>}
      {stopped ? (
        <p role="status">{m('blocked')}</p>
      ) : (
        !allowed && (
          <p role="status">
            {m((status?.heldMicros ?? 0) > 0 ? 'outstanding' : 'authorization')}{' '}
            {status?.imageBlockCode}
          </p>
        )
      )}
      <details>
        <summary>{g('advanced')}</summary>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={share}
            disabled={busy || p.disabled}
            onChange={(e) => setShare(e.target.checked)}
          />
          {a('allowReuse')}
        </label>
      </details>
      <small>{g('quoteRights')}</small>
      <Button
        type="button"
        busy={busy}
        disabled={!allowed || !p.saved || p.disabled || uncertain}
        onClick={() => void prepareQuote()}
      >
        {g('quote')}
      </Button>
      {busy && !lock.current && <small role="status">{m('preparing')}</small>}
      {quoteCurrent && quote && (
        <p>
          {s('estimate')}: {amount(quote.quote.estimatedTotalMicros ?? quote.quote.upperMicros)} ·{' '}
          {s('reserve')}: {amount(reserve)}
        </p>
      )}
      {quoteCurrent && (
        <>
          <>
            {quote.quote.sparks && <SparkQuotePrice quote={quote.quote} />}
            <SparkQuoteNotice quote={quote.quote} />
          </>
          <ImageConfirmation
            estimated={estimate}
            busy={busy}
            disabled={
              !matched ||
              !allowed ||
              p.disabled ||
              uncertain ||
              reserve > generationRemaining(status, 'image')
            }
            onConfirm={() => void generate(quote.quote.id)}
            onCancel={() => {
              cancelledQuotes.current.add(quote.quote.id);
              epoch.current++;
              setQuote(null);
              operation.current = null;
            }}
          />
        </>
      )}
      {jobs.some((j) => ['queued', 'dispatched', 'generated'].includes(j.status)) && (
        <GenerationProgress
          status={
            jobs.find((j) => ['queued', 'dispatched', 'generated'].includes(j.status))!.status
          }
        />
      )}
      {jobs
        .filter((job) => job.sparkStatus)
        .map((job) => (
          <p key={job.id}>
            <SparkReceiptCost receipt={{ ...job, generationCost: null }} />
          </p>
        ))}
      {savedImage && (
        <div className={styles.generationItem}>
          <h4>{l('current')}</h4>
          <img
            className={styles.generationPreview}
            src={artPreviewUrl(savedImage.url)}
            alt={savedImage.metadata.title}
          />
        </div>
      )}
      {jobs.some((j) => j.status === 'unknown') && (
        <details>
          <summary>{m('history')}</summary>
          {jobs
            .filter((j) => j.status === 'unknown' || ['queued', 'dispatched'].includes(j.status))
            .map((j) => (
              <div key={j.id} data-image-job-status={j.status}>
                <p>
                  {g(j.status as 'unknown')} · {s('reserve')}: {amount(j.heldMicros)}
                </p>
                {j.diagnostic?.requestId && <code>{j.diagnostic.requestId}</code>}
                {user?.role === 'admin' &&
                  j.status === 'unknown' &&
                  j.diagnostic?.httpStatus === 403 &&
                  ['model_not_found', 'model_access_denied'].includes(
                    j.diagnostic.providerCode ?? '',
                  ) &&
                  j.diagnostic.requestId && (
                    <ImageRejectionRecovery
                      jobId={j.id}
                      requestId={j.diagnostic.requestId}
                      onRecovered={refreshStatus}
                    />
                  )}
              </div>
            ))}
        </details>
      )}
      {selected && selected.id !== savedImage?.id && (
        <div className={styles.generationItem}>
          <img
            className={styles.generationPreview}
            src={artPreviewUrl(selected.url)}
            alt={selected.metadata.title}
          />
          <Field label={l('attach')}>
            <Select
              value={p.playableDirty ? '' : mapId}
              disabled={busy || p.playableDirty}
              onChange={(e) => {
                setMapId(e.target.value);
              }}
            >
              <option value="">{l('illustration')}</option>
              {binding?.playable.maps.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.label}
                </option>
              ))}
            </Select>
          </Field>
          <p>{l('review')}</p>
          <Button
            type="button"
            disabled={!binding || !selected.canReuse}
            busy={busy}
            onClick={() => void bind()}
          >
            {l('bind')}
          </Button>
        </div>
      )}
      <div className={styles.toolbar}>
        <Button type="button" variant="secondary" onClick={refreshStatus}>
          {m('refresh')}
        </Button>
        <Button type="button" variant="ghost" disabled={!p.saved || busy} onClick={p.onOpen}>
          {m('library')}
        </Button>
      </div>
    </section>
  );
}
