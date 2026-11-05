'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatSparkSubunits,
  type AutonomousSpeechReceipt,
  type AutonomousSpeechSkip,
} from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/client';
import { ErrorBox } from '../ui';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { useStoryText, type StoryMessageKey } from './story-messages';

type WorldGenerationStatus = {
  ordinary?: { state: 'pending' | 'accepted' | 'blocked'; code: string | null } | null;
  available: boolean;
  speechReceipts?: AutonomousSpeechReceipt[];
  speechReceiptNext?: string;
  speechSkips?: AutonomousSpeechSkip[];
  generatedLocationImages?: number;
  pendingLocationIds?: string[];
  estimateRiskConsentRequired?: boolean;
  pending: boolean;
  unknown?: boolean;
  reason?: string;
  forecast?: {
    estimatedSparkSubunits: string | null;
    estimatedTotalMicros: number | null;
    requestCount: number;
    optionalAutonomousSpeechRequests?: number;
    optionalAutonomousSpeechSparkSubunits?: string | null;
    baseEstimatedSparkSubunits?: string | null;
    basis: 'local_round_forecast';
    includesMapAnalysis: false;
    finalQuoteRequired: true;
    unavailableReason?: string;
  } | null;
};

/** One world batch covers pending decisions and replies; legacy composer-covered jobs stay excluded. */
export function WorldGenerationConfirmation({
  campaignId,
  scope,
  disabled,
  access = 'owner',
  membershipError = false,
  membershipPending = false,
  phase = 'world',
}: {
  campaignId: string;
  scope: string;
  disabled: boolean;
  access?: 'owner' | 'member' | 'loading' | 'error';
  membershipError?: boolean;
  membershipPending?: boolean;
  phase?: string;
}) {
  const h = useStoryText();
  const { locale, t } = useT();
  const [status, setStatus] = useState<WorldGenerationStatus | null>(null);
  const [error, setError] = useState('');
  const [receiptBefore, setReceiptBefore] = useState<string>();
  const receiptKey = `${campaignId}:${access}:${receiptBefore ?? ''}`;
  const currentReceiptKey = useRef(receiptKey);
  currentReceiptKey.current = receiptKey;
  const [receiptPage, setReceiptPage] = useState<{
    key: string;
    items: AutonomousSpeechReceipt[];
    skips: AutonomousSpeechSkip[];
    next?: string;
  } | null>(null);
  const visibleReceipts =
    access === 'owner' && receiptPage?.key === receiptKey ? receiptPage : null;
  const epoch = useRef(0);
  const polling = useRef(false);
  const path = `/game/campaigns/${campaignId}/world-generation`;
  const refresh = useCallback(async () => {
    if (access !== 'owner' || polling.current) return;
    polling.current = true;
    const stamp = epoch.current;
    try {
      const result = await api<WorldGenerationStatus>(
        receiptBefore ? `${path}?speechReceiptBefore=${encodeURIComponent(receiptBefore)}` : path,
      );
      if (stamp === epoch.current && currentReceiptKey.current === receiptKey) {
        setStatus(result);
        setReceiptPage({
          key: receiptKey,
          items: result.speechReceipts ?? [],
          skips: result.speechSkips ?? [],
          next: result.speechReceiptNext,
        });
        setError('');
      }
    } catch (err) {
      if (stamp === epoch.current && currentReceiptKey.current === receiptKey) {
        // Keep an uncertain consent mounted; a failed status read must not erase
        // its immutable retry operation or offer a fresh paid operation.
        setError(errorMessage(err));
      }
    } finally {
      polling.current = false;
    }
  }, [path, access, receiptBefore, receiptKey]);
  useEffect(() => {
    setReceiptBefore(undefined);
  }, [campaignId, access]);
  useEffect(() => {
    epoch.current++;
    // Keep the existing confirmation mounted across scope refreshes: it owns
    // the immutable operation for a consent whose response may have been lost.
    setStatus((previous) => (previous?.unknown || previous?.available ? previous : null));
    if (access !== 'owner') return;
    void refresh();
    const timer = setInterval(
      () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible')
          void refresh();
      },
      phase === 'world' ? 2000 : 5000,
    );
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh, scope, access, phase]);
  if (access !== 'owner' && phase !== 'world') return null;
  if (access !== 'owner')
    return access === 'error' ? (
      <ErrorBox message={h('worldMembersError')} />
    ) : (
      <p role="status">{h(access === 'loading' ? 'worldCheckingOwner' : 'worldOwnerReview')}</p>
    );
  const blockedCode = status?.ordinary?.code;
  const blockedCopy: Record<string, StoryMessageKey> = {
    GENERATION_UNAVAILABLE: 'worldGenerationUnavailable',
    LIVE_REQUEST_UNAVAILABLE: 'worldProviderUnavailable',
    PROVIDER_UNAVAILABLE: 'worldProviderUnavailable',
    PROVIDER_ERROR: 'worldProviderUnavailable',
    PROVIDER_BUDGET_EXCEEDED: 'worldProviderBudget',
    SPONSOR_BUDGET_EXCEEDED: 'worldProviderBudget',
    BUDGET_EXCEEDED: 'worldProviderBudget',
    CONTEXT_BUDGET_EXCEEDED: 'worldContextBudget',
    SPARK_PRICE_UNVERIFIED: 'worldPriceUnverified',
    SPARK_WALLET_NOT_ENABLED: 'worldWalletUnavailable',
  };
  const blockedMessage =
    blockedCode === 'INSUFFICIENT_SPARKS'
      ? t('Недостаточно искр для этой операции.')
      : h(blockedCopy[blockedCode || ''] || 'worldGenerationBlocked');
  return (
    <div data-testid="world-generation-confirmation">
      <ErrorBox message={membershipError ? h('worldMembersError') : error} />
      {membershipPending && <p role="status">{h('worldCheckingOwner')}</p>}
      {status?.unknown ? (
        <p role="status">{h('worldCostUnresolved')}</p>
      ) : status?.pending ? (
        <p role="status">{h('worldPending')}</p>
      ) : status?.available &&
        phase === 'world' &&
        ((status.generatedLocationImages ?? 0) > 0 ||
          status.estimateRiskConsentRequired ||
          blockedCode === 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED') ? (
        <StoryReplyConfirmation
          campaignId={campaignId}
          turnId="world"
          endpoint={path}
          worldBatch
          scope={scope}
          disabled={disabled || !!error || membershipError || membershipPending}
          onChanged={refresh}
          onDecline={
            status.pendingLocationIds?.length
              ? async () => {
                  const requestIds = status.pendingLocationIds!;
                  await api(`${path}/decline`, {
                    method: 'POST',
                    body: JSON.stringify({ requestIds }),
                  });
                  await refresh();
                }
              : undefined
          }
        />
      ) : status?.ordinary?.state === 'blocked' ? (
        <ErrorBox message={blockedMessage} />
      ) : status?.ordinary?.state === 'pending' ? (
        <p role="status">{h('worldPending')}</p>
      ) : phase !== 'world' || status?.available ? (
        <div data-testid="world-cost-forecast">
          <p>{h('worldCostForecastHint')}</p>
          <p role="status">
            {status?.forecast?.estimatedSparkSubunits != null &&
            !error &&
            !membershipError &&
            !membershipPending
              ? h('worldCostForecast', {
                  amount: formatSparkSubunits(
                    status.forecast.baseEstimatedSparkSubunits ??
                      status.forecast.estimatedSparkSubunits,
                    locale,
                  ),
                })
              : h(error || status ? 'worldCostUnavailable' : 'worldCostCalculating')}
          </p>
          {!!status?.forecast?.optionalAutonomousSpeechRequests &&
            status.forecast.optionalAutonomousSpeechSparkSubunits != null && (
              <p>
                {h('worldOptionalSpeechForecast', {
                  amount: formatSparkSubunits(
                    status.forecast.optionalAutonomousSpeechSparkSubunits,
                    locale,
                  ),
                  count: status.forecast.optionalAutonomousSpeechRequests,
                })}
              </p>
            )}
        </div>
      ) : (
        <p role="status">
          {h(
            !status
              ? 'worldCheckingStatus'
              : status.reason === 'manual_authorization_required'
                ? 'worldManualAuthorization'
                : status.reason === 'no_pending_generation'
                  ? 'worldNoPendingGeneration'
                  : 'worldGenerationUnavailable',
          )}
        </p>
      )}
      {!!visibleReceipts?.skips.length && (
        <section aria-label={h('worldSpeechSkips')}>
          <h3>{h('worldSpeechSkips')}</h3>
          <ul>
            {visibleReceipts.skips.map((skip) => (
              <li key={skip.id}>
                <time dateTime={skip.createdAt}>
                  {new Date(skip.createdAt).toLocaleString(locale)}
                </time>
                <p>
                  {h(
                    skip.reason === 'allowance_exhausted'
                      ? 'worldSpeechSkipExhausted'
                      : skip.reason === 'legacy_uncovered'
                        ? 'worldSpeechSkipLegacy'
                        : 'worldSpeechSkipUnavailable',
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(!!visibleReceipts?.items.length || receiptBefore) && (
        <section aria-label={h('worldSpeechReceipts')} data-testid="world-speech-receipts">
          <h3>{h('worldSpeechReceipts')}</h3>
          <p>{h('worldSpeechReceiptHistory')}</p>
          <ul>
            {visibleReceipts?.items.map((receipt) => (
              <li key={receipt.id}>
                <time dateTime={receipt.createdAt}>
                  {new Date(receipt.createdAt).toLocaleString(locale)}
                </time>
                <strong>
                  {h(
                    receipt.outcome === 'delivered'
                      ? 'worldSpeechDelivered'
                      : receipt.outcome === 'silent'
                        ? 'worldSpeechSilent'
                        : receipt.outcome === 'failed'
                          ? 'worldSpeechFailed'
                          : 'worldSpeechPending',
                  )}
                </strong>
                <p>
                  {h(
                    receipt.status === 'unknown'
                      ? 'worldSpeechReceiptUnknown'
                      : receipt.capturedSubunits !== null
                        ? 'worldSpeechReceiptCharged'
                        : 'worldSpeechReceiptHeld',
                    {
                      amount: formatSparkSubunits(
                        receipt.capturedSubunits ?? receipt.reservedSubunits,
                        locale,
                      ),
                    },
                  )}
                </p>
                {receipt.capturedSubunits !== null && (
                  <small>
                    {h('worldSpeechReceiptFunding', {
                      dreams: formatSparkSubunits(
                        receipt.funding.dreamsCapturedSubunits ?? '0',
                        locale,
                      ),
                      sparks: formatSparkSubunits(
                        receipt.funding.sparksCapturedSubunits ?? '0',
                        locale,
                      ),
                    })}
                  </small>
                )}
              </li>
            ))}
          </ul>
          {receiptBefore && (
            <button type="button" onClick={() => setReceiptBefore(undefined)}>
              {h('worldSpeechNewest')}
            </button>
          )}
          {visibleReceipts?.next && (
            <button type="button" onClick={() => setReceiptBefore(visibleReceipts.next)}>
              {h('worldSpeechOlder')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
