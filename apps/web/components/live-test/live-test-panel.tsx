'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
import {
  formatUsd,
  liveSessionActive,
  sameTurnFence,
  type LiveRequests,
  type LiveTestStatus,
  type TurnFence,
} from './types';
import { useLiveText } from './messages';
import styles from './live-test.module.css';

export function useLiveTestStatus() {
  const { user } = useClient();
  const [status, setStatus] = useState<LiveTestStatus | null>(null),
    [error, setError] = useState('');
  const owner = user?.role === 'admin' ? user.id : null;
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!owner) return;
    const current = ++epoch.current;
    try {
      const value = await api<LiveTestStatus>('/live-test/status');
      if (current === epoch.current) {
        setStatus(value);
        setError('');
      }
    } catch (e) {
      if (current === epoch.current) {
        if (e instanceof ApiError && [403, 409].includes(e.status)) setStatus(null);
        else setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
      }
    }
  }, [owner]);
  useEffect(() => {
    setStatus(null);
    if (owner) void refresh();
    return () => {
      epoch.current++;
    };
  }, [owner, refresh]);
  return { status, setStatus, error, refresh };
}
export function LiveTestPanel({
  campaignId,
  turnFence,
  worldPhase = false,
  onStatusChange,
}: {
  campaignId?: string;
  turnFence?: TurnFence;
  worldPhase?: boolean;
  onStatusChange?: (value: LiveTestStatus | null) => void;
}) {
  const { status, setStatus, error: statusError, refresh } = useLiveTestStatus();
  const m = useLiveText(),
    { locale } = useT();
  const [claimConsent, setClaimConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [batch, setBatch] = useState<LiveRequests | null>(null),
    [consents, setConsents] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now()),
    [uncertain, setUncertain] = useState<string[]>([]);
  const inFlight = useRef(false),
    operations = useRef(new Map<string, string>()),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const fenceKey = JSON.stringify(turnFence);
  useEffect(() => {
    setBatch(null);
    setConsents({});
    setUncertain([]);
  }, [campaignId, fenceKey]);
  if (!status) return null;
  const active = liveSessionActive(status, now),
    expired = Date.parse(status.expiresAt) <= now;
  const money = (value: number) => formatUsd(value, locale);
  async function claim() {
    if (inFlight.current || !claimConsent) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await api<LiveTestStatus>('/live-test/claim', {
        method: 'POST',
        body: JSON.stringify({ consent: true }),
      });
      if (mounted.current) {
        setStatus(next);
        setClaimConsent(false);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function requests() {
    if (!campaignId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<LiveRequests>(`/live-test/campaigns/${campaignId}/requests`);
      if (mounted.current) {
        setBatch(value);
        setConsents({});
        setUncertain([]);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function approve(requestId: string) {
    if (
      !campaignId ||
      !status ||
      !batch ||
      !consents[requestId] ||
      !active ||
      !sameTurnFence(turnFence, batch.turnFence) ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const key = `${status.sessionId}:${requestId}:${JSON.stringify(batch.turnFence)}`;
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    try {
      await api(`/live-test/campaigns/${campaignId}/requests/${requestId}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: status.sessionId,
          operationId: operations.current.get(key),
          turnFence: batch.turnFence,
          consent: true,
        }),
      });
      if (mounted.current) {
        setConsents((v) => ({ ...v, [requestId]: false }));
        setBatch((v) =>
          v
            ? {
                ...v,
                requests: v.requests.map((r) =>
                  r.id === requestId ? { ...r, permitState: 'authorized' } : r,
                ),
              }
            : null,
        );
      }
      await refresh();
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (!(e instanceof ApiError) || !e.status) setUncertain((v) => [...v, requestId]);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label={m('title')} data-testid="live-test-panel">
      <h2>{m('title')}</h2>
      <p className={styles.note}>{m('intro')}</p>
      <dl className={styles.budget}>
        {(
          [
            ['cap', status.capMicros],
            ['used', status.usedMicros],
            ['held', status.heldMicros],
            ['remaining', status.remainingMicros],
          ] as const
        ).map(([key, value]) => (
          <div key={key}>
            <dt>{m(key)}</dt>
            <dd>{money(value)}</dd>
          </div>
        ))}
      </dl>
      <p>
        {m(
          expired
            ? 'expired'
            : status.state === 'active'
              ? 'active'
              : status.state === 'unclaimed'
                ? 'unclaimed'
                : 'stopped',
        )}
      </p>
      <p className={styles.note}>
        {m('expiry')}: {new Date(status.expiresAt).toLocaleString(locale)}
      </p>
      <p className={styles.note}>{m('debit')}</p>
      <p className={styles.note}>
        {m('model')}: {status.text.model} · {m('upper')}: {money(status.text.upperMicros)}
      </p>
      <p className={styles.note}>
        {m('historical')}: {status.priorHeldReservations}
      </p>
      <p className={styles.note}>{m(status.imagesEnabled ? 'imageAvailable' : 'imageBlocked')}</p>
      {status.imageBlockCode && (
        <small>
          <code>{status.imageBlockCode}</code>
        </small>
      )}
      {status.stopCode && (
        <p role="status">
          <code>{status.stopCode}</code>
        </p>
      )}
      <ErrorBox message={error || statusError ? `${m('failure')} (${error || statusError})` : ''} />
      {status.state === 'unclaimed' && !expired && (
        <>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={claimConsent}
              onChange={(e) => setClaimConsent(e.target.checked)}
            />
            {m('claimConsent')}
          </label>
          <Button type="button" busy={busy} disabled={!claimConsent} onClick={() => void claim()}>
            {m('claim')}
          </Button>
        </>
      )}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void refresh()}>
        {m('refresh')}
      </Button>
      {campaignId && (
        <>
          <h3>{m('pending')}</h3>
          {!worldPhase && <p className={styles.note}>{m('worldOnly')}</p>}
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !active || !worldPhase}
            onClick={() => void requests()}
          >
            {m('load')}
          </Button>
          {batch && !sameTurnFence(turnFence, batch.turnFence) && <p role="status">{m('stale')}</p>}
          {batch?.requests.length === 0 && <p>{m('empty')}</p>}
          {batch?.requests.map((request) => (
            <article className={styles.request} key={request.id} data-live-request={request.id}>
              <strong>{request.subjectId}</strong>
              <code>{request.purpose}</code>
              <p>
                {m('upper')}: {money(request.upperMicros)}
              </p>
              {request.permitState && (
                <p>{m(request.permitState === 'authorized' ? 'approved' : request.permitState)}</p>
              )}
              {uncertain.includes(request.id) && <p role="status">{m('unknown')}</p>}
              {!request.permitState && (
                <>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={!!consents[request.id]}
                      disabled={busy || !active || !sameTurnFence(turnFence, batch.turnFence)}
                      onChange={(e) =>
                        setConsents((v) => ({ ...v, [request.id]: e.target.checked }))
                      }
                    />
                    {m('requestConsent')}
                  </label>
                  <Button
                    type="button"
                    busy={busy}
                    disabled={
                      !consents[request.id] ||
                      !active ||
                      uncertain.includes(request.id) ||
                      request.upperMicros > status.remainingMicros ||
                      !sameTurnFence(turnFence, batch.turnFence)
                    }
                    onClick={() => void approve(request.id)}
                  >
                    {m('dispatch')}
                  </Button>
                </>
              )}
            </article>
          ))}
        </>
      )}
      {!active && status.state === 'active' && !expired && <p>{m('noBudget')}</p>}
    </section>
  );
}
