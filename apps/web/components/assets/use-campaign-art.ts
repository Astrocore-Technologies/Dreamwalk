'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { artPreviewUrl } from './types';
export type VisibleArtBinding = {
  slot: string;
  revisionId: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  url: string;
  attribution: string;
  licenseLabel: string;
};
/** Only the audience-filtered campaign endpoint. Never load an author's full manifest. */
export function useCampaignArt(campaignId: string, mapId: string) {
  const [art, setArt] = useState<VisibleArtBinding[]>([]);
  useEffect(() => {
    let active = true,
      pending = false;
    setArt([]);
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ bindings: VisibleArtBinding[] }>(
          `/asset-library/campaigns/${campaignId}/manifest`,
        );
        if (active) setArt(result.bindings.filter((entry) => !!artPreviewUrl(entry.url)));
      } catch {
        // Withdrawal, takedown or lost campaign authorization must not retain stale visible art.
        if (active) setArt([]);
      } finally {
        pending = false;
      }
    }
    if (!mapId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [campaignId, mapId]);
  return art;
}
