'use client';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useDraftAutosave } from '@/lib/use-draft-autosave';
import { AutosaveStatus } from '@/components/studio/autosave-status';
import { Button, ErrorBox, Field, Select } from '@/components/ui';
import { AssetLibrary } from './asset-library';
import { useAssetText } from './messages';
import { artCameraMatches } from './types';
import type { ArtBinding, ArtCamera, ArtKind, ArtRevision } from './types';
import styles from './assets.module.css';
type Draft = { revision: number; bindings: ArtBinding[] };
export type ArtSlot = {
  id: string;
  label: string;
  kind: ArtKind;
  camera: ArtCamera;
};
export function StoryArtBindings({
  adventureId,
  slots,
  flushRef,
  onDirty,
  beforePersist,
  onSaved,
}: {
  adventureId: string;
  slots: ArtSlot[];
  flushRef?: MutableRefObject<(() => Promise<Draft>) | null>;
  onDirty?: (dirty: boolean) => void;
  beforePersist?: () => Promise<unknown>;
  onSaved?: () => void;
}) {
  const a = useAssetText();
  const [loaded, setLoaded] = useState<Draft | null>(null),
    [bindings, setBindings] = useState<ArtBinding[]>([]),
    [slot, setSlot] = useState(''),
    [error, setError] = useState(''),
    [epoch, setEpoch] = useState(0);
  const generation = useRef(0),
    operation = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    setLoaded(null);
    setBindings([]);
    setError('');
    operation.current = null;
    void api<Draft>(`/asset-library/stories/${adventureId}/draft`)
      .then((value) => {
        if (current === generation.current) {
          setLoaded(value);
          setBindings(value.bindings);
        }
      })
      .catch((err) => {
        if (current === generation.current) setError(errorMessage(err));
      });
    return () => {
      generation.current++;
    };
  }, [adventureId, epoch]);
  const saver = useDraftAutosave<ArtBinding[], Draft>({
    enabled: loaded !== null,
    identity: `${adventureId}:${epoch}`,
    draft: bindings,
    baseline: loaded?.bindings ?? [],
    revision: loaded?.revision ?? 0,
    initialResult: loaded ?? { revision: 0, bindings: [] },
    validate: (value) =>
      value.length <= 128 && new Set(value.map((item) => item.slot)).size === value.length,
    onAcknowledged: () => onSaved?.(),
    persist: async (value, revision) => {
      await beforePersist?.();
      const body = { expectedRevision: revision, bindings: value };
      const key = JSON.stringify(body);
      if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
      const result = await api<Draft>(`/asset-library/stories/${adventureId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ ...body, operationId: operation.current.id }),
      });
      return { revision: result.revision, result };
    },
  });
  useEffect(() => {
    if (flushRef) flushRef.current = loaded ? saver.flush : null;
    return () => {
      if (flushRef) flushRef.current = null;
    };
  }, [flushRef, loaded, saver.flush]);
  useEffect(() => {
    onDirty?.(saver.dirty);
    return () => onDirty?.(false);
  }, [onDirty, saver.dirty]);
  useEffect(() => {
    if (!saver.dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saver.dirty]);
  function reload() {
    if (saver.dirty && !window.confirm(a('discard'))) return;
    setEpoch((value) => value + 1);
  }
  function select(revision: ArtRevision) {
    const target = slots.find((item) => item.id === slot);
    if (
      !target ||
      !revision.canReuse ||
      target.kind !== revision.metadata.kind ||
      !artCameraMatches(target.camera, revision.metadata.camera)
    )
      return;
    setBindings((value) =>
      [
        ...value.filter((item) => item.slot !== target.id),
        { slot: target.id, revisionId: revision.id },
      ].sort((left, right) => left.slot.localeCompare(right.slot)),
    );
  }
  const current = slots.find((item) => item.id === slot);
  return (
    <section className={styles.root} aria-label={a('story')}>
      <h2>{a('story')}</h2>
      <p>{a('geometry')}</p>
      <ErrorBox message={error} />
      {!loaded ? (
        <>
          <p>{a('loading')}</p>
          {error && (
            <Button type="button" onClick={reload}>
              {a('refresh')}
            </Button>
          )}
        </>
      ) : (
        <>
          <AutosaveStatus
            status={saver.status}
            enabled
            retry={() => void saver.flush().catch(() => {})}
            reload={reload}
          />
          {saver.status === 'saved' && <p>{a('bindingsSaved')}</p>}
          <Field label={a('slot')}>
            <Select
              aria-label={a('slot')}
              value={slot}
              onChange={(event) => setSlot(event.target.value)}
            >
              <option value="">{a('chooseSlot')}</option>
              {slots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <ul>
            {bindings.map((binding) => (
              <li key={binding.slot}>
                {slots.find((item) => item.id === binding.slot)?.label ?? binding.slot}:{' '}
                {binding.revisionId}{' '}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setBindings((value) => value.filter((item) => item.slot !== binding.slot))
                  }
                >
                  {a('remove')}
                </Button>
              </li>
            ))}
          </ul>
          {current && (
            <AssetLibrary
              key={`${adventureId}:${current.id}`}
              adventureId={adventureId}
              onSelected={select}
              requiredKind={current.kind}
              requiredCamera={current.camera}
            />
          )}
        </>
      )}
    </section>
  );
}
