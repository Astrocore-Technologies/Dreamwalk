'use client';
import { useEffect, useRef } from 'react';
import { LaunchGate } from '../home/launch-gate';
/** Synchronous duplicate guard; stale/unmounted responses cannot navigate. */
export function useLaunchGate(selection: string) {
  const gate = useRef(new LaunchGate());
  gate.current.select(selection);
  useEffect(() => {
    const current = gate.current;
    current.activate();
    return () => current.dispose();
  }, []);
  return gate.current;
}
