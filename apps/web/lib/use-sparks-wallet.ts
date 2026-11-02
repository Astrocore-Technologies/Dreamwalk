'use client';
import { useEffect, useState } from 'react';
import { api } from './client';
import { readSparksWallet, SPARKS_REFRESH_EVENT, type SparksWallet } from './sparks-wallet';

export function useSparksWallet(ownerId: string | undefined) {
  const [state, setState] = useState<{
    ownerId: string;
    data?: SparksWallet;
    unavailable?: boolean;
  }>();
  useEffect(() => {
    if (!ownerId) return;
    let active = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const data = readSparksWallet(await api<unknown>('/sparks/wallet'), ownerId);
        if (active && request === sequence) setState({ ownerId, data });
      } catch {
        if (active && request === sequence) setState({ ownerId, unavailable: true });
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    };
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    void refresh();
    // Async generation settles after the original mutation response; also catch other-tab credits.
    const interval = setInterval(visibleRefresh, 15000);
    window.addEventListener(SPARKS_REFRESH_EVENT, schedule);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener(SPARKS_REFRESH_EVENT, schedule);
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [ownerId]);
  const reload = () => window.dispatchEvent(new Event(SPARKS_REFRESH_EVENT));
  // Never render a previous account's balance, including the frame before effect cleanup.
  return ownerId && state?.ownerId === ownerId
    ? { data: state.data, unavailable: !!state.unavailable, loading: false, reload }
    : { data: undefined, unavailable: false, loading: !!ownerId, reload };
}
