'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GameProjection } from '@dreamwalk/contracts';
import { SceneMedia } from './scene-media';
import { api, ApiError, errorMessage } from '@/lib/client';
import { Button, ErrorBox, Field, Textarea } from '@/components/ui';
import { providerBoundKnown, samePreparedTurn } from './narrative-guards';
import { useNarrativeText } from './narrative-messages';
type Turn = {
  id: string;
  operationId: string;
  actorId: string;
  status: 'pending' | 'committed' | 'stale' | 'failed';
  text?: string;
  narration?: string;
  canonRevision?: number;
  code?: string;
  createdAt: string;
  jobStatus?: string;
};
type NarrativeStatus = {
  canonRevision: number;
  canSubmit: boolean;
  configuration: {
    provider: 'mock' | 'external';
    enabled: boolean;
    externalCallsEnabled: boolean;
    demo: boolean;
  };
  turns: Turn[];
};
type Quote = {
  providerUpperMicros?: number;
  external?: boolean;
  provider?: string;
  id: string;
  credits: number;
  expiresAt: string;
  demo: boolean;
  requiresConsent: boolean;
  policyVersion: string;
};
type Prepared = {
  quote: Quote;
  text: string;
  canonRevision: number;
  operationId: string;
  sceneId: string;
};
export function NarrativeDirector({
  campaignId,
  sceneId,
  projection,
  onWorldRefresh,
  disabled,
}: {
  campaignId: string;
  sceneId: string;
  projection: GameProjection;
  onWorldRefresh: () => void;
  disabled: boolean;
}) {
  const h = useNarrativeText();
  const inputHintId = useId();
  const path = `/game/campaigns/${campaignId}/narrative`;
  const [status, setStatus] = useState<NarrativeStatus | null>(null);
  const [text, setText] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState(false);
  const generation = useRef(0),
    actionLock = useRef(false),
    refreshing = useRef(false);
  const submitted = useRef<Prepared | null>(null);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const request = generation.current;
    try {
      const result = await api<NarrativeStatus>(path);
      if (request !== generation.current) return;
      setStatus(result);
      const sent = submitted.current;
      const turn = sent && result.turns.find((value) => value.operationId === sent.operationId);
      if (turn) {
        setUncertain(false);
        setPrepared(null);
        if (turn.status === 'committed') {
          setText((value) => (value.trim() === sent.text ? '' : value));
          submitted.current = null;
        } else if (turn.status === 'stale' || turn.status === 'failed') submitted.current = null;
      }
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      refreshing.current = false;
    }
  }, [path]);
  useEffect(() => {
    generation.current++;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (
      prepared &&
      !submitted.current &&
      status &&
      (prepared.canonRevision !== status.canonRevision || prepared.sceneId !== sceneId)
    ) {
      setPrepared(null);
      setQuoteChanged(true);
    }
  }, [status, prepared, sceneId]);
  async function estimate() {
    if (
      actionLock.current ||
      submitted.current ||
      uncertain ||
      !available ||
      !status ||
      !text.trim() ||
      disabled
    )
      return;
    actionLock.current = true;
    const request = generation.current;
    const input = text.trim(),
      canonRevision = status.canonRevision;
    setBusy(true);
    setPrepared(null);
    setQuoteChanged(false);
    setError('');
    try {
      const quote = await api<Quote>(`${path}/quote`, {
        method: 'POST',
        body: JSON.stringify({ text: input, expectedCanonRevision: canonRevision }),
      });
      if (request === generation.current)
        setPrepared({
          quote,
          text: input,
          canonRevision,
          sceneId,
          operationId: crypto.randomUUID(),
        });
    } catch (err) {
      if (request === generation.current)
        setError(
          err instanceof ApiError && err.code === 'STALE_CANON' ? h('changed') : errorMessage(err),
        );
    } finally {
      actionLock.current = false;
      if (request === generation.current) setBusy(false);
    }
  }
  async function confirm() {
    if (
      !prepared ||
      actionLock.current ||
      uncertain ||
      disabled ||
      !available ||
      !status ||
      prepared.sceneId !== sceneId ||
      !samePreparedTurn(prepared, text, status.canonRevision) ||
      !providerBoundKnown(prepared.quote, status.configuration.provider === 'external') ||
      Date.now() >= Date.parse(prepared.quote.expiresAt)
    )
      return;
    actionLock.current = true;
    const request = generation.current,
      sent = prepared;
    submitted.current = sent;
    setBusy(true);
    setError('');
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({
          operationId: sent.operationId,
          text: sent.text,
          expectedCanonRevision: sent.canonRevision,
          quoteId: sent.quote.id,
          consent: true,
        }),
      });
      if (request !== generation.current) return;
      setPrepared(null);
      await refresh();
    } catch (err) {
      if (request === generation.current) {
        setError(
          err instanceof ApiError && err.code === 'STALE_CANON' ? h('changed') : errorMessage(err),
        );
        if (
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408
        ) {
          submitted.current = null;
          setPrepared(null);
          void refresh();
        } else setUncertain(true);
      }
    } finally {
      actionLock.current = false;
      if (request === generation.current) setBusy(false);
    }
  }
  const pending = !!submitted.current || !!status?.turns.some((turn) => turn.status === 'pending');
  const available =
    !!status?.canSubmit &&
    status.configuration.enabled &&
    (status.configuration.provider === 'mock' || status.configuration.externalCallsEnabled);
  const committed = status?.turns.filter((turn) => turn.status === 'committed') || [];
  return (
    <section
      className="stack"
      data-testid="narrative-director"
      aria-label={h('title')}
      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <h2>{h('title')}</h2>
      <p>{h('hint')}</p>
      {status && <small>{h(status.configuration.provider === 'mock' ? 'mock' : 'external')}</small>}
      {status && !available && <p role="status">{h('unavailable')}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void estimate();
        }}
        className="stack"
      >
        <Field label={h('input')}>
          <Textarea
            aria-label={h('input')}
            aria-describedby={inputHintId}
            value={text}
            maxLength={1000}
            required
            rows={3}
            disabled={disabled || busy || pending || uncertain}
            placeholder={h('placeholder')}
            onChange={(event) => {
              setText(event.target.value);
              setPrepared(null);
            }}
          />
        </Field>
        <small id={inputHintId}>{h('shared')}</small>
        <Button
          type="submit"
          disabled={disabled || busy || pending || uncertain || !available || !text.trim()}
          busy={busy}
        >
          {h('prepare')}
        </Button>
      </form>
      {prepared && !uncertain && (
        <div data-testid="narrative-quote" className="stack">
          <p>{h('cost', { credits: prepared.quote.credits })}</p>
          {prepared.quote.demo && <small>{h('demo')}</small>}
          {(prepared.quote.external ?? status?.configuration.provider === 'external') && (
            <p>
              {providerBoundKnown(prepared.quote, true)
                ? h('providerBound', {
                    amount: ((prepared.quote.providerUpperMicros || 0) / 1000000).toFixed(6),
                  })
                : h('missingBound')}
            </p>
          )}
          <p>{h('expires', { time: new Date(prepared.quote.expiresAt).toLocaleTimeString() })}</p>
          <Button
            type="button"
            disabled={
              disabled ||
              busy ||
              pending ||
              prepared.canonRevision !== status?.canonRevision ||
              prepared.sceneId !== sceneId ||
              !providerBoundKnown(prepared.quote, status?.configuration.provider === 'external') ||
              Date.now() >= Date.parse(prepared.quote.expiresAt)
            }
            onClick={() => void confirm()}
          >
            {h('confirm')}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setPrepared(null)}>
            {h('cancel')}
          </Button>
        </div>
      )}
      <ErrorBox message={error} retry={() => void refresh()} />
      {quoteChanged && <p role="status">{h('changed')}</p>}
      {pending && !uncertain && !status?.turns.some((turn) => turn.status === 'pending') && (
        <p role="status">{h('pending')}</p>
      )}
      {uncertain && <p role="status">{h('unknown')}</p>}
      {status?.turns
        .filter((turn) => turn.status !== 'committed')
        .map((turn) => (
          <p key={turn.id} role="status" data-narrative-status={turn.status}>
            {h(
              turn.jobStatus === 'reconciling'
                ? 'unknown'
                : turn.status === 'pending'
                  ? 'pending'
                  : turn.status === 'stale'
                    ? 'stale'
                    : 'failed',
            )}
          </p>
        ))}
      {(pending || uncertain) && (
        <Button type="button" variant="secondary" onClick={() => void refresh()}>
          {h('refresh')}
        </Button>
      )}
      <SceneMedia
        key={`${sceneId}:${status?.canonRevision ?? 0}`}
        campaignId={campaignId}
        projection={projection}
        disabled={disabled}
        onApplied={onWorldRefresh}
      />
      <div
        role="log"
        aria-label={h('journal')}
        aria-live="polite"
        aria-relevant="additions"
        data-testid="narrative-journal"
        style={{ maxHeight: '28rem', overflowY: 'auto' }}
      >
        {!committed.length && <p>{h('empty')}</p>}
        {committed.map((turn) => (
          <article
            key={turn.id}
            data-narrative-turn={turn.id}
            data-canon-revision={turn.canonRevision}
          >
            <h3>{h('player')}</h3>
            <p>{turn.text}</p>
            <h3>{h('director')}</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{turn.narration}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
