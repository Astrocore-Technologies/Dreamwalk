'use client';
import { useEffect, useRef } from 'react';

/** Local admin-tool dialogs retain their trigger and cannot close during a mutation. */
export function useToolDialog(open: boolean, dismiss: () => void) {
  const launcher = useRef<HTMLElement | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (open || !launcher.current) return;
    const target = launcher.current;
    launcher.current = null;
    if (document.activeElement === document.body && target.isConnected)
      target.focus({ preventScroll: true });
  }, [open]);
  return {
    launcher,
    pending,
    capture: () => {
      launcher.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    close: () => {
      if (!pending.current) dismiss();
    },
  };
}
