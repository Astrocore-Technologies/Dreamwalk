import { digest } from '../ai/context';
import {
  ProviderFailure,
  type AiPurpose,
  type NpcProvider,
  type ProviderRequest,
} from '../ai/types';
import type { GenerationAuthority } from './service';
import { GenerationProvider } from './provider';
/** Ordinary quote/consent dispatch. System work still requires a separately consented permit. */
export class ReleaseGenerationProvider implements NpcProvider {
  readonly external = true;
  // Runtime system decisions wait for explicit request consent; ordinary user quotes do not.
  readonly manualLive = true;
  readonly id: string;
  readonly version: string;
  private readonly permitted: GenerationProvider;
  constructor(
    private readonly inner: NpcProvider,
    readonly session: GenerationAuthority,
  ) {
    if (!session.release) throw new Error('RELEASE_CONFIGURATION_REQUIRED');
    this.id = `release:${inner.id}`;
    this.version = `${inner.version}:release-v1`;
    this.permitted = new GenerationProvider(inner, session);
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
  private async nativeJob(id: string, running = false) {
    return this.session.db.tx(async (c) => {
      const row = (
        await c.query(
          `SELECT j.*,a.owner_id AS authorization_owner_id,a.scope_id AS authorization_scope_id,r.status AS shared_status,r.spark_quote_id,r.actor_id AS generation_actor_id,r.scope_id AS generation_scope_id,h.owner_id AS hold_owner_id,h.status AS spark_status,w.enabled AS wallet_enabled
        FROM npc_ai_jobs j LEFT JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id
        LEFT JOIN live_test_sessions a ON a.id=j.generation_authorization_id
        LEFT JOIN spark_holds h ON h.id=j.spark_hold_id LEFT JOIN spark_wallets w ON w.owner_id=j.payer_user_id WHERE j.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row?.spark_hold_id) return null;
      if (
        row.provider_id !== this.id ||
        row.provider_version !== this.version ||
        row.cancel_requested ||
        !['reserved', 'running'].includes(row.status) ||
        (running && row.status !== 'running') ||
        row.shared_status !== 'held' ||
        row.spark_status !== 'held' ||
        row.wallet_enabled !== true ||
        row.spark_quote_id !== row.spark_hold_id ||
        row.generation_actor_id !== row.payer_user_id ||
        row.authorization_owner_id !== row.payer_user_id ||
        row.authorization_scope_id !== row.generation_scope_id ||
        row.hold_owner_id !== row.payer_user_id ||
        row.generation_scope_id !== `release:${row.payer_user_id}` ||
        !row.generation_authorization_id ||
        !row.payer_user_id ||
        row.payer_user_id !== row.requester_user_id
      )
        throw new ProviderFailure('RELEASE_REQUEST_NOT_AUTHORIZED', false);
      await this.session.release!.active(c, row.generation_authorization_id);
      return row;
    });
  }
  async canDispatchJob(id: string) {
    try {
      return !!(await this.nativeJob(id)) || (await this.session.canDispatchJob(id));
    } catch {
      return false;
    }
  }
  async generate(request: ProviderRequest) {
    const job = await this.nativeJob(request.jobId, true);
    if (!job) return this.permitted.generate(request);
    const prepared = this.inner.prepareTextRequest?.(request.purpose, request.context);
    if (
      !prepared ||
      !request.textReservationSnapshot ||
      digest(prepared.snapshot) !== digest(request.textReservationSnapshot) ||
      digest(job.request_snapshot) !== digest(prepared.snapshot) ||
      digest(job.context) !== digest(request.context) ||
      Number(job.provider_upper_micros) !== prepared.snapshot.reserveMicros
    )
      throw new ProviderFailure('PROVIDER_REQUEST_SNAPSHOT_CHANGED', false);
    await this.session.assertCountEvidence(request.context);
    return this.inner.generate({
      ...request,
      textReservationSnapshot: prepared.snapshot,
      maxCostMicros: prepared.snapshot.reserveMicros,
    });
  }
}
