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
  const question = claims.filter((c) => typeof c.untrustedUtterance === 'string').at(-1);
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
