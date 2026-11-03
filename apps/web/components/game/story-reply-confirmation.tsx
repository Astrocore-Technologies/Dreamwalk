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
    if (!unknown) setPrepared(null);
  }, [scope, unknown]);
  useEffect(() => {
    const expiry = prepared?.result.quote?.expiresAt;
    if (!expiry || unknown) return;
    const timer = setTimeout(
      () => {
        setPrepared(null);
        setError(h('expired'));
      },
      Math.max(0, Date.parse(expiry) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [prepared, unknown]);
  async function estimate() {
    if (flight.current || disabled || unknown) return;
    flight.current = true;
    setBusy(true);
    setError('');
    const stamp = epoch.current;
    const operationId = crypto.randomUUID();
    try {
      const result = await api<Pick<StoryTurnQuoteResponse, 'quote'>>(`${path}/quote`, {
        method: 'POST',
        body: JSON.stringify({ operationId }),
      });
      if (stamp !== epoch.current || currentScope.current !== scope) return;
      if (!result.quote || !providerBoundKnown(result.quote, result.quote.external)) {
        setError(h('noBound'));
        return;
      }
      setPrepared({ result, operationId, scope });
    } catch (err) {
      if (stamp === epoch.current) setError(errorMessage(err));
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
      (sent.scope !== scope || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
    ) {
      setPrepared(null);
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
        await onChanged();
      }
    } finally {
      flight.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  return (
    <div className={styles.quote} data-testid="story-reply-confirmation">
      <p>{h(worldBatch ? 'worldEstimate' : 'replyEstimateChanged')}</p>
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
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setPrepared(null)}
            >
              {h('dismiss')}
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          busy={busy}
          disabled={busy || disabled}
          onClick={() => void estimate()}
        >
          {h(worldBatch ? 'estimateWorld' : 'refreshEstimate')}
        </Button>
      )}
    </div>
  );
}
