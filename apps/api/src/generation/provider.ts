import { digest } from '../ai/context';
import {
  ProviderFailure,
  type NpcProvider,
  type ProviderRequest,
  type AiPurpose,
} from '../ai/types';
import type { GenerationAuthority } from './service';
export class GenerationProvider implements NpcProvider {
  readonly external = true;
  readonly manualLive = true;
  readonly id: string;
  readonly version: string;
  constructor(
    private inner: NpcProvider,
    readonly session: GenerationAuthority,
  ) {
    this.id = inner.id;
    this.version = `${inner.version}:generation-${session.mode}-v1`;
    if (session.ownerConfig?.text.estimation) {
      session.configureTextRequestPlanner((purpose, context) => {
        const prepared = this.inner.prepareTextRequest?.(purpose, context);
        if (!prepared) throw new ProviderFailure('GENERATION_TEXT_PLANNER_REQUIRED', false);
        return prepared.snapshot;
      });
    }
  }
  prepareTextRequest(purpose: AiPurpose, context: unknown) {
    return this.inner.prepareTextRequest?.(purpose, context);
  }
  contextWindow() {
    return this.inner.contextWindow?.();
  }
  contextFits(purpose: AiPurpose, context: unknown) {
    return this.inner.contextFits?.(purpose, context) ?? true;
  }
  contextBudgetBytes(max: number) {
    return this.inner.contextBudgetBytes?.(max) ?? 32000;
  }
  requestAuthorized(id: string, context?: unknown) {
    return this.session.requestAuthorized(id, context);
  }
  canDispatchJob(id: string) {
    return this.session.canDispatchJob(id);
  }
  async generate(request: ProviderRequest) {
    const prepared = this.inner.prepareTextRequest?.(request.purpose, request.context);
    if (
      prepared &&
      (!request.textReservationSnapshot ||
        digest(request.textReservationSnapshot) !== digest(prepared.snapshot))
    )
      throw new ProviderFailure('PROVIDER_REQUEST_SNAPSHOT_CHANGED', false);
    let permit: string;
    try {
      permit = await this.session.begin(request, prepared?.snapshot);
    } catch {
      throw new ProviderFailure('MANUAL_LIVE_NOT_AUTHORIZED', false);
    }
    try {
      const result = await this.inner.generate(
        prepared
          ? {
              ...request,
              textReservationSnapshot: prepared.snapshot,
              maxCostMicros: prepared.snapshot.reserveMicros,
            }
          : request,
      );
      await this.session.complete(
        permit,
        result.usage.costMicros,
        result.failureCode ?? 'PROVIDER_RESULT',
        result.requestId,
      );
      return result;
    } catch (error) {
      const known = error instanceof ProviderFailure && !error.uncertain;
      await this.session.complete(
        permit,
        known ? 0 : null,
        error instanceof ProviderFailure ? error.code : 'PROVIDER_OUTCOME_UNKNOWN',
        error instanceof ProviderFailure ? error.requestId : undefined,
      );
      throw error;
    }
  }
}
