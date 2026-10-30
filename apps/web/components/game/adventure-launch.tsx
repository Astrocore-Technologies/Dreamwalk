'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Adventure } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '@/components/ui';
export function AdventureLaunch({ adventure }: { adventure: Adventure }) {
  const { t } = useT();
  const router = useRouter();
  const { user } = useClient();
  const privateAccess =
    adventure.visibility === 'private' && ['owner', 'invited'].includes(adventure.access || '');
  const versions = useResource<{
    versions: {
      id: string;
      sourceRevision: number;
      audience: string;
      approved: boolean;
      createdAt: string;
    }[];
  }>(user && privateAccess ? `/game/adventures/${adventure.id}/playable-versions` : null);
  const versionId = privateAccess
    ? versions.data?.versions.find((version) => version.audience === 'private')?.id
    : adventure.playableVersionId;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function launch() {
    if (!user) {
      router.push('/auth/sign-in');
      return;
    }
    if (!versionId || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ campaignId: string }>('/game/campaigns', {
        method: 'POST',
        body: JSON.stringify({ playableVersionId: versionId }),
      });
      router.push(`/game/${result.campaignId}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        disabled={!versionId || versions.loading}
        busy={busy}
        onClick={() => void launch()}
      >
        {t('Начать прохождение')}
      </Button>
      <small>
        {t(
          versionId
            ? 'Прохождение закрепляется за проверенной игровой версией. Новые правки автора его не изменят.'
            : 'У этой истории пока нет доступной игровой версии.',
        )}
      </small>
      <ErrorBox message={error || versions.error} />
    </>
  );
}
