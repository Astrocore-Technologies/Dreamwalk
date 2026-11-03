'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { artPreviewUrl } from './types';
import type { ImageFraming } from '@dreamwalk/contracts';
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
  imageFraming?: ImageFraming;
};
export type SceneIllustration = VisibleArtBinding & { mapId: string };
/** Only the audience-filtered campaign endpoint. Never load an author's full manifest. */
export function useCampaignArt(campaignId: string, mapId: string) {
  const [result, setResult] = useState<{
    campaignId: string;
    mapId: string;
    art: VisibleArtBinding[];
    illustration: SceneIllustration | null;
  }>({ campaignId, mapId, art: [], illustration: null });
  useEffect(() => {
    let active = true,
      pending = false;
    setResult({ campaignId, mapId, art: [], illustration: null });
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await api<{
          bindings: VisibleArtBinding[];
          sceneIllustration?: SceneIllustration | null;
        }>(`/asset-library/campaigns/${campaignId}/manifest`);
        if (active)
          setResult({
            campaignId,
            mapId,
            art: response.bindings.filter((entry) => !!artPreviewUrl(entry.url)),
            illustration:
              response.sceneIllustration?.mapId === mapId &&
              response.sceneIllustration.slot === `map:${mapId}:background` &&
              artPreviewUrl(response.sceneIllustration.url)
                ? response.sceneIllustration
                : null,
          });
      } catch {
        // Withdrawal, takedown or lost campaign authorization must not retain stale visible art.
        if (active) setResult({ campaignId, mapId, art: [], illustration: null });
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
  return result.mapId === mapId && result.campaignId === campaignId
    ? result
    : { campaignId, mapId, art: [], illustration: null };
}
