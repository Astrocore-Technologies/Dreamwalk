'use client';
import { useEffect, useRef, useState } from 'react';
import { Compass } from 'lucide-react';
import type { GameProjection } from '@dreamwalk/contracts';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/i18n';

export function LocationPicker({
  projection,
  disabled,
  onTravel,
}: {
  projection: GameProjection;
  disabled: boolean;
  onTravel: (mapId: string) => Promise<boolean>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const origin = projection.map.id;
  useEffect(() => setOpen(false), [origin]);
  async function travel(mapId: string) {
    if (disabled || pending.current || mapId === origin) return;
    pending.current = true;
    setBusy(true);
    try {
      if (await onTravel(mapId)) setOpen(false);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (!projection.locations?.length) return null;
  return (
    <>
      <Button variant="secondary" disabled={disabled || busy} onClick={() => setOpen(true)}>
        <Compass size={16} />
        {t('Выбрать локацию')}
      </Button>
      {open && (
        <Modal title={t('Выбрать локацию')} onClose={() => setOpen(false)}>
          <p>{t('Переход бесплатный. Новое место можно описать в истории.')}</p>
          <div className="stack">
            {projection.locations.map((location) => (
              <Button
                key={location.id}
                variant="secondary"
                disabled={disabled || busy || location.id === origin}
                onClick={() => void travel(location.id)}
              >
                {location.label}
                {location.id === origin ? ` · ${t('Ты здесь')}` : ''}
              </Button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
