'use client';
import { useEffect, useRef } from 'react';
import type { GameAction, GameProjection } from '@dreamwalk/contracts';
import { useItemText } from './item-messages';
import styles from './game.module.css';
export function MapActions({
  projection,
  ids,
  position,
  disabled,
  onClose,
  onAction,
  onSay,
  onInspect,
  onApproach,
}: {
  projection: GameProjection;
  ids: string[];
  position: { x: number; y: number };
  disabled: boolean;
  onClose: () => void;
  onAction: (a: GameAction) => void;
  onSay: (id: string) => void;
  onInspect?: (id: string) => void;
  onApproach: (p: { x: number; y: number }) => void;
}) {
  const text = useItemText(),
    ref = useRef<HTMLDivElement>(null);
  const entities = ids.flatMap((id) => {
    const e = projection.entities.find((e) => e.id === id);
    return e ? [e] : [];
  });
  const exits = projection.map.exits.filter((e) => ids.includes('exit:' + e.id));
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!entities.length && !exits.length) onClose();
  }, [entities.length, exits.length, onClose]);
  const own = projection.entities.find((e) => e.id === projection.actorId);
  const act = (a: GameAction) => {
    onClose();
    onAction(a);
  };
  return (
    <div
      className={styles.mapMenu}
      ref={ref}
      role="dialog"
      aria-label={text('actions')}
      style={{ left: Math.max(8, position.x), top: Math.max(8, position.y) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button
        type="button"
        className={styles.menuClose}
        onClick={onClose}
        aria-label={text('close')}
      >
        ×
      </button>
      {exits.map((e) => (
        <section key={e.id}>
          <strong>{e.label ?? e.id}</strong>
          <div className={styles.menuActions}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onClose();
                onApproach(e);
              }}
            >
              {text('approach')}
            </button>
            <button
              type="button"
              disabled={disabled || !own || Math.abs(e.x - own.x) + Math.abs(e.y - own.y) > 1}
              onClick={() => act({ kind: 'transition', targetId: e.id })}
            >
              {text('transition')}
            </button>
          </div>
        </section>
      ))}
      {entities.map((e) => {
        const near = !!own && Math.abs(e.x - own.x) + Math.abs(e.y - own.y) <= 1;
        const main = disabled || !near || (!!projection.turn && projection.turn.resources.main < 1);
        const additional =
          disabled || !near || (!!projection.turn && projection.turn.resources.additional < 1);
        return (
          <section key={e.id} data-map-target={e.id}>
            <strong>{e.label ?? e.id}</strong>
            {e.publicProfile?.description && <p>{e.publicProfile.description}</p>}
            <div className={styles.menuActions}>
              {e.kind === 'npc' && (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onClose();
                      onSay(e.id);
                    }}
                  >
                    {text('say')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onInspect?.(e.id);
                    }}
                  >
                    {text('inspect')}
                  </button>
                </>
              )}
              {e.kind === 'item' && e.item?.edible && (
                <button
                  type="button"
                  disabled={main}
                  onClick={() => act({ kind: 'consume', targetId: e.id })}
                >
                  {text('eat')}
                </button>
              )}
              {e.kind === 'item' && e.item?.portable !== false && (
                <button
                  type="button"
                  disabled={additional}
                  onClick={() => act({ kind: 'pick_up', targetId: e.id })}
                >
                  {text('take')}
                </button>
              )}
              {!near && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onClose();
                    onApproach(e);
                  }}
                >
                  {text('approach')}
                </button>
              )}
              {(e.kind === 'npc' || (e.kind === 'player' && e.id !== projection.actorId)) && (
                <>
                  <button
                    type="button"
                    disabled={main}
                    onClick={() => act({ kind: 'push', targetId: e.id })}
                  >
                    {text('push')}
                  </button>
                  <button
                    type="button"
                    disabled={main}
                    onClick={() => act({ kind: 'hit', targetId: e.id })}
                  >
                    {text('hit')}
                  </button>
                </>
              )}
              {e.kind === 'door' && (
                <>
                  <button
                    type="button"
                    disabled={additional}
                    onClick={() =>
                      act({
                        kind: e.locked ? 'unlock' : e.open ? 'close' : 'open',
                        targetId: e.id,
                        ...(e.locked ? { itemId: e.keyId } : {}),
                      })
                    }
                  >
                    {text(e.locked ? 'unlock' : e.open ? 'shut' : 'open')}
                  </button>
                  <button
                    type="button"
                    disabled={additional}
                    onClick={() => act({ kind: 'knock', targetId: e.id })}
                  >
                    {text('knock')}
                  </button>
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
export function InventoryPanel({
  projection,
  disabled,
  onAction,
  onClose,
}: {
  projection: GameProjection;
  disabled: boolean;
  onAction: (a: GameAction) => void;
  onClose: () => void;
}) {
  const text = useItemText(),
    ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <aside
      ref={ref}
      role="dialog"
      aria-label={text('inventory')}
      className={styles.inventoryOverlay}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header>
        <strong>
          {text('inventory')} · {projection.inventory.length}
        </strong>
        <button type="button" onClick={onClose} aria-label={text('close')}>
          ×
        </button>
      </header>
      {!projection.inventory.length && <p>{text('empty')}</p>}
      <ul>
        {projection.inventory.map((e) => (
          <li key={e.id} data-inventory-id={e.id}>
            <strong>{e.label ?? e.id}</strong>
            {e.publicProfile?.description && <p>{e.publicProfile.description}</p>}
            {e.item?.edible && (
              <button
                type="button"
                disabled={disabled || (!!projection.turn && projection.turn.resources.main < 1)}
                onClick={() => onAction({ kind: 'consume', targetId: e.id })}
              >
                {text('eat')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
