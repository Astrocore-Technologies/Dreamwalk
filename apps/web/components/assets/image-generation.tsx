'use client';
import type { ImageKnownCostSettlement } from './image-cost-policy';
import { imageFramingEvidenceMatches, type ImageFraming } from '@dreamwalk/contracts';
import { ImageQuotePrice } from './image-quote-price';
import { ImageConfirmation } from './image-confirmation';
import { GenerationProgress } from '../visual-authoring/generation-progress';
import { ImageFramingNotice } from '../visual-authoring/image-framing-notice';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, useResource, useClient } from '@/lib/client';
import { Button, ErrorBox, Field, Select, Textarea } from '@/components/ui';
import { LiveTestPanel, useLiveTestStatus } from '../live-test/live-test-panel';
import {
  generationAuthorizationId,
  generationRemaining,
  imageSessionActive,
  imageQuoteAuthorizationAvailable,
  type LiveTestStatus,
} from '../live-test/types';
import {
  ownerImageQuoteMatches,
  type ImageConfiguration,
} from '../visual-authoring/generation-types';
import { useSparkCosts, SparkReceiptCost } from '../visual-authoring/sparks-cost';
import type {
  RequestEstimateSnapshot,
  RequestPricingProfileSnapshot,
} from '../live-test/request-reserve-types';
import type { ArtRevision, ArtSpec } from './types';
import { artPreviewUrl } from './types';
import { useAssetText } from './messages';
import { useImageText } from './image-messages';
import styles from './assets.module.css';
export type PreparedStudioLocationRequest = {
  framingVersion?: 1;
  imageFraming?: ImageFraming;
  adventureId: string;
  studioLocationContext: { locationId: string; expectedEditRevision: number; sourceHash: string };
  prompt: string;
  title: string;
  kind: 'background';
  camera: 'top-down';
  tags: string[];
  background: 'opaque';
  referenceRevisionIds: string[];
  privateReferenceAssetIds: string[];
  mode: 'external';
};
type Job = {
  sparkStatus?: string;
  sparkReservedSubunits?: string;
  sparkCapturedSubunits?: string | null;

  id: string;
  studioLocationId?: string;
  studioSourceHash?: string;
  status:
    | 'queued'
    | 'dispatched'
    | 'unknown'
    | 'generated'
    | 'admitted'
    | 'rejected'
    | 'cancelled'
    | 'expired';
  mode: 'mock' | 'external';
  revisionId?: string;
  errorCode?: string;
  diagnostic?: { httpStatus: number; requestId?: string; billing: 'unknown' };
  heldMicros: number;
  actualMicros?: number;
  createdAt: string;
  canCancel: boolean;
};
type Quote = {
  automaticKnownCostSettlement?: ImageKnownCostSettlement;
  framingVersion?: 1;
  imageFraming?: ImageFraming | null;
  sparks?: { quoteId: string; reserveSubunits: string; rateVersion: string; walletCharging: true };
  estimateSnapshot?: RequestEstimateSnapshot;
  pricingProfileSnapshot?: RequestPricingProfileSnapshot;
  estimateSnapshotId?: string;
  estimateSnapshotHash?: string;
  pricingProfileId?: string;
  pricingProfileHash?: string;
  basePricingProfileId?: string;
  basePricingProfileHash?: string;
  policyRevision?: number;
  policyHash?: string;
  generationMode?: 'owner' | 'manual' | 'release';
  estimateRiskConsentRequired?: boolean;
  providerEnforcesQuotedCap?: boolean;
  id: string;
  mode: 'mock' | 'external';
  upperMicros: number | null;
  costBasis?: 'fixture' | 'verified_bound' | 'approved_estimate' | 'legacy_unknown';
  reserveMicros?: number;
  verifiedUpperMicros?: number | null;
  estimatedTotalMicros?: number;
  expiresAt: string;
  rightsAttestationRequired: true;
};
type QuoteResponse = { decision: 'reuse' | 'quote'; matches: ArtRevision[]; quote?: Quote };
function GeneratedRevision({
  id,
  onSelect,
}: {
  id: string;
  onSelect?: (value: ArtRevision) => void;
}) {
  const a = useAssetText(),
    g = useImageText(),
    resource = useResource<ArtRevision>(`/asset-library/revisions/${id}`),
    revision = resource.data;
  return (
    <div>
      <p>{g('result')}</p>
      <ErrorBox message={resource.error} />
      {revision && (
        <>
          <img
            loading="lazy"
            decoding="async"
            width={revision.width}
            height={revision.height}
            src={artPreviewUrl(revision.url)}
            alt={revision.metadata.title}
          />
          <p>{revision.metadata.title}</p>
          {onSelect && (
            <Button type="button" disabled={!revision.canReuse} onClick={() => onSelect(revision)}>
              {a('use')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
export function ImageGeneration({
  adventureId,
  heroPortrait,
  storyCover,
  liveTestSessionId,
  authorization,
  preparedRequest,
  externalOnly = false,
  externalDispatchAllowed = true,
  spec,
  onSelected,
  onAdmitted,
}: {
  adventureId?: string;
  heroPortrait?: { draftId: string; prompt: string; title: string };
  storyCover?: { draftId: string; prompt: string; title: string };
  liveTestSessionId?: string;
  authorization?: LiveTestStatus | null;
  preparedRequest?: PreparedStudioLocationRequest;
  externalOnly?: boolean;
  externalDispatchAllowed?: boolean;
  spec: ArtSpec;
  onSelected?: (revision: ArtRevision) => void;
  onAdmitted: (revisionId?: string) => void;
}) {
  const a = useAssetText(),
    g = useImageText(),
    { s, amount } = useSparkCosts(),
    { user } = useClient();
  const config = useResource<ImageConfiguration & { mockAvailable: boolean }>(
    '/image-generation/config',
  );
  // Read authorization independently of the admin-only settings panel.
  const { status: managedAuthorization, setStatus: setManagedAuthorization } = useLiveTestStatus();
  const grant = authorization ?? managedAuthorization,
    authorizationId = generationAuthorizationId(grant) ?? liveTestSessionId,
    ownerMode = grant?.mode === 'owner' || grant?.mode === 'release';
  const modeChosen = useRef(false);
  const [mode, setMode] = useState<'mock' | 'external'>(externalOnly ? 'external' : 'mock');
  const [prompt, setPrompt] = useState(heroPortrait?.prompt ?? storyCover?.prompt ?? ''),
    [title, setTitle] = useState(heroPortrait?.title ?? storyCover?.title ?? ''),
    [background, setBackground] = useState<'opaque' | 'transparent'>(
      spec.kind === 'sprite' || spec.kind === 'object' ? 'transparent' : 'opaque',
    ),
    [license] = useState('Generated artwork; reuse requires owner permission'),
    [attribution] = useState(''),
    [allowReuse] = useState(false),
    [references, setReferences] = useState<string[]>([]),
    [dispatchUncertain, setDispatchUncertain] = useState(false),
    [quote, setQuote] = useState<Quote | null>(null),
    [matches, setMatches] = useState<ArtRevision[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [jobsError, setJobsError] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]),
    [now, setNow] = useState(Date.now());
  const actionLock = useRef(false);
  const epoch = useRef(0),
    seen = useRef(new Set<string>()),
    quotedFingerprint = useRef<string | null>(null),
    operation = useRef<{ quoteId: string; id: string } | null>(null),
    cancelOperations = useRef(new Map<string, string>()),
    callbacks = useRef({ onAdmitted });
  callbacks.current = { onAdmitted };
  const referenceLimit =
    mode === 'external'
      ? Math.min(2, Math.max(0, config.data?.requestProfile?.maxReferenceImages ?? 2))
      : 2;
  const supported =
    ['background', 'sprite', 'portrait', 'object'].includes(spec.kind) &&
    ['top-down', 'portrait', 'unrestricted'].includes(spec.camera);
  const request = {
    adventureId,
    ...(heroPortrait ? { heroPortraitContext: { draftId: heroPortrait.draftId } } : {}),
    ...(storyCover ? { storyCoverContext: { draftId: storyCover.draftId } } : {}),
    prompt: prompt.trim(),
    title: title.trim() || prompt.trim().slice(0, 120),
    kind: spec.kind,
    camera: spec.camera,
    tags: spec.tags,
    background,
    referenceRevisionIds: references,
    ...(preparedRequest ?? {}),
    rights: {
      basis: 'generated' as const,
      licenseLabel: license.trim(),
      attribution: attribution.trim(),
      allowAuthorReuse: heroPortrait || storyCover ? false : allowReuse,
      attested: true as const,
    },
    mode: externalOnly ? ('external' as const) : mode,
    ...(mode === 'external' && grant?.mode !== 'release' && authorizationId
      ? { liveTestSessionId: authorizationId }
      : {}),
  };
  const outstandingExternalJob = jobs.some(
    (job) =>
      job.mode === 'external' &&
      ['queued', 'dispatched', 'unknown', 'generated'].includes(job.status) &&
      !(
        grant?.imageOnlyAdmission &&
        job.status === 'unknown' &&
        job.diagnostic?.httpStatus === 403
      ),
  );
  const dispatchAllowed =
    !outstandingExternalJob &&
    externalDispatchAllowed &&
    (!ownerMode || (!!grant?.imagesEnabled && imageSessionActive(grant, now)));
  const fingerprint = JSON.stringify({
    owner: user?.id,
    request,
    externalDispatchAllowed: dispatchAllowed,
    authorizationMode: grant?.mode,
    policyRevision: grant?.policyRevision,
    policyHash: grant?.policyHash,
    costConfiguration: config.data,
  });
  const estimatedQuote = ownerMode && ownerImageQuoteMatches(quote, config.data, grant);
  const quoteBudgetAvailable =
    !ownerMode ||
    (quote !== null &&
      (estimatedQuote ? (quote.reserveMicros ?? Infinity) : (quote.upperMicros ?? Infinity)) <=
        generationRemaining(grant, 'image'));
  useEffect(() => {
    if (ownerMode && !modeChosen.current) setMode('external');
  }, [ownerMode]);
  useEffect(() => {
    if (externalOnly) setMode('external');
  }, [externalOnly]);
  useEffect(() => {
    if (!preparedRequest) return;
    setPrompt(preparedRequest.prompt);
    setTitle(preparedRequest.title);
    setBackground(preparedRequest.background);
    setReferences(preparedRequest.referenceRevisionIds);
  }, [preparedRequest]);
  useEffect(() => {
    setBackground(spec.kind === 'sprite' || spec.kind === 'object' ? 'transparent' : 'opaque');
  }, [spec.kind]);
  useEffect(() => {
    epoch.current++;
    setQuote(null);
    quotedFingerprint.current = null;
    setMatches([]);
    operation.current = null;
    setBusy(false);
  }, [fingerprint]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  useEffect(() => {
    let active = true,
      pending = false;
    seen.current.clear();
    setJobs([]);
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ jobs: Job[] }>(
          storyCover
            ? '/image-generation/story-covers'
            : heroPortrait
              ? '/image-generation/hero-portraits'
              : `/image-generation/jobs?adventureId=${adventureId}`,
        );
        if (active) {
          const scopedJobs = preparedRequest
            ? result.jobs.filter(
                (job) =>
                  job.studioLocationId === preparedRequest.studioLocationContext.locationId &&
                  job.studioSourceHash === preparedRequest.studioLocationContext.sourceHash,
              )
            : result.jobs;
          setJobs(scopedJobs);
          setJobsError('');
          let changed = false,
            admittedId: string | undefined;
          for (const job of scopedJobs)
            if (job.status === 'admitted' && !seen.current.has(job.id)) {
              seen.current.add(job.id);
              changed = true;
              admittedId = job.revisionId;
            }
          if (changed) callbacks.current.onAdmitted(admittedId);
        }
      } catch (err) {
        if (active) setJobsError(errorMessage(err));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    user?.id,
    adventureId,
    heroPortrait?.draftId,
    storyCover?.draftId,
    preparedRequest?.studioLocationContext.locationId,
    preparedRequest?.studioLocationContext.sourceHash,
  ]);
  const valid =
    supported &&
    !!prompt.trim() &&
    !!license.trim() &&
    references.length <= referenceLimit &&
    (mode === 'mock'
      ? config.data?.mockAvailable
      : config.data?.externalEnabled &&
        imageQuoteAuthorizationAvailable(grant, authorizationId, now));
  async function prepare(declineReuse = true) {
    if ((!dispatchAllowed || dispatchUncertain) && request.mode === 'external') return;
    if (!valid || busy || actionLock.current) return;
    actionLock.current = true;
    const generation = ++epoch.current;
    setBusy(true);
    setError('');
    setQuote(null);
    operation.current = null;
    try {
      const result = await api<QuoteResponse>('/image-generation/quotes', {
        method: 'POST',
        body: JSON.stringify({
          ...request,
          ...(request.mode === 'external' ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
          ...(declineReuse ? { declineReuse: true } : {}),
        }),
      });
      if (generation === epoch.current) {
        setMatches(result.matches);
        if (
          result.decision === 'quote' &&
          result.quote?.mode === mode &&
          imageFramingEvidenceMatches(preparedRequest ?? {}, result.quote) &&
          ((result.quote.upperMicros !== null &&
            Number.isSafeInteger(result.quote.upperMicros) &&
            result.quote.upperMicros >= 0 &&
            (mode === 'mock'
              ? result.quote.upperMicros === 0
              : result.quote.upperMicros === config.data?.verifiedUpperMicros)) ||
            (ownerMode && ownerImageQuoteMatches(result.quote, config.data, grant)))
        ) {
          quotedFingerprint.current = fingerprint;
          setQuote(result.quote);
        }
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      actionLock.current = false;
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function run(confirmedQuoteId: string) {
    if ((!dispatchAllowed || dispatchUncertain) && request.mode === 'external') return;
    if (
      actionLock.current ||
      confirmedQuoteId !== quote?.id ||
      quotedFingerprint.current !== fingerprint ||
      quote?.mode !== mode ||
      (quote.upperMicros === null && !estimatedQuote)
    )
      return;
    if (
      !valid ||
      !quoteBudgetAvailable ||
      !quote ||
      !imageFramingEvidenceMatches(preparedRequest ?? {}, quote) ||
      busy ||
      !Number.isFinite(Date.parse(quote.expiresAt)) ||
      Date.parse(quote.expiresAt) <= Date.now()
    )
      return;
    actionLock.current = true;
    const generation = epoch.current;
    if (operation.current?.quoteId !== quote.id)
      operation.current = { quoteId: quote.id, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const job = await api<Job>('/image-generation/jobs', {
        method: 'POST',
        body: JSON.stringify({
          quoteId: quote.id,
          operationId: operation.current.id,
          consent: true,
          ...(quote.automaticKnownCostSettlement
            ? { automaticKnownCostPolicyHash: quote.automaticKnownCostSettlement.fingerprint }
            : {}),
          ...(estimatedQuote ? { estimateRiskConsent: true } : {}),
        }),
      });
      if (generation === epoch.current) {
        setJobs((current) => [job, ...current.filter((value) => value.id !== job.id)]);
        setQuote(null);
        operation.current = null;
      }
    } catch (err) {
      if (generation === epoch.current) {
        setError(errorMessage(err));
        if (!(err instanceof ApiError) || !err.status) setDispatchUncertain(true);
      }
    } finally {
      actionLock.current = false;
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function cancel(job: Job) {
    if (busy || !job.canCancel) return;
    const generation = epoch.current;
    if (!cancelOperations.current.has(job.id))
      cancelOperations.current.set(job.id, crypto.randomUUID());
    setBusy(true);
    setError('');
    try {
      const result = await api<Job>(`/image-generation/jobs/${job.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ operationId: cancelOperations.current.get(job.id) }),
      });
      if (generation === epoch.current)
        setJobs((current) => current.map((value) => (value.id === job.id ? result : value)));
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section className={styles.root} aria-label={g('title')}>
      {preparedRequest && (
        <ImageFramingNotice
          {...preparedRequest}
          approvedSize={config.data?.requestProfile?.size}
          approvedPolicy={config.data?.requestProfile?.framingPolicy}
        />
      )}
      <h3>{g('title')}</h3>
      {!externalOnly && user?.role === 'admin' && (
        <LiveTestPanel onStatusChange={setManagedAuthorization} />
      )}
      {!externalOnly && (
        <Field label={g('mode')}>
          <Select
            aria-label={g('mode')}
            value={mode}
            disabled={busy}
            onChange={(event) => {
              modeChosen.current = true;
              setMode(event.target.value as 'mock' | 'external');
            }}
          >
            <option value="mock">{g('mockMode')}</option>
            <option value="external" disabled={!config.data?.externalEnabled || !authorizationId}>
              {g('externalMode')}
            </option>
          </Select>
        </Field>
      )}
      {!externalOnly && mode === 'mock' && <p>{g('mock')}</p>}
      {!config.data?.externalEnabled && (
        <div className={styles.notice}>
          <p>
            {g(
              ownerMode ||
                config.data?.generationMode === 'owner' ||
                config.data?.generationMode === 'release'
                ? 'ownerUnavailable'
                : 'unavailable',
            )}
          </p>
          <details>
            <summary>{g('diagnostics')}</summary>
            {config.data?.externalBlockReasons?.map((reason) => (
              <p key={reason}>
                <code>{reason}</code>
              </p>
            ))}
          </details>
        </div>
      )}
      {user?.role === 'admin' && mode === 'external' && config.data?.requestProfile && (
        <p>
          {config.data.requestProfile.model} · {config.data.requestProfile.size} ·{' '}
          {config.data.requestProfile.quality} · {config.data.requestProfile.outputs}
        </p>
      )}
      <ErrorBox message={error || config.error || jobsError} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void prepare();
        }}
      >
        <fieldset
          disabled={
            busy ||
            !supported ||
            (mode === 'mock' ? !config.data?.mockAvailable : !config.data?.externalEnabled)
          }
        >
          {!preparedRequest && (
            <Field label={g('prompt')}>
              <Textarea
                aria-label={g('prompt')}
                value={prompt}
                readOnly={!!preparedRequest}
                maxLength={2000}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
          )}
          <Button type="submit" disabled={!valid || !dispatchAllowed || dispatchUncertain}>
            {g('quote')}
          </Button>
        </fieldset>
      </form>
      {matches.length > 0 && (
        <div>
          <p>{g('matches')}</p>
          {matches.map((revision) => (
            <div key={revision.id}>
              <p>{revision.metadata.title}</p>
              {onSelected && (
                <Button
                  type="button"
                  disabled={busy || ((!!heroPortrait || !!storyCover) && !revision.owned)}
                  onClick={() => onSelected(revision)}
                >
                  {a('use')}
                </Button>
              )}
            </div>
          ))}
          {!quote && (
            <Button
              type="button"
              variant="secondary"
              disabled={!valid || busy || !dispatchAllowed || dispatchUncertain}
              onClick={() => void prepare(true)}
            >
              {g(ownerMode ? 'declineExternal' : 'decline')}
            </Button>
          )}
        </div>
      )}
      {dispatchUncertain && <p role="status">{g('unknown')}</p>}
      {quote && (
        <div role="status">
          {quote.mode === 'mock' ? <p>{g('cost')}</p> : <ImageQuotePrice quote={quote} />}
          {quote.upperMicros === null && !estimatedQuote ? (
            <p>{g('estimatePending')}</p>
          ) : !Number.isFinite(Date.parse(quote.expiresAt)) ||
            Date.parse(quote.expiresAt) <= now ? (
            <p>{g('expires')}</p>
          ) : (
            <ImageConfirmation
              walletCharging={!!quote.sparks?.walletCharging}
              estimated={quote.upperMicros === null}
              external={quote.mode === 'external'}
              busy={busy}
              disabled={!quoteBudgetAvailable || !dispatchAllowed || dispatchUncertain}
              onConfirm={() => void run(quote.id)}
              onCancel={() => {
                epoch.current++;
                setQuote(null);
                quotedFingerprint.current = null;
                operation.current = null;
              }}
            />
          )}
        </div>
      )}
      <h4>{g('jobs')}</h4>
      <p>{g('cancelNote')}</p>
      {jobs.map((job) => (
        <article
          className={styles.card}
          key={job.id}
          data-image-job-id={job.id}
          data-image-job-status={job.status}
        >
          {['queued', 'dispatched', 'generated'].includes(job.status) ? (
            <GenerationProgress status={job.status} />
          ) : (
            <p>{g(job.status)}</p>
          )}
          {job.sparkStatus && (
            <p>
              <SparkReceiptCost receipt={{ ...job, generationCost: null }} />
            </p>
          )}
          {job.mode === 'mock' && <p>{g('mock')}</p>}
          {job.errorCode && <code>{job.errorCode}</code>}
          {job.diagnostic && (
            <p>
              {g('providerError')} · {g('httpStatus')} {job.diagnostic.httpStatus}
              {job.diagnostic.requestId ? ` · ${job.diagnostic.requestId}` : ''}
            </p>
          )}
          {job.mode === 'external' && !job.sparkStatus && (
            <p>
              {s('reserve')}: {amount(job.heldMicros)}
              {job.actualMicros !== undefined && (
                <>
                  {' '}
                  · {s('actual')}: {amount(job.actualMicros)}
                </>
              )}
            </p>
          )}
          {job.canCancel && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void cancel(job)}
            >
              {g('cancel')}
            </Button>
          )}
          {job.status === 'admitted' && job.revisionId && (
            <GeneratedRevision id={job.revisionId} onSelect={onSelected} />
          )}
        </article>
      ))}
    </section>
  );
}
