'use client';
import { useEffect, useRef, useState } from 'react';
import { defaultPortraitFrame, portraitCropRect, type PortraitFrame } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button } from './ui';
import { FramedPortrait } from './framed-portrait';
import styles from './framed-portrait.module.css';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Choose which part of a portrait is shown in round and square frames. The image is never changed. */
export function PortraitFrameEditor({
  src,
  value,
  onChange,
  disabled = false,
}: {
  src?: string;
  value?: PortraitFrame | null;
  onChange: (frame: PortraitFrame | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number; frame: PortraitFrame } | null>(null);
  useEffect(() => {
    setSize(null);
    if (!src) return;
    const image = new Image();
    image.onload = () => setSize({ w: image.naturalWidth, h: image.naturalHeight });
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  const current = value ?? (size ? defaultPortraitFrame(size.w, size.h) : null);
  const update = (patch: Partial<PortraitFrame>) => {
    if (!current) return;
    onChange({
      x: round3(clamp(patch.x ?? current.x, 0, 1)),
      y: round3(clamp(patch.y ?? current.y, 0, 1)),
      zoom: round3(clamp(patch.zoom ?? current.zoom, 1, 4)),
    });
  };
  if (!src) return null;
  return (
    <div className="stack" data-testid="portrait-frame-editor">
      <strong>{t('Кадр портрета')}</strong>
      <small>
        {t('Перетащи картинку или двигай ползунки: так портрет увидят на карте и в карточках.')}
      </small>
      <div className={styles.editor}>
        <div
          className={styles.round}
          data-testid="portrait-frame-preview"
          onPointerDown={(event) => {
            if (disabled || !current) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, frame: current };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || !size) return;
            const box = event.currentTarget.getBoundingClientRect();
            const { side } = portraitCropRect(size.w, size.h, start.frame);
            const perPixel = side / box.width;
            onChange({
              ...start.frame,
              x: round3(
                clamp(start.frame.x - ((event.clientX - start.x) * perPixel) / size.w, 0, 1),
              ),
              y: round3(
                clamp(start.frame.y - ((event.clientY - start.y) * perPixel) / size.h, 0, 1),
              ),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <FramedPortrait src={src} frame={current} draggable={false} />
        </div>
        <div className={styles.controls}>
          <label>
            {t('Масштаб')}
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              disabled={disabled || !current}
              value={current?.zoom ?? 1}
              onChange={(event) => update({ zoom: Number(event.target.value) })}
            />
          </label>
          <label>
            {t('По горизонтали')}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              disabled={disabled || !current}
              value={current?.x ?? 0.5}
              onChange={(event) => update({ x: Number(event.target.value) })}
            />
          </label>
          <label>
            {t('По вертикали')}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              disabled={disabled || !current}
              value={current?.y ?? 0.5}
              onChange={(event) => update({ y: Number(event.target.value) })}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || !value}
            onClick={() => onChange(null)}
          >
            {t('Сбросить кадр')}
          </Button>
        </div>
      </div>
    </div>
  );
}
