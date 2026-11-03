'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { ErrorBox } from '../ui';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { useStoryText } from './story-messages';

/** Only separate, unquoted world work appears here; composer-covered replies are excluded by server. */
export function WorldGenerationConfirmation({
  campaignId,
  scope,
  disabled,
  access = 'owner',
  membershipError = false,
  membershipPending = false,
}: {
  campaignId: string;
  scope: string;
  disabled: boolean;
  access?: 'owner' | 'member' | 'loading' | 'error';
  membershipError?: boolean;
  membershipPending?: boolean;
}) {
  const h = useStoryText();
  const [status, setStatus] = useState<{
    available: boolean;
    pending: boolean;
    unknown?: boolean;
    reason?: string;
  } | null>(null);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const polling = useRef(false);
  const path = `/game/campaigns/${campaignId}/world-generation`;
  const refresh = useCallback(async () => {
    if (access !== 'owner' || polling.current) return;
    polling.current = true;
    const stamp = epoch.current;
    try {
      const result = await api<{
        available: boolean;
        pending: boolean;
        unknown?: boolean;
        reason?: string;
      }>(path);
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
    setStatus(null);
    if (access !== 'owner') return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh, scope, access]);
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
      {status?.pending ? (
        <p role="status">{h(status.unknown ? 'unknown' : 'worldPending')}</p>
      ) : status?.available ? (
        <StoryReplyConfirmation
          campaignId={campaignId}
          turnId="world"
          endpoint={path}
          worldBatch
          scope={scope}
          disabled={disabled || membershipError || membershipPending}
          onChanged={refresh}
        />
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
