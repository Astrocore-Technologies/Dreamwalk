'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Select, Textarea } from '@/components/ui';
import type { ArtRevision, ArtSpec } from './types';
import { artPreviewUrl } from './types';
import { useAssetText } from './messages';
import { useImageText } from './image-messages';
import styles from './assets.module.css';
export type PreparedStudioLocationRequest = {
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
  liveTestSessionId,
  preparedRequest,
  externalOnly = false,
  externalDispatchAllowed = true,
  spec,
  onSelected,
  onAdmitted,
}: {
  adventureId: string;
  liveTestSessionId?: string;
  preparedRequest?: PreparedStudioLocationRequest;
  externalOnly?: boolean;
  externalDispatchAllowed?: boolean;
  spec: ArtSpec;
  onSelected?: (revision: ArtRevision) => void;
  onAdmitted: (revisionId?: string) => void;
}) {
  const a = useAssetText(),
    g = useImageText();
  const config = useResource<{
    mockAvailable: boolean;
    externalEnabled: boolean;
    externalBlockReasons: string[];
    verifiedUpperMicros: number | null;
    requestProfile?: { model: string; size: string; quality: string; outputs: number };
  }>('/image-generation/config');
  const library = useResource<ArtRevision[]>('/asset-library');
  const [mode, setMode] = useState<'mock' | 'external'>(externalOnly ? 'external' : 'mock');
  const [prompt, setPrompt] = useState(''),
    [title, setTitle] = useState(''),
    [background, setBackground] = useState<'opaque' | 'transparent'>(
      spec.kind === 'sprite' || spec.kind === 'object' ? 'transparent' : 'opaque',
    ),
    [license, setLicense] = useState(''),
    [attribution, setAttribution] = useState(''),
    [allowReuse, setAllowReuse] = useState(false),
    [attested, setAttested] = useState(false),
    [references, setReferences] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    [quote, setQuote] = useState<Quote | null>(null),
    [matches, setMatches] = useState<ArtRevision[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [jobsError, setJobsError] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]),
    [now, setNow] = useState(Date.now());
  const epoch = useRef(0),
    seen = useRef(new Set<string>()),
    quotedFingerprint = useRef<string | null>(null),
    operation = useRef<{ quoteId: string; id: string } | null>(null),
    cancelOperations = useRef(new Map<string, string>()),
    callbacks = useRef({ onAdmitted });
  callbacks.current = { onAdmitted };
  const supported =
    ['background', 'sprite', 'portrait', 'object'].includes(spec.kind) &&
    ['top-down', 'portrait', 'unrestricted'].includes(spec.camera);
  const request = {
    adventureId,
    prompt: prompt.trim(),
    title: title.trim(),
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
      allowAuthorReuse: allowReuse,
      attested: true as const,
    },
    mode: externalOnly ? ('external' as const) : mode,
    ...(mode === 'external' && liveTestSessionId ? { liveTestSessionId } : {}),
  };
  const fingerprint = JSON.stringify({ request, attested, externalDispatchAllowed });
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
    setConsent(false);
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
          `/image-generation/jobs?adventureId=${adventureId}`,
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
    adventureId,
    preparedRequest?.studioLocationContext.locationId,
    preparedRequest?.studioLocationContext.sourceHash,
  ]);
  const valid =
    supported &&
    !!prompt.trim() &&
    !!title.trim() &&
    !!license.trim() &&
    attested &&
    (mode === 'mock'
      ? config.data?.mockAvailable
      : config.data?.externalEnabled && !!liveTestSessionId);
  async function prepare(declineReuse = false) {
    if (!externalDispatchAllowed && request.mode === 'external') return;
    if (!valid || busy) return;
    const generation = ++epoch.current;
    setBusy(true);
    setError('');
    setQuote(null);
    setConsent(false);
    operation.current = null;
    try {
      const result = await api<QuoteResponse>('/image-generation/quotes', {
        method: 'POST',
        body: JSON.stringify({ ...request, ...(declineReuse ? { declineReuse: true } : {}) }),
      });
      if (generation === epoch.current) {
        setMatches(result.matches);
        if (
          result.decision === 'quote' &&
          result.quote?.mode === mode &&
          result.quote.upperMicros !== null &&
          Number.isSafeInteger(result.quote.upperMicros) &&
          (mode === 'mock'
            ? result.quote.upperMicros === 0
            : result.quote.upperMicros === config.data?.verifiedUpperMicros)
        ) {
          quotedFingerprint.current = fingerprint;
          setQuote(result.quote);
        }
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function run() {
    if (!externalDispatchAllowed && request.mode === 'external') return;
    if (
      quotedFingerprint.current !== fingerprint ||
      quote?.mode !== mode ||
      quote.upperMicros === null
    )
      return;
    if (!valid || !quote || !consent || busy || Date.parse(quote.expiresAt) <= Date.now()) return;
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
        }),
      });
      if (generation === epoch.current) {
        setJobs((current) => [job, ...current.filter((value) => value.id !== job.id)]);
        setQuote(null);
        setConsent(false);
        operation.current = null;
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
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
      <h3>{g('title')}</h3>
      {!externalOnly && (
        <Field label={g('mode')}>
          <Select
            aria-label={g('mode')}
            value={mode}
            disabled={busy}
            onChange={(event) => setMode(event.target.value as 'mock' | 'external')}
          >
            <option value="mock">{g('mockMode')}</option>
            <option value="external" disabled={!config.data?.externalEnabled || !liveTestSessionId}>
              {g('externalMode')}
            </option>
          </Select>
        </Field>
      )}
      {!externalOnly && mode === 'mock' && <p>{g('mock')}</p>}
      {!config.data?.externalEnabled && (
        <div className={styles.notice}>
          <p>{g('unavailable')}</p>
          <details>
            <summary>{g('diagnostics')}</summary>
            {config.data?.externalBlockReasons.map((reason) => (
              <p key={reason}>
                <code>{reason}</code>
              </p>
            ))}
          </details>
        </div>
      )}
      {mode === 'external' && config.data?.requestProfile && (
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
        <fieldset disabled={busy || !config.data?.mockAvailable || !supported}>
          <Field label={a('name')}>
            <Input
              value={title}
              readOnly={!!preparedRequest}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={g('prompt')}>
            <Textarea
              aria-label={g('prompt')}
              value={prompt}
              readOnly={!!preparedRequest}
              maxLength={2000}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          <p>
            {a(spec.kind)} · {a(spec.camera)}
          </p>
          <Field label={g('background')}>
            <Select
              aria-label={g('background')}
              value={background}
              disabled={spec.kind === 'sprite' || spec.kind === 'object'}
              onChange={(event) => setBackground(event.target.value as 'opaque' | 'transparent')}
            >
              <option value="opaque">{g('opaque')}</option>
              <option value="transparent">{g('transparent')}</option>
            </Select>
          </Field>
          <Field label={a('license')}>
            <Input
              value={license}
              maxLength={120}
              onChange={(event) => setLicense(event.target.value)}
            />
          </Field>
          <Field label={a('attribution')}>
            <Input
              value={attribution}
              maxLength={240}
              onChange={(event) => setAttribution(event.target.value)}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={allowReuse}
              onChange={(event) => setAllowReuse(event.target.checked)}
            />
            {a('allowReuse')}
          </label>
          {!preparedRequest && (
            <fieldset>
              <legend>{g('references')}</legend>
              <p>{g('derivative')}</p>
              {library.data
                ?.filter((revision) => revision.owned)
                .map((revision) => (
                  <label key={revision.id}>
                    <input
                      type="checkbox"
                      checked={references.includes(revision.id)}
                      disabled={!references.includes(revision.id) && references.length >= 2}
                      onChange={(event) => {
                        setReferences((current) =>
                          event.target.checked
                            ? [...current, revision.id]
                            : current.filter((id) => id !== revision.id),
                        );
                        setAttested(false);
                      }}
                    />
                    {revision.metadata.title} · {a('revision')} {revision.revision}
                  </label>
                ))}
            </fieldset>
          )}
          <label>
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
            {g('rights')}
          </label>
          <Button type="submit" disabled={!valid || !externalDispatchAllowed}>
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
                <Button type="button" disabled={busy} onClick={() => onSelected(revision)}>
                  {a('use')}
                </Button>
              )}
            </div>
          ))}
          {!quote && (
            <Button
              type="button"
              variant="secondary"
              disabled={!valid || busy}
              onClick={() => void prepare(true)}
            >
              {g('decline')}
            </Button>
          )}
        </div>
      )}
      {quote && (
        <div role="status">
          <p>
            {quote.mode === 'mock'
              ? g('cost')
              : quote.costBasis === 'approved_estimate'
                ? `${g('estimatedCost')}: ${g('usd')} ${((quote.estimatedTotalMicros ?? 0) / 1000000).toFixed(6)}`
                : `${g('upperCost')}: ${g('usd')} ${((quote.upperMicros ?? 0) / 1000000).toFixed(6)}`}
          </p>
          {quote.costBasis === 'approved_estimate' && (
            <p>
              {g('reserveCost')}: {g('usd')} {((quote.reserveMicros ?? 0) / 1000000).toFixed(6)}.{' '}
              {g('estimateNotice')}
            </p>
          )}
          {quote.upperMicros === null ? (
            <p>{g('estimatePending')}</p>
          ) : Date.parse(quote.expiresAt) <= now ? (
            <p>{g('expires')}</p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {g('consent')}
              </label>
              <Button
                type="button"
                busy={busy}
                disabled={!consent || !externalDispatchAllowed}
                onClick={() => void run()}
              >
                {g('run')}
              </Button>
            </>
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
          <p>{g(job.status)}</p>
          {job.mode === 'mock' && <p>{g('mock')}</p>}
          {job.errorCode && <code>{job.errorCode}</code>}
          {job.diagnostic && (
            <p>
              {g('providerError')} · {g('httpStatus')} {job.diagnostic.httpStatus}
              {job.diagnostic.requestId ? ` · ${job.diagnostic.requestId}` : ''}
            </p>
          )}
          {job.mode === 'external' && (
            <p>
              {g('heldCost')}: {g('usd')} {(job.heldMicros / 1000000).toFixed(6)}
              {job.actualMicros !== undefined
                ? ` · ${g('actualCost')}: ${g('usd')} ${(job.actualMicros / 1000000).toFixed(6)}`
                : ''}
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
