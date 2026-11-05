import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { PoolClient, QueryResultRow as Row } from 'pg';
import { Db } from '../db';
import { digest } from '../ai/context';
import {
  ownerPricingIsCurrent,
  readGenerationConfig,
  type ConfiguredGenerationConfig,
} from './config';
import { currentReleaseDeployment } from './release-deployment';
import { fenceGenerationAdmission } from './scope-fence';
import { proveTerminalScopeLiabilities } from './terminal-liability-proof';

const blocked = (code: string) => ({ recovered: false as const, code });
const permittedReasons = new Set([
  'IMAGE_RESULT_UNKNOWN',
  'PROVIDER_OUTCOME_UNKNOWN',
  'TEXT_COUNT_OUTCOME_UNKNOWN',
  'REQUEST_TIMEOUT',
  'REQUEST_DEADLINE_EXCEEDED',
  'JOB_CANCELLED_UNKNOWN',
]);

/** An epoch is eligible only from a proven clean baseline, and every assignment
 * must belong to the same current owner/policy and an exact verified native source. */
export function recoverableStopEpoch(
  epoch: Row | undefined,
  events: Row[],
  kind: 'scope' | 'authorization',
  targetId: string,
  authorization: Row,
) {
  if (
    !epoch ||
    epoch.baseline_unknown !== false ||
    epoch.target_kind !== kind ||
    epoch.target_id !== targetId ||
    !events.length
  )
    return false;
  return events.every(
    (e) =>
      String(e.epoch_id) === String(epoch.id) &&
      e.recoverable === true &&
      e.stop_class === 'request' &&
      permittedReasons.has(e.reason) &&
      e.authorization_id === authorization.id &&
      e.scope_id === authorization.scope_id &&
      e.policy_revision === authorization.policy_revision &&
      e.policy_hash === authorization.policy_hash &&
      e.config_hash === authorization.config_hash &&
      ['image', 'count', 'permit', 'authoring', 'npc'].includes(e.source_kind) &&
      typeof e.source_id === 'string',
  );
}

/** Separate transaction from source settlement. No admission, settlement, provider
 * call, retry, cap update or policy refresh. No foreign authorization/scope locks. */
