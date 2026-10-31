'use client';
import { useEffect, useRef, useState } from 'react';
import type { GameProjection } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { Button, ErrorBox, Field, Select } from '@/components/ui';
import { artPreviewUrl, type ArtRevision } from '../assets/types';
import { GroundedImage, type GroundedPreparation } from './grounded-image';
import { useNarrativeText } from './narrative-messages';
type Preparation = GroundedPreparation & {
  canonRevision: number;
  expectedMapId: string;
  slot: string;
  canAttach: boolean;
  canGenerate: boolean;
  matches: ArtRevision[];
  charge: 0;
  providerCalls: 0;
  automaticDispatch: false;
};
export function SceneMedia({
  campaignId,
  projection,
  disabled,
  onApplied,
}: {
  campaignId: string;
  projection: GameProjection;
  disabled: boolean;
  onApplied: () => void;
}) {
  const h = useNarrativeText();
  const [kind, setKind] = useState<'background' | 'portrait'>('background');
  const [selectedNpc, setSelectedNpc] = useState('');
  const npcs = projection.entities.filter((entity) => entity.kind === 'npc');
  const npcId = npcs.some((npc) => npc.id === selectedNpc) ? selectedNpc : npcs[0]?.id || '';
  const entityId = kind === 'portrait' ? npcId : undefined;
  const [prepared, setPrepared] = useState<Preparation | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [applied, setApplied] = useState(false);
  const generation = useRef(0),
    lock = useRef(false);
  const operation = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    generation.current++;
    setPrepared(null);
    setError('');
    setApplied(false);
    operation.current = null;
    return () => {
      generation.current++;
    };
  }, [campaignId, projection.map.id, kind, entityId]);
  async function search() {
    if (disabled || lock.current || (kind === 'portrait' && !entityId)) return;
    lock.current = true;
    const request = generation.current;
    setBusy(true);
    setError('');
    setApplied(false);
    setPrepared(null);
    try {
      const result = await api<Preparation>(`/game/campaigns/${campaignId}/media-preparation`, {
        method: 'POST',
        body: JSON.stringify({ kind, entityId }),
      });
      if (request === generation.current) setPrepared(result);
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function attach(revisionId: string) {
    if (
      disabled ||
      lock.current ||
      !prepared?.canAttach ||
      prepared.expectedMapId !== projection.map.id ||
      !prepared.matches.some((entry) => entry.id === revisionId && entry.canReuse)
    )
      return;
    const key = `${prepared.expectedMapId}:${prepared.canonRevision}:${kind}:${entityId || ''}:${revisionId}`;
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const operationId = operation.current.id,
      request = generation.current;
    lock.current = true;
    setBusy(true);
    setError('');
    setApplied(false);
    try {
      await api(`/game/campaigns/${campaignId}/media-bindings`, {
        method: 'POST',
        body: JSON.stringify({
          operationId,
          expectedCanonRevision: prepared.canonRevision,
          expectedMapId: prepared.expectedMapId,
          kind,
          entityId,
          revisionId,
        }),
      });
      if (request === generation.current) {
        setApplied(true);
        onApplied();
      }
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <details data-testid="scene-media">
      <summary>{h('mediaTitle')}</summary>
      <div className="stack" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <p>{h('media')}</p>
        <Field label={h('mediaKind')}>
          <Select
            aria-label={h('mediaKind')}
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="background">{h('background')}</option>
            <option value="portrait">{h('portrait')}</option>
          </Select>
        </Field>
        {kind === 'portrait' && (
          <Field label={h('mediaNpc')}>
            <Select
              aria-label={h('mediaNpc')}
              value={npcId}
              disabled={busy}
              onChange={(event) => setSelectedNpc(event.target.value)}
            >
              {npcs.map((npc) => (
                <option value={npc.id} key={npc.id}>
                  {npc.label || npc.id}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Button
          type="button"
          variant="secondary"
          busy={busy}
          disabled={disabled || busy || (kind === 'portrait' && !entityId)}
          onClick={() => void search()}
        >
          {h('findArt')}
        </Button>
        <ErrorBox message={error} />
        {applied && <p role="status">{h('artApplied')}</p>}
        {prepared && (
          <>
            <small>{h('artFree')}</small>
            {!prepared.canAttach && <p>{h('hostArt')}</p>}
            {!prepared.matches.length && <p role="status">{h('noArt')}</p>}
            {prepared.canGenerate && prepared.canAttach && (
              <GroundedImage
                key={`${prepared.groundingHash}:${kind}`}
                campaignId={campaignId}
                entityId={entityId}
                preparation={prepared}
                disabled={disabled || busy}
                onRevision={(entry) =>
                  setPrepared((current) =>
                    current
                      ? {
                          ...current,
                          matches: [
                            ...current.matches.filter((value) => value.id !== entry.id),
                            entry,
                          ],
                        }
                      : current,
                  )
                }
              />
            )}
            {prepared.matches.map((entry) => (
              <article key={entry.id} data-media-revision={entry.id} className="panel">
                {artPreviewUrl(entry.url) && (
                  <img
                    src={artPreviewUrl(entry.url)}
                    alt={entry.metadata.title}
                    width={144}
                    height={96}
                    loading="lazy"
                    decoding="async"
                    style={{ objectFit: 'contain', maxWidth: '100%' }}
                  />
                )}
                <h4>{entry.metadata.title}</h4>
                <p>
                  {entry.metadata.rights.attribution} {entry.metadata.rights.licenseLabel}
                </p>
                <Button
                  type="button"
                  disabled={
                    disabled ||
                    busy ||
                    !prepared.canAttach ||
                    !entry.canReuse ||
                    prepared.expectedMapId !== projection.map.id
                  }
                  onClick={() => void attach(entry.id)}
                >
                  {h('attachArt')}
                </Button>
              </article>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
