'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/client';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useImageText } from '../assets/image-messages';
import { useAssetText } from '../assets/messages';
import type { ArtRevision } from '../assets/types';
import { useNarrativeText } from './narrative-messages';
export type GroundedPreparation = {
  adventureId: string;
  canonRevision: number;
  groundingHash: string;
  prompt: string;
  grounding: { map: { label: string }; subject?: { label: string } };
  spec: {
    kind: 'background' | 'portrait';
    camera: 'top-down' | 'portrait';
    tags: string[];
    background: 'opaque';
    referenceRevisionIds: string[];
  };
};
type Quote = { id: string; mode: 'mock' | 'external'; upperMicros: number; expiresAt: string };
type Job = {
  id: string;
  operationId: string;
  status:
    | 'queued'
    | 'dispatched'
    | 'unknown'
    | 'generated'
    | 'admitted'
    | 'rejected'
    | 'cancelled'
    | 'expired';
  revisionId?: string;
  errorCode?: string;
};
export function GroundedImage({
  campaignId,
  entityId,
  preparation,
  onRevision,
  disabled,
}: {
  campaignId: string;
  entityId?: string;
  preparation: GroundedPreparation;
  onRevision: (revision: ArtRevision) => void;
  disabled: boolean;
}) {
  const g = useImageText(),
    a = useAssetText(),
    h = useNarrativeText();
  const [license, setLicense] = useState(''),
    [attribution, setAttribution] = useState('');
  const [attested, setAttested] = useState(false),
    [consent, setConsent] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null),
    [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [matches, setMatches] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const lock = useRef(false),
    operation = useRef<{ quoteId: string; id: string } | null>(null);
  const epoch = useRef(0),
    seen = useRef(new Set<string>()),
    callback = useRef(onRevision);
  callback.current = onRevision;
  const rightsKey = JSON.stringify([license, attribution, attested]);
  useEffect(() => {
    setQuote(null);
    setConsent(false);
    setMatches(false);
  }, [rightsKey]);
  useEffect(() => {
    const current = ++epoch.current;
    let polling = false;
    async function refresh() {
      if (polling) return;
      polling = true;
      try {
        const result = await api<{ jobs: Job[] }>(
          `/image-generation/jobs?adventureId=${preparation.adventureId}&campaignId=${campaignId}`,
        );
        if (epoch.current !== current) return;
        setJobs(result.jobs);
        if (
          operation.current &&
          result.jobs.some((job) => job.operationId === operation.current?.id)
        ) {
          setUncertain(false);
          setQuote(null);
          setConsent(false);
        }
        for (const job of result.jobs)
          if (job.status === 'admitted' && job.revisionId && !seen.current.has(job.id)) {
            const revision = await api<ArtRevision>(`/asset-library/revisions/${job.revisionId}`);
            if (epoch.current !== current) return;
            seen.current.add(job.id);
            if (
              revision.metadata.kind === preparation.spec.kind &&
              (revision.metadata.camera === preparation.spec.camera ||
                revision.metadata.camera === 'unrestricted')
            )
              callback.current(revision);
          }
      } catch (err) {
        if (epoch.current === current) setError(errorMessage(err));
      } finally {
        polling = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [campaignId, preparation.adventureId, preparation.spec.kind, preparation.spec.camera]);
  async function estimate(declineReuse = false) {
    if (lock.current || !attested || !license.trim() || disabled) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setQuote(null);
    setConsent(false);
    const current = epoch.current;
    try {
      const result = await api<{
        decision: 'reuse' | 'quote';
        quote?: Quote;
        matches: ArtRevision[];
      }>('/image-generation/quotes', {
        method: 'POST',
        body: JSON.stringify({
          adventureId: preparation.adventureId,
          prompt: preparation.prompt,
          title: (preparation.grounding.subject?.label ?? preparation.grounding.map.label).slice(
            0,
            120,
          ),
          kind: preparation.spec.kind,
          camera: preparation.spec.camera,
          tags: preparation.spec.tags,
          background: preparation.spec.background,
          referenceRevisionIds: preparation.spec.referenceRevisionIds,
          rights: {
            basis: 'generated',
            licenseLabel: license.trim(),
            attribution: attribution.trim(),
            allowAuthorReuse: false,
            attested: true,
          },
          mode: 'mock',
          ...(declineReuse ? { declineReuse: true } : {}),
          campaignContext: {
            campaignId,
            expectedCanonRevision: preparation.canonRevision,
            groundingHash: preparation.groundingHash,
            kind: preparation.spec.kind,
            ...(entityId ? { entityId } : {}),
          },
        }),
      });
      if (current !== epoch.current) return;
      setMatches(result.decision === 'reuse');
      for (const revision of result.matches)
        if (
          revision.metadata.kind === preparation.spec.kind &&
          (revision.metadata.camera === preparation.spec.camera ||
            revision.metadata.camera === 'unrestricted')
        )
          callback.current(revision);
      if (
        result.decision === 'quote' &&
        result.quote?.mode === 'mock' &&
        result.quote.upperMicros === 0
      ) {
        setQuote(result.quote);
        operation.current = { quoteId: result.quote.id, id: crypto.randomUUID() };
      }
    } catch (err) {
      if (current === epoch.current) setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function run() {
    if (
      lock.current ||
      disabled ||
      !consent ||
      !attested ||
      !quote ||
      operation.current?.quoteId !== quote.id ||
      uncertain
    )
      return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setError(g('expires'));
      return;
    }
    lock.current = true;
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
      setJobs((previous) => [job, ...previous.filter((entry) => entry.id !== job.id)]);
      setQuote(null);
      setConsent(false);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setQuote(null);
        setConsent(false);
      } else setUncertain(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <details data-testid="grounded-image">
      <summary>{h('testArt')}</summary>
      <div className="stack">
        <p>{g('mock')}</p>
        <p>{g('unavailable')}</p>
        <Field label={a('license')}>
          <Input
            value={license}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setLicense(e.target.value)}
          />
        </Field>
        <Field label={a('attribution')}>
          <Input
            value={attribution}
            maxLength={240}
            disabled={busy}
            onChange={(e) => setAttribution(e.target.value)}
          />
        </Field>
        <label>
          <input
            type="checkbox"
            checked={attested}
            disabled={busy}
            onChange={(e) => setAttested(e.target.checked)}
          />{' '}
          {g('rights')}
        </label>
        <Button
          type="button"
          disabled={disabled || busy || !attested || !license.trim() || uncertain}
          onClick={() => void estimate(matches)}
        >
          {matches ? g('decline') : g('quote')}
        </Button>
        {matches && <p>{g('matches')}</p>}
        <ErrorBox message={error} />
        {uncertain && <p role="status">{g('unknown')}</p>}
        {quote && (
          <div data-testid="grounded-image-quote">
            <p>{g('cost')}</p>
            <label>
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={(e) => setConsent(e.target.checked)}
              />{' '}
              {g('consent')}
            </label>
            <Button
              type="button"
              disabled={disabled || busy || !consent || uncertain}
              onClick={() => void run()}
            >
              {g('run')}
            </Button>
          </div>
        )}
        {jobs.length > 0 && (
          <ul>
            {jobs.map((job) => (
              <li key={job.id} data-image-job={job.id} role="status">
                {g(job.status)}
                {job.errorCode ? ` · ${job.errorCode}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
