import { ProviderFailure, type NpcProvider, type ProviderRequest } from '../ai/types';
import type { LiveTestService } from './service';
export class ManualLiveProvider implements NpcProvider {
  readonly external = true;
  readonly manualLive = true;
  readonly id: string;
  readonly version: string;
  constructor(
    private inner: NpcProvider,
    readonly session: LiveTestService,
  ) {
    this.id = inner.id;
    this.version = `${inner.version}:manual-live-v1`;
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
    let permit: string;
    try {
      permit = await this.session.begin(request);
    } catch {
      throw new ProviderFailure('MANUAL_LIVE_NOT_AUTHORIZED', false);
    }
    try {
      const result = await this.inner.generate(request);
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
