'use client';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { SPARKS_REFRESH_EVENT } from '@/lib/sparks-wallet';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
import {
  formatUsd,
  liveRequestReserve,
  ownerClaimFingerprintCurrent,
  liveRequestConsentFence,
  liveRequestPolicyCurrent,
  GenerationResponseScope,
  liveSessionActive,
  generationAuthorizationId,
  generationRemaining,
  generationExpired,
  generationPricingCurrent,
  sameTurnFence,
  type LiveRequests,
  type LiveTestStatus,
  type TurnFence,
} from './types';
import { useLiveText } from './messages';
import styles from './live-test.module.css';
import { TextRequestReserve } from './request-reserve';
import { TextCountPreflight } from './text-count-preflight';
import { OwnerPolicyReview } from './owner-policy-review';
import { useSparkCosts } from '../visual-authoring/sparks-cost';

export function useLiveTestStatus() {
  const { user } = useClient();
  // The server resolves the configured owner handle; owner status does not require an admin role.
  const owner = user?.id ?? null;
  const [snapshot, setSnapshot] = useState<{
    owner: string | null;
    status: LiveTestStatus | null;
    error: string;
  }>({ owner: null, status: null, error: '' });
  const epoch = useRef(0),
    identity = useRef(owner);
  identity.current = owner;
  const setStatus = useCallback(
    (value: LiveTestStatus | null) => {
      if (identity.current === owner) {
        if (value?.ownerId !== undefined && value.ownerId !== owner)
          setSnapshot({ owner, status: null, error: 'ACCOUNT_CHANGED' });
        else setSnapshot({ owner, status: value, error: '' });
      }
    },
    [owner],
  );
  const refresh = useCallback(async () => {
    if (!owner) return;
    const current = ++epoch.current;
    try {
      const value = await api<LiveTestStatus>('/generation/status');
      if (current === epoch.current && identity.current === owner) {
        if (value.ownerId !== undefined && value.ownerId !== owner) {
          setSnapshot({ owner, status: null, error: 'ACCOUNT_CHANGED' });
          return;
        }
        setSnapshot({ owner, status: value, error: '' });
      }
    } catch (e) {
      if (current === epoch.current && identity.current === owner) {
        // Never retain an authorization after a failed access/configuration refresh.
        setSnapshot({
          owner,
          status: null,
          error: e instanceof ApiError ? e.code : 'NETWORK_ERROR',
        });
      }
    }
  }, [owner]);
  useEffect(() => {
    setStatus(null);
    if (owner) void refresh();
    return () => {
      epoch.current++;
    };
  }, [owner, refresh, setStatus]);
  useEffect(() => {
    if (!owner) return;
    const changed = () => {
      void refresh();
    };
    window.addEventListener('focus', changed);
    window.addEventListener(SPARKS_REFRESH_EVENT, changed);
    return () => {
      window.removeEventListener('focus', changed);
      window.removeEventListener(SPARKS_REFRESH_EVENT, changed);
    };
  }, [owner, refresh]);
  // Hide the previous account's status during the render before effect cleanup.
  return {
    status: snapshot.owner === owner ? snapshot.status : null,
    setStatus,
    error: snapshot.owner === owner ? snapshot.error : '',
    refresh,
  };
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
  const { user } = useClient();
  const responseScope = useRef(new GenerationResponseScope()).current;
  const scopeKey = JSON.stringify({ owner: user?.id ?? null, campaignId, turnFence });
  responseScope.update(scopeKey);
  const m = useLiveText(),
    { amount: sparkAmount } = useSparkCosts(),
    { locale } = useT();
  const [claimConsent, setClaimConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [batchState, setBatchState] = useState<{ stamp: number; value: LiveRequests } | null>(null),
    [consents, setConsents] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now()),
    [uncertain, setUncertain] = useState<string[]>([]);
  const inFlight = useRef(false),
    operations = useRef(new Map<string, string>()),
    mounted = useRef(true);
  const batch = batchState && responseScope.current(batchState.stamp) ? batchState.value : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      responseScope.invalidate();
    };
  }, []);
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const authorizationKey = JSON.stringify({
    id: status?.mode === 'release' ? user?.id : generationAuthorizationId(status),
    mode: status?.mode,
    state: status?.state,
    cap: status?.capMicros,
    remaining: status?.remainingMicros,
    held: status?.heldMicros,
    pricing: status?.pricingValidUntil,
    configFingerprint: status?.configFingerprint,
    policyRevision: status?.policyRevision,
    policyHash: status?.policyHash,
  });
  useEffect(() => {
    setClaimConsent(false);
    setConsents({});
  }, [authorizationKey]);
  const fenceKey = JSON.stringify(turnFence);
  useEffect(() => {
    setBatchState(null);
    setClaimConsent(false);
    setError('');
    setConsents({});
    setUncertain([]);
  }, [scopeKey, fenceKey]);
  if (!status)
    return statusError ? (
      <section
        className={styles.panel}
        aria-label={m('unavailableTitle')}
        data-testid="generation-unavailable"
      >
        <h2>{m('unavailableTitle')}</h2>
        <p>{m('unavailable')}</p>
        <ErrorBox message={`${m('failure')} (${statusError})`} />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          {m('refresh')}
        </Button>
      </section>
    ) : null;
  const ownerMode = status.mode === 'owner',
    releaseMode = status.mode === 'release',
    active = liveSessionActive(status, now),
    expired = generationExpired(status, now),
    pricingCurrent = generationPricingCurrent(status, now);

  const releaseReason = (code: string) => {
    switch (code) {
      case 'SPARK_WALLET_NOT_ENABLED':
        return m('walletNotEnabled');
      case 'INSUFFICIENT_SPARKS':
        return m('insufficientSparks');
      case 'GENERATION_ACCOUNT_REVIEW_REQUIRED':
        return m('accountReview');
      case 'GENERATION_POLICY_CHANGED':
        return m('policyChanged');
      case 'GENERATION_PRICING_EXPIRED':
        return m('pricingExpired');
      default:
        return m('releaseUnavailable');
    }
  };
  const money = (value: number | null) =>
    value === null ? '—' : releaseMode ? sparkAmount(value) : formatUsd(value, locale);
  async function claim() {
    if (
      !status ||
      inFlight.current ||
      releaseMode ||
      !claimConsent ||
      !status.enabled ||
      !ownerClaimFingerprintCurrent(status) ||
      status.state !== 'unclaimed' ||
      generationExpired(status) ||
      !generationPricingCurrent(status)
    )
      return;
    const stamp = responseScope.capture();
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await api<LiveTestStatus>('/generation/claim', {
        method: 'POST',
        body: ownerMode
          ? JSON.stringify({ consent: true, candidateFingerprint: status.configFingerprint })
          : JSON.stringify({ consent: true }),
      });
      if (mounted.current && responseScope.current(stamp)) {
        setStatus(next);
        setClaimConsent(false);
      }
    } catch (e) {
      if (mounted.current && responseScope.current(stamp)) {
        setClaimConsent(false);
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (e instanceof ApiError && e.code === 'GENERATION_POLICY_STALE') await refresh();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function requests() {
    if (!campaignId || inFlight.current) return;
    const stamp = responseScope.capture();
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<LiveRequests>(`/generation/campaigns/${campaignId}/requests`);
      if (mounted.current && responseScope.current(stamp)) {
        setBatchState({ stamp, value });
        setConsents({});
        setUncertain([]);
      }
    } catch (e) {
      if (mounted.current && responseScope.current(stamp))
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
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
    const request = batch.requests.find((value) => value.id === requestId);
    if (!request || request.errorCode || !liveRequestPolicyCurrent(request, status)) return;
    const consentFence = liveRequestConsentFence(request, status);
    if (consentFence === null) return;
    const reserve = liveRequestReserve(request);
    if (reserve === null || reserve > generationRemaining(status, 'text')) return;
    const stamp = responseScope.capture();
    inFlight.current = true;
    setBusy(true);
    setError('');
    const key = `${status.sessionId}:${requestId}:${JSON.stringify(batch.turnFence)}`;
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    try {
      await api(`/generation/campaigns/${campaignId}/requests/${requestId}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          ...(releaseMode
            ? {}
            : ownerMode
              ? { authorizationId: generationAuthorizationId(status) }
              : { sessionId: status.sessionId }),
          operationId: operations.current.get(key),
          turnFence: batch.turnFence,
          ...consentFence,
          consent: true,
          ...(request.automaticKnownCostPolicy === 'known-cost-v1'
            ? { automaticKnownCostPolicy: request.automaticKnownCostPolicy }
            : {}),
        }),
      });
      if (mounted.current && responseScope.current(stamp)) {
        setConsents((v) => ({ ...v, [requestId]: false }));
        setBatchState((v) =>
          v && responseScope.current(v.stamp)
            ? {
                ...v,
                value: {
                  ...v.value,
                  requests: v.value.requests.map((r) =>
                    r.id === requestId ? { ...r, permitState: 'authorized' } : r,
                  ),
                },
              }
            : null,
        );
      }
      if (mounted.current && responseScope.current(stamp)) await refresh();
    } catch (e) {
      if (mounted.current && responseScope.current(stamp)) {
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (!(e instanceof ApiError) || !e.status) setUncertain((v) => [...v, requestId]);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className={styles.panel}
      aria-label={m(releaseMode ? 'releaseTitle' : ownerMode ? 'ownerTitle' : 'title')}
      data-testid={releaseMode ? 'release-generation-panel' : 'live-test-panel'}
      data-generation-mode={status.mode ?? 'manual'}
    >
      {releaseMode ? (
        <>
          <h2>{m('releaseTitle')}</h2>
          <p>{m(active ? 'releaseReady' : 'releaseUnavailable')}</p>
          <p className={styles.note}>{m('releaseBilling')}</p>
          {status.allowance === 'unlimited' && (
            <p data-generation-unlimited>
              {m('releaseUnlimited')} {m('releaseWalletAvailable')}:{' '}
              {status.dreamsAvailableSubunits !== undefined &&
              status.sparksAvailableSubunits !== undefined ? (
                <span>
                  {m('dreams')}: {formatSparkSubunits(status.dreamsAvailableSubunits, locale)} ·{' '}
                  {m('sparks')}: {formatSparkSubunits(status.sparksAvailableSubunits, locale)}
                </span>
              ) : (
                sparkAmount(status.remainingMicros)
              )}
            </p>
          )}
          {!pricingCurrent && <p role="status">{m('pricingExpired')}</p>}
          {status.stopCode && (
            <p role="status">
              {releaseReason(status.stopCode)}{' '}
              <small>
                <code>{status.stopCode}</code>
              </small>
            </p>
          )}
          {!status.imagesEnabled && status.imageBlockCode && (
            <p role="status">
              {releaseReason(status.imageBlockCode)}{' '}
              <small>
                <code>{status.imageBlockCode}</code>
              </small>
            </p>
          )}
        </>
      ) : (
        <>
          <h2>{m(ownerMode ? 'ownerTitle' : 'title')}</h2>
          <p className={styles.note}>{m(ownerMode ? 'ownerIntro' : 'intro')}</p>
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
          {ownerMode && (
            <p className={styles.note}>
              {m('textRemaining')}: {money(generationRemaining(status, 'text'))} ·{' '}
              {m('imageRemaining')}: {money(generationRemaining(status, 'image'))}
            </p>
          )}
          <p>
            {m(
              expired
                ? 'expired'
                : status.state === 'active'
                  ? ownerMode
                    ? 'ownerActive'
                    : 'active'
                  : status.state === 'unclaimed'
                    ? ownerMode
                      ? 'ownerUnclaimed'
                      : 'unclaimed'
                    : ownerMode
                      ? 'ownerStopped'
                      : 'stopped',
            )}
          </p>
          {ownerMode ? (
            <p className={styles.note}>{m('ownerDuration')}</p>
          ) : status.expiresAt ? (
            <p className={styles.note}>
              {m('expiry')}: {new Date(status.expiresAt).toLocaleString(locale)}
            </p>
          ) : null}
          {status.pricingValidUntil && (
            <p className={styles.note}>
              {m('pricingExpiry')}: {new Date(status.pricingValidUntil).toLocaleString(locale)}
            </p>
          )}
          {!pricingCurrent && <p role="status">{m('pricingExpired')}</p>}
          <p className={styles.note}>{m('debit')}</p>
          <p className={styles.note}>
            {m('model')}: {status.text.model}
          </p>
          <p className={styles.note}>
            {m('historical')}: {status.priorHeldReservations}
          </p>
          <p className={styles.note}>
            {m(
              status.imagesEnabled
                ? 'imageAvailable'
                : ownerMode
                  ? 'imageUnavailable'
                  : 'imageBlocked',
            )}
          </p>
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
        </>
      )}
      <ErrorBox message={error || statusError ? `${m('failure')} (${error || statusError})` : ''} />
      {!releaseMode &&
        status.state === 'unclaimed' &&
        !expired &&
        pricingCurrent &&
        status.enabled && (
          <>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={claimConsent}
                onChange={(e) => setClaimConsent(e.target.checked)}
              />
              {m(ownerMode ? 'ownerClaimConsent' : 'claimConsent')}
            </label>
            <Button
              type="button"
              busy={busy}
              disabled={!claimConsent || !ownerClaimFingerprintCurrent(status)}
              onClick={() => void claim()}
            >
              {m(ownerMode ? 'ownerClaim' : 'claim')}
            </Button>
          </>
        )}
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setError('');
          void refresh();
        }}
      >
        {m('refresh')}
      </Button>
      {ownerMode && (
        <OwnerPolicyReview
          authorizationId={generationAuthorizationId(status)}
          onApplied={refresh}
        />
      )}
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
              {request.estimateSnapshot ? (
                <TextRequestReserve snapshot={request.estimateSnapshot} />
              ) : (
                <p>
                  {m('upper')}:{' '}
                  {typeof request.upperMicros === 'number'
                    ? money(request.upperMicros)
                    : m('reserveUnavailable')}
                  <br />
                  <small>{m('reserveLegacy')}</small>
                </p>
              )}
              {!liveRequestPolicyCurrent(request, status) && (
                <p role="status">{m('policyStale')}</p>
              )}
              {request.errorCode && (
                <p role="status">
                  <code>{request.errorCode}</code>
                </p>
              )}
              {request.permitState && (
                <p>{m(request.permitState === 'authorized' ? 'approved' : request.permitState)}</p>
              )}
              {uncertain.includes(request.id) && <p role="status">{m('unknown')}</p>}
              {campaignId && (
                <TextCountPreflight
                  key={`${request.id}:${request.policyHash}:${JSON.stringify(batch.turnFence)}`}
                  campaignId={campaignId}
                  request={request}
                  turnFence={batch.turnFence}
                  disabled={
                    busy ||
                    !active ||
                    !sameTurnFence(turnFence, batch.turnFence) ||
                    !liveRequestPolicyCurrent(request, status)
                  }
                  onChanged={async () => {
                    await requests();
                    await refresh();
                  }}
                />
              )}
              {!request.permitState && (
                <>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={!!consents[request.id]}
                      disabled={
                        busy ||
                        !active ||
                        !!request.errorCode ||
                        liveRequestConsentFence(request, status) === null ||
                        !liveRequestPolicyCurrent(request, status) ||
                        !sameTurnFence(turnFence, batch.turnFence)
                      }
                      onChange={(e) =>
                        setConsents((v) => ({ ...v, [request.id]: e.target.checked }))
                      }
                    />
                    {m(request.estimateSnapshot ? 'requestReserveConsent' : 'requestConsent')}
                    {request.automaticKnownCostPolicy === 'known-cost-v1' && (
                      <small data-known-text-cost-consent>{m('knownCostConsent')}</small>
                    )}
                  </label>
                  <Button
                    type="button"
                    busy={busy}
                    disabled={
                      !consents[request.id] ||
                      !!request.errorCode ||
                      !active ||
                      uncertain.includes(request.id) ||
                      liveRequestReserve(request) === null ||
                      liveRequestConsentFence(request, status) === null ||
                      (liveRequestReserve(request) ?? Infinity) >
                        generationRemaining(status, 'text') ||
                      !liveRequestPolicyCurrent(request, status) ||
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
      {status.remainingMicros <= 0 && <p>{m('noBudget')}</p>}
    </section>
  );
}