export async function recoverVerifiedGenerationAccessTx(
  c: PoolClient,
  scopeId: string,
  config: ConfiguredGenerationConfig,
) {
  await c.query("SET LOCAL lock_timeout='100ms'");
  await c.query("SET LOCAL statement_timeout='2000ms'");
  const authorizations = (
    await c.query(
      'SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR NO KEY UPDATE',
      [scopeId],
    )
  ).rows;
  const scope = (
    await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [scopeId])
  ).rows[0];
  if (!scope?.blocked || !scope.stop_epoch_id) return blocked('NO_FUTURE_BLOCK_EPOCH');
  await fenceGenerationAdmission(c);
  const ids = (
    await c.query('SELECT id FROM live_test_sessions WHERE scope_id=$1 ORDER BY id', [scopeId])
  ).rows;
  if (digest(ids.map((row) => row.id)) !== digest(authorizations.map((row) => row.id)))
    return blocked('AUTHORIZATION_SET_CHANGED');
  const current = authorizations.filter((a) => a.mode !== 'manual');
  if (current.length !== 1) return blocked('AUTHORIZATION_SCOPE_AMBIGUOUS');
  const a = current[0];
  if (
    a.mode !== config.mode ||
    a.state !== 'stopped' ||
    !permittedReasons.has(a.stop_code) ||
    !a.stop_epoch_id ||
    !scope.approved ||
    a.expires_at !== null ||
    authorizations.some(
      (other) =>
        other.id !== a.id &&
        (other.owner_id !== a.owner_id ||
          other.mode !== 'manual' ||
          other.state !== 'stopped' ||
          other.stop_code !== 'OWNER_GENERATION_MODE_ACTIVE'),
    )
  )
    return blocked('AUTHORIZATION_STOP_OR_OWNERSHIP_MISMATCH');
  // A retained migrated manual grant is inert only while it has no later veto.
  for (const manual of authorizations.filter((other) => other.id !== a.id)) {
    if (manual.stop_epoch_id == null) continue;
    const epoch = (
      await c.query('SELECT * FROM generation_stop_epochs WHERE id=$1', [manual.stop_epoch_id])
    ).rows[0];
    const events = (
      await c.query(
        'SELECT * FROM generation_stop_events WHERE epoch_id=$1 ORDER BY id LIMIT 501',
        [manual.stop_epoch_id],
      )
    ).rows;
    if (
      !epoch ||
      epoch.baseline_unknown !== false ||
      epoch.target_kind !== 'authorization' ||
      epoch.target_id !== manual.id ||
      !events.length ||
      events.length > 500 ||
      events.some(
        (event) =>
          event.reason !== 'OWNER_GENERATION_MODE_ACTIVE' ||
          event.source_kind !== 'policy' ||
          event.authorization_id !== manual.id ||
          event.scope_id !== scope.id,
      )
    )
      return blocked('INERT_MANUAL_AUTHORIZATION_VETOED');
  }
  const user = (await c.query('SELECT id,handle,deleted_at FROM users WHERE id=$1', [a.owner_id]))
    .rows[0];
  if (
    !user ||
    user.deleted_at !== null ||
    (config.mode === 'owner' && user.handle !== config.ownerHandle)
  )
    return blocked('AUTHORIZATION_OWNER_UNAVAILABLE');
  if (!ownerPricingIsCurrent(config.text.pricing) || !ownerPricingIsCurrent(config.image.pricing))
    return blocked('AUTHORIZATION_PRICING_EXPIRED');
  const revision = (
    await c.query(
      'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2',
      [a.id, a.policy_revision],
    )
  ).rows[0];
  if (
    !revision ||
    revision.scope_id !== scope.id ||
    revision.profile_hash !== a.policy_hash ||
    revision.profile_hash !== a.config_hash ||
    revision.config_fingerprint !== config.configFingerprint
  )
    return blocked('AUTHORIZATION_POLICY_CHANGED');
  if (config.mode === 'release') {
    const epoch = await currentReleaseDeployment(c, config);
    if (
      scope.id !== `release:${a.owner_id}` ||
      String(a.release_profile_epoch) !== epoch ||
      String(revision.release_profile_epoch) !== epoch ||
      a.config_hash !== config.configFingerprint
    )
      return blocked('AUTHORIZATION_RELEASE_PROFILE_CHANGED');
  }
  const unlimited = config.mode === 'release' && config.allowance === 'unlimited';
  if (a.unlimited_allowance !== unlimited || scope.unlimited_allowance !== unlimited)
    return blocked('AUTHORIZATION_ALLOWANCE_CHANGED');
  for (const [authKey, scopeKey, profileKey] of [
    ['cap_micros', 'total_cap_micros', 'totalCapMicros'],
    ['text_cap_micros', 'text_cap_micros', 'textCapMicros'],
    ['image_cap_micros', 'image_cap_micros', 'imageCapMicros'],
  ]) {
    const expected = revision.profile_snapshot?.[profileKey];
    if (
      unlimited
        ? [a[authKey], scope[scopeKey], expected].some((v) => v !== null)
        : expected == null ||
          String(a[authKey]) !== String(expected) ||
          String(scope[scopeKey]) !== String(expected)
    )
      return blocked('AUTHORIZATION_CAP_SHAPE_CHANGED');
  }
  const epochs = (
    await c.query('SELECT * FROM generation_stop_epochs WHERE id=ANY($1::bigint[])', [
      [scope.stop_epoch_id, a.stop_epoch_id],
    ])
  ).rows;
  const events = (
    await c.query(
      'SELECT * FROM generation_stop_events WHERE epoch_id=ANY($1::bigint[]) ORDER BY id LIMIT 501',
      [[scope.stop_epoch_id, a.stop_epoch_id]],
    )
  ).rows;
  if (events.length > 500) return blocked('STOP_PROVENANCE_SIZE_LIMIT');
  for (const [id, kind, target] of [
    [scope.stop_epoch_id, 'scope', scope.id],
    [a.stop_epoch_id, 'authorization', a.id],
  ] as const) {
    if (
      !recoverableStopEpoch(
        epochs.find((e) => String(e.id) === String(id)),
        events.filter((e) => String(e.epoch_id) === String(id)),
        kind,
        target,
        a,
      )
    )
      return blocked('STOP_EPOCH_UNATTRIBUTED_OR_VETOED');
  }
  const proof = await proveTerminalScopeLiabilities(c, scope, authorizations, {
    allowRetainedFullyFundedPending: true,
    allowedRequestStops: events.map((event) => ({
      kind: event.source_kind,
      id: event.source_id,
      causeCode: event.cause_code,
    })),
  });
  if (!proof.eligible) return blocked(proof.code);
  for (const event of events) {
    if (
      !proof.evidence.verifiedSources.some(
        (s) =>
          s.kind === event.source_kind && s.id === event.source_id && s.authorizationId === a.id,
      ) ||
      proof.evidence.retainedSourceIds.some(
        (s) => s.kind === event.source_kind && s.id === event.source_id,
      )
    )
      return blocked('STOP_SOURCE_NOT_TERMINALLY_VERIFIED');
    if (
      ['REQUEST_TIMEOUT', 'REQUEST_DEADLINE_EXCEEDED', 'JOB_CANCELLED_UNKNOWN'].includes(
        event.reason,
      )
    ) {
      const source = proof.evidence.verifiedSources.find(
        (s) => s.kind === event.source_kind && s.id === event.source_id,
      );
      if (
        !source ||
        ![
          'stale',
          'failed',
          'cancelled',
          'rejected',
          'expired',
          'over_context',
          'unknown',
        ].includes(source.providerJobStatus ?? source.status)
      )
        return blocked('REQUEST_STOP_SOURCE_NOT_DISCARDED');
    }
  }
  const evidence = {
    version: 'verified-access-v1',
    scopeEpochId: String(scope.stop_epoch_id),
    authorizationEpochId: String(a.stop_epoch_id),
    eventIds: events.map((e) => String(e.id)),
    policyRevision: a.policy_revision,
    policyHash: a.policy_hash,
    financial: proof.evidence,
  };
  const receipt = (
    await c.query(
      `INSERT INTO generation_access_recoveries(scope_epoch_id,authorization_epoch_id,scope_id,authorization_id,evidence_hash,evidence)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [
        scope.stop_epoch_id,
        a.stop_epoch_id,
        scope.id,
        a.id,
        digest(evidence),
        JSON.stringify(evidence),
      ],
    )
  ).rows[0];
  if (!receipt) return blocked('RECOVERY_ALREADY_RECORDED');
  await c.query(
    "UPDATE live_test_sessions SET state='active',stop_code=NULL WHERE id=$1 AND stop_epoch_id=$2",
    [a.id, a.stop_epoch_id],
  );
  await c.query(
    'UPDATE generation_budget_scopes SET blocked=false WHERE id=$1 AND stop_epoch_id=$2',
    [scope.id, scope.stop_epoch_id],
  );
  await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
    a.owner_id,
    'generation.verified_access.recovered',
    a.id,
    JSON.stringify({
      recoveryId: String(receipt.id),
      evidenceHash: digest(evidence),
      automaticRetry: false,
    }),
  ]);
  return { recovered: true as const, recoveryId: String(receipt.id) };
}

@Injectable()
export class VerifiedGenerationAccessRecovery implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private cursor: string | null = null;
  private readonly logger = new Logger(VerifiedGenerationAccessRecovery.name);
  constructor(@Inject(Db) private readonly db: Db) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.recoverPage();
    }, 30000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async recoverPage() {
    if (this.running) return this.running;
    this.running = this.runPage().catch(() => {
      this.logger.warn('VERIFIED_ACCESS_RECOVERY_FAILED');
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async runPage() {
    const config = readGenerationConfig(process.env);
    if (config.mode === 'disabled') return;
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM generation_budget_scopes WHERE blocked AND stop_epoch_id IS NOT NULL AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 25',
      [this.cursor],
    );
    for (const row of rows) {
      try {
        await this.db.tx((c) => recoverVerifiedGenerationAccessTx(c, row.id, config));
      } catch {
        this.logger.warn('VERIFIED_ACCESS_SCOPE_RECOVERY_FAILED');
      }
      this.cursor = row.id;
    }
    if (rows.length < 25) this.cursor = null;
  }
}
