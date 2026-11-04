'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/client';
import { ErrorBox } from '../ui';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { useStoryText } from './story-messages';

type WorldGenerationStatus = {
  available: boolean;
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
  const { locale } = useT();
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
  return (
    <div data-testid="world-generation-confirmation">
      <ErrorBox message={membershipError ? h('worldMembersError') : error} />
      {membershipPending && <p role="status">{h('worldCheckingOwner')}</p>}
      {status?.pending || status?.unknown ? (
        <p role="status">{h(status.unknown ? 'worldCostUnresolved' : 'worldPending')}</p>
      ) : status?.available && phase === 'world' ? (
        <StoryReplyConfirmation
          campaignId={campaignId}
          turnId="world"
          endpoint={path}
          worldBatch
          scope={scope}
          disabled={disabled || !!error || membershipError || membershipPending}
          onChanged={refresh}
        />
      ) : phase !== 'world' ? (
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
          <small>{h('worldCostForecastHint')}</small>
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
