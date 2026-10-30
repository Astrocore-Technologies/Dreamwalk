'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Select, Textarea } from '@/components/ui';
import type { ArtRevision, ArtSpec } from './types';
import { artPreviewUrl } from './types';
import { useAssetText } from './messages';
import { useImageText } from './image-messages';
import styles from './assets.module.css';
type Job = {
  id: string;
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
  heldMicros: number;
  actualMicros?: number;
  createdAt: string;
  canCancel: boolean;
};
type Quote = {
  id: string;
  mode: 'mock' | 'external';
  upperMicros: number;
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
  spec,
  onSelected,
  onAdmitted,
}: {
  adventureId: string;
  spec: ArtSpec;
  onSelected?: (revision: ArtRevision) => void;
  onAdmitted: () => void;
}) {
  const a = useAssetText(),
    g = useImageText();
  const config = useResource<{
    mockAvailable: boolean;
    externalEnabled: boolean;
    externalBlockReasons: string[];
  }>('/image-generation/config');
  const library = useResource<ArtRevision[]>('/asset-library');
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
    rights: {
      basis: 'generated' as const,
      licenseLabel: license.trim(),
      attribution: attribution.trim(),
      allowAuthorReuse: allowReuse,
      attested: true as const,
    },
    mode: 'mock' as const,
  };
  const fingerprint = JSON.stringify({ request, attested });
  useEffect(() => {
    setBackground(spec.kind === 'sprite' || spec.kind === 'object' ? 'transparent' : 'opaque');
  }, [spec.kind]);
  useEffect(() => {
    epoch.current++;
    setQuote(null);
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
          setJobs(result.jobs);
          setJobsError('');
          let changed = false;
          for (const job of result.jobs)
            if (job.status === 'admitted' && !seen.current.has(job.id)) {
              seen.current.add(job.id);
              changed = true;
            }
          if (changed) callbacks.current.onAdmitted();
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
  }, [adventureId]);
  const valid =
    supported &&
    !!prompt.trim() &&
    !!title.trim() &&
    !!license.trim() &&
    attested &&
    config.data?.mockAvailable;
  async function prepare(declineReuse = false) {
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
          result.quote?.mode === 'mock' &&
          result.quote.upperMicros === 0
        )
          setQuote(result.quote);
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function run() {
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
      <p>{g('mock')}</p>
      <p className={styles.notice}>{g('unavailable')}</p>
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
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={g('prompt')}>
            <Textarea
              aria-label={g('prompt')}
              value={prompt}
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
          <label>
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
            {g('rights')}
          </label>
          <Button type="submit" disabled={!valid}>
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
          <p>{g('cost')}</p>
          {Date.parse(quote.expiresAt) <= now ? (
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
              <Button type="button" busy={busy} disabled={!consent} onClick={() => void run()}>
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
