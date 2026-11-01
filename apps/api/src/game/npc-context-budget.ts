import { createHash } from 'node:crypto';
import { canonical } from '../ai/context';
/** Deterministic whole-record packing. Never cuts user text, promises or evidence mid-string. */
export function packNpcContext<T extends object>(
  input: T,
  maxBytes: number,
): T & { contextHash: string; budgetExceeded: boolean } {
  const value = structuredClone(input) as Record<string, unknown>;
  delete value.contextHash;
  const size = () => Buffer.byteLength(JSON.stringify(value));
  const array = (key: string) =>
    Array.isArray(value[key]) ? (value[key] as Record<string, unknown>[]) : [];
  const drop = (key: string) => {
    const list = array(key);
    while (size() > maxBytes && list.length) list.pop();
  };
  drop('archivedEpisodes');
  if (size() > maxBytes) delete value.summary;
  const required = new Set<string>();
  const goal = value.goal as { evidenceIds?: string[] } | undefined;
  for (const id of goal?.evidenceIds ?? []) required.add(id);
  for (const o of array('obligations'))
    for (const id of (o.evidenceIds as string[] | undefined) ?? []) required.add(id);
  const observations = array('observations');
  const latest = observations.filter((o) => o.kind === 'said' || o.kind === 'addressed').at(-1);
  if (latest) required.add(String(latest.id));
  for (let i = observations.length - 1; i >= 0 && size() > maxBytes; i--)
    if (!required.has(String(observations[i].id))) observations.splice(i, 1);
  if (Array.isArray(value.beliefs)) {
    const ids = new Set(observations.map((o) => o.id));
    value.beliefs = array('beliefs').filter((b) =>
      ((b.evidenceIds as unknown[]) ?? []).every((id) => ids.has(id)),
    );
  }
  const claims = array('claims'),
    asked = new Set((value.requestedFactIds as string[] | undefined) ?? []);
  if (typeof value.replyToObservationId === 'string') asked.add(value.replyToObservationId);
  const question =
    typeof value.replyToObservationId === 'string'
      ? claims.find((c) => c.observationId === value.replyToObservationId)
      : claims.filter((c) => typeof c.untrustedUtterance === 'string').at(-1);
  if (question) asked.add(String(question.observationId));
  for (let i = 0; i < claims.length && size() > maxBytes;) {
    if (!asked.has(String(claims[i].observationId))) claims.splice(i, 1);
    else i++;
  }
  const budgetExceeded = size() > maxBytes;
  value.budgetExceeded = budgetExceeded;
  return {
    ...value,
    contextHash: createHash('sha256')
      .update(JSON.stringify(canonical(value)))
      .digest('hex'),
  } as T & { contextHash: string; budgetExceeded: boolean };
}

/** Token-aware envelope fitting; canon, rules, goals, summaries and current utterances stay pinned. */
export function packNpcContextWindow<T extends object>(
  input: T,
  fits: (context: T) => boolean,
): T & { budgetExceeded: boolean } {
  const value = structuredClone(input) as T & Record<string, unknown>;
  const selection = {
    policy: 'recent-whole-records-v1',
    omittedRecords: 0,
    storedHistoryUnchanged: true,
    automaticSummaryCalls: false,
  };
  Object.assign(value, { contextSelection: selection, budgetExceeded: false });
  const required = new Set<string>((value.requestedFactIds as string[] | undefined) ?? []);
  if (value.replyToObservationId) required.add(String(value.replyToObservationId));
  const goal = value.goal as { evidenceIds?: string[] } | undefined;
  for (const id of goal?.evidenceIds ?? []) required.add(id);
  for (const o of (value.obligations as { evidenceIds?: string[] }[] | undefined) ?? [])
    for (const id of o.evidenceIds ?? []) required.add(id);
  const summary = value.summary as { observationIds?: string[] } | undefined;
  for (const id of summary?.observationIds ?? []) required.add(id);
  const pinnedRecords = new Set<Record<string, unknown>>();
  const recordId = (o: Record<string, unknown>) =>
    o.id === undefined && o.observationId === undefined
      ? undefined
      : String(o.id ?? o.observationId);
  const isRequired = (o: Record<string, unknown>) =>
    pinnedRecords.has(o) || (recordId(o) !== undefined && required.has(recordId(o)!));
  for (const key of ['history', 'observations', 'claims']) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    const latest =
      key === 'history'
        ? list.at(-1)
        : list
            .filter((o) => o.kind === 'said' || o.kind === 'addressed' || o.untrustedUtterance)
            .at(-1);
    if (latest) {
      pinnedRecords.add(latest);
      const id = recordId(latest);
      if (id !== undefined) required.add(id);
    }
  }
  const check = () => fits(value);
  const trim = (key: string, fromEnd = false) => {
    if (!Array.isArray(value[key]) || check()) return;
    const original = [...value[key]] as Record<string, unknown>[];
    const optional = original.filter((o) => !isRequired(o));
    const previousOmitted = selection.omittedRecords;
    const select = (keep: number) => {
      const allowed = new Set(
        fromEnd ? optional.slice(0, keep) : optional.slice(optional.length - keep),
      );
      const selected = original.filter((o) => isRequired(o) || allowed.has(o));
      selection.omittedRecords = previousOmitted + original.length - selected.length;
      Object.assign(value, { [key]: selected });
    };
    let low = 0,
      high = optional.length;
    while (low < high) {
      const keep = Math.ceil((low + high) / 2);
      select(keep);
      if (check()) low = keep;
      else high = keep - 1;
    }
    select(low);
  };
  trim('history');
  trim('archivedEpisodes', true);
  for (const key of ['observations', 'claims']) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    while (!check()) {
      const index = list.findIndex((o) => !isRequired(o));
      if (index < 0) break;
      list.splice(index, 1);
      selection.omittedRecords++;
    }
  }
  if (Array.isArray(value.beliefs) && Array.isArray(value.observations)) {
    const ids = new Set(value.observations.map((o) => o.id));
    Object.assign(value, {
      beliefs: value.beliefs.filter((b) =>
        (b.evidenceIds ?? []).every((id: string) => ids.has(id)),
      ),
    });
  }
  Object.assign(value, { budgetExceeded: !check() });
  return value as T & { budgetExceeded: boolean };
}
