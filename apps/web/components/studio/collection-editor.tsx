'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BookOpen, MapPin, TriangleAlert } from 'lucide-react';
import styles from './studio.module.css';

/** Presentation selection only: the complete draft remains owned by AdventureEditor. */
export function CollectionEditor({
  items,
  label,
  kind,
  children,
  actions,
  invalidIds,
  invalidLabel,
}: {
  items: { id: string; name: string }[];
  label: string;
  kind: 'locations' | 'scenes' | 'lore';
  children: (item: { id: string; name: string }, index: number) => ReactNode;
  actions: ReactNode;
  invalidIds: string[];
  invalidLabel: string;
}) {
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const actionArea = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const itemIds = items.map((item) => item.id).join(',');
  const [knownIds, setKnownIds] = useState(itemIds);
  if (knownIds !== itemIds) {
    setKnownIds(itemIds);
    const added = items.filter((item) => !knownIds.split(',').includes(item.id));
    if (added.length) setSelected(added[added.length - 1].id);
  }
  const active = items.some((item) => item.id === selected) ? selected : items[0]?.id;
  const previous = useRef({ ids: itemIds, active });
  useEffect(() => {
    const removedActive =
      previous.current.active && !items.some((item) => item.id === previous.current.active);
    if (removedActive && document.activeElement === document.body) {
      const target =
        root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ??
        actionArea.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      target?.focus();
    }
    previous.current = { ids: itemIds, active };
  }, [itemIds, active, items]);
  const Icon = kind === 'locations' ? MapPin : BookOpen;
  return (
    <div ref={root} className={styles.collectionEditor} data-studio-collection={kind}>
      <aside className={styles.collectionRail} aria-label={label}>
        <h3>
          {label} <span>({items.length})</span>
        </h3>
        <div className={styles.collectionChoices}>
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={active === item.id}
              aria-invalid={invalidIds.includes(item.id) || undefined}
              aria-controls={`${prefix}-${index}`}
              onClick={() => setSelected(item.id)}
            >
              <span className={styles.collectionIcon}>
                <Icon size={24} />
              </span>
              <span>{item.name || `${label} ${index + 1}`}</span>
              {invalidIds.includes(item.id) && (
                <TriangleAlert size={20} role="img" aria-label={invalidLabel} />
              )}
            </button>
          ))}
        </div>
        <div ref={actionArea} className={styles.collectionActions}>
          {actions}
        </div>
      </aside>
      <div className={styles.collectionDetails}>
        {items.map((item, index) => (
          <fieldset
            key={item.id}
            id={`${prefix}-${index}`}
            hidden={active !== item.id}
            disabled={active !== item.id}
            className={styles.collectionPage}
          >
            {children(item, index)}
          </fieldset>
        ))}
      </div>
    </div>
  );
}
