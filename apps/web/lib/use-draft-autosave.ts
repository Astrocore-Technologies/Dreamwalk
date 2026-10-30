'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DraftSaveController, type DraftSaveState } from './draft-save-controller';
export function useDraftAutosave<T, R>(options: {
  enabled: boolean;
  identity: string;
  draft: T;
  baseline: T;
  revision: number;
  initialResult: R;
  validate: (value: T) => boolean;
  persist: (value: T, revision: number) => Promise<{ revision: number; result: R }>;
  onAcknowledged?: (result: R, stillDirty: boolean) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const saver = useRef<DraftSaveController<T, R> | null>(null);
  const [state, setState] = useState<DraftSaveState>({
    status: 'saved',
    dirty: false,
    revision: options.revision,
  });
  useEffect(() => {
    if (!options.enabled) return;
    const initial = latest.current;
    const controller = new DraftSaveController<T, R>({
      initial: initial.baseline,
      revision: initial.revision,
      initialResult: initial.initialResult,
      validate: (value) => latest.current.validate(value),
      persist: (value, revision) => latest.current.persist(value, revision),
      changed: setState,
      acknowledged: (result, dirty) => latest.current.onAcknowledged?.(result, dirty),
    });
    saver.current = controller;
    setState(controller.state);
    controller.update(initial.draft);
    return () => {
      controller.dispose();
      if (saver.current === controller) saver.current = null;
    };
  }, [options.enabled, options.identity]);
  useEffect(() => {
    if (options.enabled) saver.current?.update(options.draft);
  }, [options.enabled, options.draft]);
  const flush = useCallback(async () => {
    const controller = saver.current;
    if (!controller) throw new Error('SAVE_NOT_READY');
    // Include synchronous input changes before React's draft synchronization effect.
    controller.update(latest.current.draft);
    return controller.flush();
  }, []);
  return { ...state, flush };
}
