'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/client';
import { ErrorBox } from '../ui';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { useStoryText, type StoryMessageKey } from './story-messages';

type WorldGenerationStatus = {
  ordinary?: { state: 'pending' | 'accepted' | 'blocked'; code: string | null } | null;
  available: boolean;
  generatedLocationImages?: number;
  estimateRiskConsentRequired?: boolean;
  pending: boolean;
  unknown?: boolean;
  reason?: string;
};

/**
 * Generation for the world turn carries no prices or buttons: the player's own action is the
 * consent. A new location is quoted and confirmed here in the background; the player only sees
 * a reason when something blocks it (for example, not enough Sparks) or an uncertain outcome.
 */
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
  const { t } = useT();
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
      // Keep an uncertain consent mounted; a failed status read must not erase its retry.
      if (stamp === epoch.current) setError(errorMessage(err));
    } finally {
      polling.current = false;
    }
  }, [path, access]);
  useEffect(() => {
    epoch.current++;
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
  if (access !== 'owner')
    return access === 'error' ? <ErrorBox message={h('worldMembersError')} /> : null;
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
      ? t('Не хватает Искр')
      : h(blockedCopy[blockedCode || ''] || 'worldGenerationBlocked');
  const locationConsent =
    status?.available &&
    !status.pending &&
    !status.unknown &&
    phase === 'world' &&
    ((status.generatedLocationImages ?? 0) > 0 ||
      status.estimateRiskConsentRequired ||
      blockedCode === 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
  return (
    <div data-testid="world-generation-confirmation">
      <ErrorBox message={membershipError ? h('worldMembersError') : error} />
      {status?.unknown ? (
        <p role="status">{h('worldCostUnresolved')}</p>
      ) : locationConsent ? (
        <StoryReplyConfirmation
          campaignId={campaignId}
          turnId="world"
          endpoint={path}
          worldBatch
          autoConfirm
          quiet
          scope={scope}
          disabled={disabled || !!error || membershipError || membershipPending}
          onChanged={refresh}
        />
      ) : (
        status?.ordinary?.state === 'blocked' && <ErrorBox message={blockedMessage} />
      )}
    </div>
  );
}
