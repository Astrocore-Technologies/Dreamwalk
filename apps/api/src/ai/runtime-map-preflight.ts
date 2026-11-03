import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { GameState } from '@dreamwalk/contracts';
import type { AiScope, DecisionContext } from './types';
import { bodyHash } from './text-preflight';
import { digest } from './context';

/** Idle clock ticks are not changed pixels or private context. Keep every nested
 * revision and memory field; the full state hash still fences replay/recount. */
export function runtimeMapAdmissionStateHash(state: GameState | undefined, fallback: string) {
  return digest(state ? { ...state, tick: 0, revision: 0 } : fallback);
}

/** Internal control flow only. The quote transaction and campaign queue must unwind
 * before the explicit quote request may send an image to the counting endpoint. */
export class RuntimeMapCountRequired extends Error {
  readonly bodySha256: string;
  scope?: AiScope;
  context?: DecisionContext;
  stateHash?: string;
  admissionStateHash?: string;
  durableRevision?: number;
  constructor(
    body: string,
    readonly model: string,
    readonly providerVersion: string,
    readonly count: (operationId: string) => Promise<number>,
    readonly accept: (inputTokens: number, expiresAt?: number) => void,
  ) {
    super('RUNTIME_MAP_EXACT_COUNT_REQUIRED');
    this.bodySha256 = bodyHash(body);
    // Neither JSON logging nor error responses may serialize the private prompt/image.
    for (const key of ['scope', 'context'])
      Object.defineProperty(this, key, { value: undefined, writable: true, enumerable: false });
  }
}
const quoteScope = new AsyncLocalStorage<Map<string, string>>();
export function runtimeQuoteIdentity(key: string): string {
  const scope = quoteScope.getStore();
  if (!scope) return randomUUID();
  let id = scope.get(key);
  if (!id) scope.set(key, (id = randomUUID()));
  return id;
}
export async function withRuntimeMapPreflight<T>(
  work: () => Promise<T>,
  resolve: (request: RuntimeMapCountRequired) => Promise<void>,
) {
  return quoteScope.run(new Map(), async () => {
    const seen = new Set<string>();
    let stateHash: string | undefined;
    for (;;) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof RuntimeMapCountRequired) || !error.scope || !error.context)
          throw error;
        if (stateHash !== undefined && error.stateHash !== stateHash)
          throw new Error('RUNTIME_MAP_QUOTE_CHANGED');
        stateHash = error.stateHash;
        const key = `${error.providerVersion}:${error.bodySha256}`;
        // A quote may contain several distinct NPC replies, never retry the same
        // provider operation or search the network repeatedly for a fitting history.
        if (seen.has(key) || seen.size >= 16) throw new Error('RUNTIME_MAP_QUOTE_CHANGED');
        seen.add(key);
        await resolve(error);
      }
    }
  });
}
