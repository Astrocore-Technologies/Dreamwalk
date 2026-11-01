'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button } from '../ui';
import { useLiveText } from './messages';
import { formatUsd, type LiveRequest, type TurnFence, type TextCountReceipt } from './types';
export function TextCountPreflight({
  request,
  campaignId,
  turnFence,
  disabled,
  onChanged,
}: {
  request: LiveRequest;
  campaignId: string;
  turnFence: TurnFence;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const { user } = useClient();
  const storageKey = `dreamwalk-text-count:${user?.id ?? 'none'}:${campaignId}:${request.id}`;
  const [hydrated, setHydrated] = useState(false);
  const m = useLiveText(),
    { locale } = useT();
  const [consent, setConsent] = useState(false),
    [limit, setLimit] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unknown, setUnknown] = useState(false);
  const alive = useRef(true);
  const operation = useRef<string | null>(null),
    flight = useRef(false);
  useEffect(() => {
    setHydrated(false);
    try {
      const saved = localStorage.getItem(storageKey);
      const id = saved ? JSON.parse(saved).operationId : null;
      if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) {
        operation.current = id;
        setUnknown(true);
      }
      setHydrated(true);
    } catch {
      setError('TEXT_COUNT_LOCAL_RECEIPT_UNAVAILABLE');
    }
  }, [storageKey]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => setConsent(false), [request.counting?.candidateFingerprint]);
  const view = request.counting;
  if (!view) return null;
  const blocked =
    disabled ||
    !hydrated ||
    !!request.permitState ||
    !!view.blockCode ||
    view.attempts >= view.maxAttempts ||
    ['dispatched', 'unknown'].includes(view.latest?.status ?? '') ||
    busy;
  async function run(reconcile = false) {
    if (flight.current || (!reconcile && (blocked || !consent || unknown))) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      if (!operation.current) operation.current = crypto.randomUUID();
      if (!reconcile)
        localStorage.setItem(storageKey, JSON.stringify({ operationId: operation.current }));
      const result = await api<TextCountReceipt>(
        reconcile
          ? `/generation/text-counts/operations/${operation.current}`
          : `/generation/campaigns/${campaignId}/requests/${request.id}/preflight`,
        reconcile
          ? undefined
          : {
              method: 'POST',
              body: JSON.stringify({
                operationId: operation.current,
                turnFence,
                policyRevision: request.policyRevision,
                policyHash: request.policyHash,
                candidateFingerprint: view!.candidateFingerprint,
                ...(limit ? { keepRecentHistory: Number(limit) } : {}),
                consent: true,
              }),
            },
      );
      if (!alive.current) return;
      setUnknown(result.status === 'dispatched');
      setConsent(false);
      if (result.status === 'unknown') setError('TEXT_COUNT_OUTCOME_UNKNOWN');
      await onChanged();
      if (result.status !== 'dispatched') {
        localStorage.removeItem(storageKey);
        operation.current = null;
      }
    } catch (e) {
      if (!alive.current) return;
      setConsent(false);
      setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
      if (!(e instanceof ApiError) || !e.status) setUnknown(true);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section data-testid="text-count-preflight">
      <h4>{m('countTitle')}</h4>
      <p>{m('countIntro')}</p>
      <p>{m('countInvoice')}</p>
      <p>
        {m('countPrice')}:{' '}
        {view.reserveMicros === null
          ? m('countPriceUnknown')
          : formatUsd(view.reserveMicros, locale)}
      </p>
      {view.blockCode && (
        <p role="status">
          {view.blockCode === 'TEXT_COUNT_COST_REVIEW_REQUIRED'
            ? m('countPriceUnknown')
            : view.blockCode}
        </p>
      )}
      {view.latest && (
        <p role="status">
          {m('countResult')}:{' '}
          {m(
            (
              {
                succeeded: 'countSucceeded',
                dispatched: 'countDispatched',
                unknown: 'countUnknown',
                over_context: 'countOverflow',
                stale: 'countStale',
                erased: 'countErased',
              } as const
            )[view.latest.status as 'succeeded'] ?? 'countUnknown',
          )}{' '}
          · {view.latest.inputTokens ?? '—'}
        </p>
      )}
      <label>
        {m('countHistoryLimit')}
        <input
          type="number"
          min="1"
          max={Math.max(1, view.historyRecords)}
          value={limit}
          disabled={blocked || unknown}
          onChange={(e) => {
            setLimit(e.target.value);
            setConsent(false);
            operation.current = null;
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={consent}
          disabled={blocked || unknown}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {m('countConsent')}
      </label>
      <Button type="button" disabled={blocked || !consent || unknown} onClick={() => void run()}>
        {m('countRun')}
      </Button>
      {unknown && (
        <Button type="button" disabled={busy} onClick={() => void run(true)}>
          {m('countReconcile')}
        </Button>
      )}
      {error && (
        <p role="status">
          {m('failure')} ({error})
        </p>
      )}
      <p>{m('countApproximate')}</p>
    </section>
  );
}
