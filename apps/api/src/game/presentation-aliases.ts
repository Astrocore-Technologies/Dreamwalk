import { AsyncLocalStorage } from 'node:async_hooks';
import type { GameState, Locale, StoryTurnInput } from '@dreamwalk/contracts';
import {
  mentionsPresentationLabel,
  projectState,
  storyTurnMode,
  validatePresentationAliases,
  type PresentationAliases,
} from '@dreamwalk/game-core';
import type { PoolClient } from 'pg';
import { digest } from '../ai/context';
import type { Db } from '../db';
import { PlayableContentSource } from '../translation/playable-content-source';
import type { ReadyContentTranslation } from '../translation/content-types';

/** Internal optional DI capability. A missing reader preserves legacy behavior. */
export interface ReadyContentTranslationsReader {
  readyFields(
    path: string,
    original: unknown,
    locale: Locale,
    viewerId: string,
  ): Promise<ReadyContentTranslation[]>;
}

const scope = new AsyncLocalStorage<Map<string, Promise<PresentationAliases | undefined>>>();
/** Token-count preflight can rerun the quote transaction. Keep its initial ready
 * cache result (including a miss) fixed across those reruns, before body counting. */
export function withPresentationAliasScope<T>(work: () => Promise<T>): Promise<T> {
  return scope.getStore() ? work() : scope.run(new Map(), work);
}

const source = new PlayableContentSource();
const stale = (): never => {
  throw new Error('INVALID_PRESENTATION_ALIASES');
};
const labelPath = (entry: PresentationAliases['entries'][number]) =>
  `${entry.kind}/${encodeURIComponent(entry.id)}/label`;

export function storedPresentationAliases(context: unknown): PresentationAliases | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const value = (context as Record<string, unknown>).presentationAliases;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return stale();
  return value as PresentationAliases;
}

/** Reuse the same source/member lifetime read fence as presentation reads. This
 * never reads translation cache, refreshes evidence, enqueues or calls a provider.
 * The caller must keep this transaction open through its admission/persistence. */
export async function assertPresentationAliasAuthority(
  c: Pick<PoolClient, 'query'>,
  campaignId: string,
  userId: string,
  actorId: string,
  aliases: PresentationAliases | undefined,
  effectiveText?: string,
): Promise<void> {
  if (aliases === undefined) return;
  if (
    aliases.campaignId !== campaignId ||
    aliases.actorId !== actorId ||
    aliases.version !== 'released-label-alias-v1' ||
    !Array.isArray(aliases.entries) ||
    !/^[a-f0-9]{64}$/u.test(aliases.authority)
  )
    return stale();
  const bundles = await source.load(
    c,
    { kind: 'playable', id: aliases.sourceVersionId },
    { kind: 'viewer', userId, campaignId },
  );
  const bundle = bundles.find((candidate) => candidate.authority === aliases.authority);
  if (!bundle) return stale();
  for (const entry of aliases.entries) {
    // Earlier ordered mechanics may consume an alias. Never refresh it, but an
    // unrelated later stage need not have that object in its current projection.
    if (
      effectiveText !== undefined &&
      !mentionsPresentationLabel(effectiveText, entry.text) &&
      !mentionsPresentationLabel(effectiveText, entry.sourceText)
    )
      continue;
    if (
      !bundle.fields.some(
        (field) => field.path === labelPath(entry) && field.text === entry.sourceText,
      )
    )
      return stale();
  }
}

export function capturePresentationAliases(
  db: Pick<Db, 'tx'>,
  reader: ReadyContentTranslationsReader | undefined,
  campaignId: string,
  campaign: { playableVersionId?: string | null; title: string | null },
  state: GameState,
  actorId: string,
  userId: string,
  input: StoryTurnInput,
): Promise<PresentationAliases | undefined> {
  if (
    !reader ||
    !campaign.playableVersionId ||
    !input.replyLocale ||
    storyTurnMode(input) !== 'director'
  )
    return Promise.resolve(undefined);
  const key = digest([campaignId, actorId, userId, input]);
  const current = scope.getStore();
  const existing = current?.get(key);
  if (existing) return existing;
  const result = (async () => {
    const rows = await reader.readyFields(
      `/game/campaigns/${campaignId}/snapshot`,
      { campaign, projection: projectState(state, actorId) },
      input.replyLocale!,
      userId,
    );
    const candidates = rows.filter(
      (row) =>
        row.source.kind === 'playable' &&
        row.source.id === campaign.playableVersionId &&
        row.text !== row.sourceText &&
        mentionsPresentationLabel(input.text, row.text),
    );
    if (!candidates.length) return undefined;
    return db.tx(async (c) => {
      const bundles = await source.load(
        c,
        { kind: 'playable', id: campaign.playableVersionId! },
        { kind: 'viewer', userId, campaignId },
      );
      const entries = new Map<string, PresentationAliases['entries'][number]>();
      let authority: string | undefined;
      for (const row of candidates) {
        const match = /^(entity|map)\/([^/]+)\/label$/u.exec(row.path);
        if (!match) continue;
        let id: string;
        try {
          id = decodeURIComponent(match[2]);
        } catch {
          continue;
        }
        if (encodeURIComponent(id) !== match[2]) continue;
        const bundle = bundles.find(
          (candidate) =>
            candidate.partition === row.partition &&
            candidate.fields.some(
              (field) => field.path === row.path && field.text === row.sourceText,
            ),
        );
        if (!bundle) return stale();
        if (authority && authority !== bundle.authority) return stale();
        authority = bundle.authority;
        const entry = {
          kind: match[1] as 'entity' | 'map',
          id,
          sourceText: row.sourceText,
          text: row.text,
          translationKey: row.translationKey,
        };
        const old = entries.get(row.path);
        if (old && digest(old) !== digest(entry)) return stale();
        entries.set(row.path, entry);
      }
      if (!entries.size || !authority) return undefined;
      return validatePresentationAliases(state, actorId, {
        version: 'released-label-alias-v1',
        campaignId,
        actorId,
        sourceVersionId: campaign.playableVersionId,
        authority,
        locale: input.replyLocale,
        entries: [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
      });
    });
  })();
  current?.set(key, result);
  return result;
}
