'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/client';
import { ErrorBox } from '../ui';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { useStoryText, type StoryMessageKey } from './story-messages';

type WorldGenerationStatus = {
  ordinary?: { state: 'pending' | 'accepted' | 'blocked'; code: string | null } | null;
  available: boolean;
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
  const epoch = useRef(0);
  const polling = useRef(false);
  const path = `/game/campaigns/${campaignId}/world-generation`;
  const refresh = useCallback(async () => {
    if (access !== 'owner' || polling.current) return;
    polling.current = true;
    const stamp = epoch.current;
    try {
      const result = await api<WorldGenerationStatus>(path);
      if (stamp === epoch.current) {
        setStatus(result);
        setError('');
      }
    } catch (err) {
      if (stamp === epoch.current) {
        // Keep an uncertain consent mounted; a failed status read must not erase
        // its immutable retry operation or offer a fresh paid operation.
        setError(errorMessage(err));
      }
    } finally {
      polling.current = false;
    }
  }, [path, access]);
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
                  const requestIds = [...status.pendingLocationIds!];
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
          <p role="status">
            {status?.forecast?.estimatedSparkSubunits != null &&
            !error &&
            !membershipError &&
            !membershipPending
              ? h('worldCostForecast', {
                  amount: formatSparkSubunits(status.forecast.estimatedSparkSubunits, locale),
                })
              : h(error || status ? 'worldCostUnavailable' : 'worldCostCalculating')}
          </p>
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
    </div>
  );
}
