'use client';
import { useEffect, useRef, useState } from 'react';
import type { StoryTurnQuoteResponse } from '@dreamwalk/contracts';
import { api, ApiError, errorMessage } from '@/lib/client';
import { Button, ErrorBox } from '../ui';
import { StoryCost, RuntimeMapQuoteNotice } from './story-cost';
import { providerBoundKnown } from './narrative-guards';
import { useStoryText } from './story-messages';
import styles from './story-feed.module.css';

/** Reprices only an unpaid reply whose world context changed; never reposts the message. */
export function StoryReplyConfirmation({
  campaignId,
  turnId,
  scope,
  disabled,
  onChanged,
  endpoint,
  worldBatch = false,
}: {
  campaignId: string;
  turnId: string;
  scope: string;
  disabled: boolean;
  onChanged: () => Promise<void>;
  endpoint?: string;
  worldBatch?: boolean;
}) {
  const h = useStoryText();
  const [prepared, setPreparedState] = useState<{
    result: Pick<StoryTurnQuoteResponse, 'quote'>;
    operationId: string;
    scope: string;
  } | null>(null);
  const preparedCurrent = useRef<typeof prepared>(null);
  function setPrepared(value: typeof prepared) {
    preparedCurrent.current = value;
    setPreparedState(value);
  }
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const quoteOperation = useRef<{ path: string; scope: string; id: string } | null>(null);
  const confirmed = useRef(false);
  const flight = useRef(false);
  const submitted = useRef<typeof prepared>(null);
  const epoch = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const path = endpoint ?? `/game/campaigns/${campaignId}/turns/${turnId}/replies`;
  useEffect(() => {
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [path]);
  useEffect(() => {
    if (!unknown) {
      setPrepared(null);
      setError('');
      quoteOperation.current = null;
      confirmed.current = false;
    }
  }, [path, scope]);
  useEffect(() => {
    const expiry = prepared?.result.quote?.expiresAt;
    if (!expiry || unknown) return;
    const timer = setTimeout(
      () => {
        setPrepared(null);
        quoteOperation.current = null;
        if (worldBatch) setRefreshVersion((value) => value + 1);
        else setError(h('expired'));
      },
      Math.max(0, Date.parse(expiry) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [prepared, unknown]);
  // A quote prepares pricing only. Consent remains an explicit, separate action.
  // Debounce changing world scopes and never restart an uncertain/accepted dispatch.
  useEffect(() => {
    if (!worldBatch || disabled || unknown || confirmed.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      if (!active) return;
      if (flight.current) timer = setTimeout(start, 150);
      else if (!preparedCurrent.current) void estimate();
    };
    timer = setTimeout(start, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [worldBatch, path, scope, disabled, unknown, refreshVersion]);
  async function estimate() {
    if (flight.current || disabled || unknown || confirmed.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    const stamp = epoch.current;
    if (quoteOperation.current?.path !== path || quoteOperation.current.scope !== scope)
      quoteOperation.current = { path, scope, id: crypto.randomUUID() };
    const operationId = quoteOperation.current.id;
    try {
      const result = await api<Pick<StoryTurnQuoteResponse, 'quote'>>(`${path}/quote`, {
        method: 'POST',
        body: JSON.stringify({ operationId }),
      });
      if (stamp !== epoch.current || currentScope.current !== scope) return;
      if (!result.quote || !providerBoundKnown(result.quote, result.quote.external)) {
        quoteOperation.current = null;
        setError(h('noBound'));
        return;
      }
      const expiry = Date.parse(result.quote.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        quoteOperation.current = null;
        setError(h('expired'));
        return;
      }
      setPrepared({ result, operationId, scope });
    } catch (err) {
      if (stamp === epoch.current && currentScope.current === scope) {
        setError(errorMessage(err));
        // Definitive rejection can be recalculated. An uncertain quote read retries
        // its operation rather than leaving duplicate native quotes behind.
        if (err instanceof ApiError && err.status && err.status < 500 && err.status !== 408)
          quoteOperation.current = null;
      }
    } finally {
      flight.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  async function confirm() {
    const sent = unknown ? submitted.current : prepared;
    const quote = sent?.result.quote;
    if (
      flight.current ||
      disabled ||
      !sent ||
      !quote ||
      (!unknown && sent !== preparedCurrent.current)
    )
      return;
    const expiresAt = Date.parse(quote.expiresAt);
    if (
      !unknown &&
      (sent.scope !== currentScope.current ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now())
    ) {
      setPrepared(null);
      quoteOperation.current = null;
      setError(h('expired'));
      return;
    }
    flight.current = true;
    submitted.current = sent;
    setBusy(true);
    setError('');
    const stamp = epoch.current;
    let accepted = false;
    try {
      await api(`${path}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          operationId: sent.operationId,
          quoteId: quote.id,
          consent: true,
        }),
      });
      accepted = true;
      confirmed.current = true;
      if (stamp !== epoch.current) return;
      setUnknown(false);
      submitted.current = null;
      setPrepared(null);
      await onChanged();
    } catch (err) {
      if (stamp !== epoch.current) return;
      setError(errorMessage(err));
      if (accepted) return;
      if (!(err instanceof ApiError) || !err.status || err.status >= 500 || err.status === 408)
        setUnknown(true);
      else {
        setUnknown(false);
        submitted.current = null;
        setPrepared(null);
        quoteOperation.current = null;
        await onChanged();
      }
    } finally {
      flight.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  return (
    <div
      className={worldBatch ? styles.liveCost : styles.quote}
      data-testid="story-reply-confirmation"
      data-live-world-cost={worldBatch || undefined}
    >
      <p>{h(worldBatch ? 'worldCostTitle' : 'replyEstimateChanged')}</p>
      <RuntimeMapQuoteNotice />
      <ErrorBox message={error} />
      {unknown ? (
        <>
          <p role="status">{h('unknown')}</p>
          <Button type="button" disabled={busy || disabled} onClick={() => void confirm()}>
            {h('retrySame')}
          </Button>
        </>
      ) : prepared?.result.quote ? (
        <>
          <StoryCost quote={prepared.result.quote} />
          <div className={styles.actions}>
            <Button type="button" disabled={busy || disabled} onClick={() => void confirm()}>
              {h('confirm')}
            </Button>
            {!worldBatch && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setPrepared(null);
                  quoteOperation.current = null;
                }}
              >
                {h('dismiss')}
              </Button>
            )}
          </div>
        </>
      ) : confirmed.current ? (
        <p role="status">{h('worldPending')}</p>
      ) : worldBatch && !error ? (
        <p role="status">{h('worldCostCalculating')}</p>
      ) : (
        <Button
          type="button"
          busy={busy}
          disabled={busy || disabled}
          onClick={() => void estimate()}
        >
          {h(worldBatch ? 'retryEstimate' : 'refreshEstimate')}
        </Button>
      )}
    </div>
  );
}
