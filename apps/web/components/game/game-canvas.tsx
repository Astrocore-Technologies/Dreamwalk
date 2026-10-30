'use client';
import { useEffect, useRef, useState } from 'react';
import { TextureBudget, textureDimensions } from '../assets/texture-budget';
import { decodeArt } from '../assets/decode-art';
import { visibleSceneArt } from '../assets/art-visibility';
import type { VisibleArtBinding } from '../assets/use-campaign-art';
import { artPreviewUrl } from '../assets/types';
import type { GamePoint, GameProjection } from '@dreamwalk/contracts';
import { resolveGameAtlas } from '@/lib/game-assets';
import { useT } from '@/lib/i18n';
import styles from './game.module.css';

/** Rendering only: never advances a logical position or applies a game action. */
export function GameCanvas({
  projection,
  art = [],
  onMove,
  onStop,
  disabled,
  reducedMotion,
  planning = false,
}: {
  projection: GameProjection;
  art?: VisibleArtBinding[];
  onMove: (point: GamePoint) => void;
  onStop: () => void;
  disabled: boolean;
  reducedMotion: boolean;
  planning?: boolean;
}) {
  const { t } = useT();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ projection, art, onMove, disabled, reducedMotion });
  const [failed, setFailed] = useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  useEffect(() => {
    latest.current = {
      projection,
      art,
      onMove,
      disabled,
      reducedMotion: reducedMotion || systemReducedMotion,
    };
  }, [projection, art, onMove, disabled, reducedMotion, systemReducedMotion]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const { Application, Assets, Container, Graphics, Sprite, Texture, Rectangle } =
        await import('pixi.js');
      if (disposed) return;
      const app = new Application();
      await app.init({
        resizeTo: element,
        background: '#171321',
        antialias: true,
        resolution: Math.min(devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (disposed) {
        app.destroy(true);
        return;
      }
      element.appendChild(app.canvas);
      app.canvas.setAttribute('aria-hidden', 'true');
      const observer = new ResizeObserver(() => {
        app.resize();
      });
      observer.observe(element);
      cleanup = () => {
        observer?.disconnect();
        app.destroy(true, { children: true });
      };
      const atlas = await Assets.load<InstanceType<typeof Texture>>(
        resolveGameAtlas(latest.current.projection.assetManifest),
      );
      if (disposed) return;
      const frames = Array.from(
        { length: 10 },
        (_, index) =>
          new Texture({ source: atlas.source, frame: new Rectangle(index * 64, 0, 64, 64) }),
      );
      const world = new Container();
      const artBackground = new Container();
      const terrain = new Container();
      const objects = new Container();
      const boundary = new Graphics();
      const actors = new Container();
      const focus = new Graphics();
      world.addChild(artBackground, terrain, objects, boundary, actors, focus);
      app.stage.addChild(world);
      const sprites = new Map<
        string,
        {
          sprite: InstanceType<typeof Sprite>;
          x: number;
          y: number;
          previousX: number;
          previousY: number;
          changedAt: number;
          mapId: string;
        }
      >();
      const textureBudget = new TextureBudget();
      const artSurfaces = new Map<string, HTMLCanvasElement>();
      const artTextures = new Map<string, InstanceType<typeof Texture>>();
      const artRequests = new Map<string, AbortController>();
      const retryArtAt = new Map<string, number>();
      let artKey = '';
      const oldCleanup = cleanup;
      cleanup = () => {
        for (const controller of artRequests.values()) controller.abort();
        artRequests.clear();
        textureBudget.close();
        oldCleanup();
        for (const texture of artTextures.values()) texture.destroy(true);
        artTextures.clear();
        for (const surface of artSurfaces.values()) {
          surface.width = 0;
          surface.height = 0;
        }
        artSurfaces.clear();
      };
      const synchronizeArt = () => {
        const state = latest.current;
        const visible = visibleSceneArt(state.projection, state.art);
        const allowed = new Set(visible.map((entry) => entry.url));
        for (const [url, controller] of artRequests)
          if (!allowed.has(url)) {
            controller.abort();
            artRequests.delete(url);
          }
        for (const [url, texture] of artTextures)
          if (!allowed.has(url)) {
            artTextures.delete(url);
            texture.destroy(true);
            const surface = artSurfaces.get(url);
            if (surface) {
              surface.width = 0;
              surface.height = 0;
              artSurfaces.delete(url);
            }
            textureBudget.release(url);
            lastRevision = -1;
          }
        for (const entry of [...visible].sort(
          (left, right) =>
            Number(right.slot.startsWith('map:')) - Number(left.slot.startsWith('map:')),
        )) {
          if (
            !artPreviewUrl(entry.url) ||
            artTextures.has(entry.url) ||
            artRequests.has(entry.url) ||
            (retryArtAt.get(entry.url) || 0) > Date.now()
          )
            continue;
          const dimensions = textureDimensions(entry.slot, entry.width, entry.height);
          if (!dimensions || !textureBudget.admit(entry.url, dimensions.width, dimensions.height))
            continue;
          const controller = new AbortController();
          let kept = false;
          artRequests.set(entry.url, controller);
          void (async () => {
            const response = await fetch(entry.url, {
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
            });
            if (!response.ok) throw new Error('ART_UNAVAILABLE');
            const blob = await response.blob();
            if (blob.size > 5 * 1024 * 1024) throw new Error('ART_TOO_LARGE');
            const surface = await decodeArt(
              blob,
              dimensions.width,
              dimensions.height,
              controller.signal,
            );
            try {
              if (
                disposed ||
                controller.signal.aborted ||
                artRequests.get(entry.url) !== controller ||
                !visibleSceneArt(latest.current.projection, latest.current.art).some(
                  (candidate) =>
                    candidate.url === entry.url && candidate.revisionId === entry.revisionId,
                )
              )
                return;
              artTextures.set(entry.url, Texture.from(surface));
              artSurfaces.set(entry.url, surface);
              kept = true;
              lastRevision = -1;
              artKey = '';
            } finally {
              if (!kept) {
                surface.width = 0;
                surface.height = 0;
              }
            }
          })()
            .catch(() => {
              retryArtAt.set(entry.url, Date.now() + 5000);
            })
            .finally(() => {
              textureBudget.complete(entry.url, kept);
              if (artRequests.get(entry.url) === controller) artRequests.delete(entry.url);
            });
        }
        const key = visible
          .map((entry) => `${entry.slot}:${entry.revisionId}:${artTextures.has(entry.url)}`)
          .join('|');
        if (key !== artKey) {
          artKey = key;
          lastRevision = -1;
          artBackground.removeChildren().forEach((child) => child.destroy());
          const background = visible.find(
            (entry) => entry.slot === `map:${state.projection.map.id}:background`,
          );
          const texture = background && artTextures.get(background.url);
          terrain.alpha = texture ? 0.28 : 1;
          if (texture) {
            const sprite = new Sprite(texture);
            sprite.width = state.projection.map.width * tile;
            sprite.height = state.projection.map.height * tile;
            artBackground.addChild(sprite);
          }
          element.dataset.artLoaded = String(artTextures.size);
        }
      };
      let mapKey = '';
      let lastRevision = -1;
      const tile = 48;
      const spriteAt = (
        frame: number,
        x: number,
        y: number,
        layer: InstanceType<typeof Container>,
      ) => {
        const sprite = new Sprite(frames[frame]);
        sprite.width = tile;
        sprite.height = tile;
        sprite.position.set(x * tile, y * tile);
        layer.addChild(sprite);
        return sprite;
      };
      world.eventMode = 'static';
      world.on('pointertap', (event) => {
        const state = latest.current;
        if (state.disabled) return;
        const local = world.toLocal(event.global);
        const x = Math.floor(local.x / tile),
          y = Math.floor(local.y / tile);
        if (x >= 0 && y >= 0 && x < state.projection.map.width && y < state.projection.map.height)
          state.onMove({ x, y });
      });
      const render = () => {
        const { projection: p, reducedMotion: reduced } = latest.current;
        app.ticker.maxFPS = reduced ? 30 : 60;
        synchronizeArt();
        const key = `${p.map.id}:${p.map.revision}`;
        if (key !== mapKey) {
          mapKey = key;
          lastRevision = -1;
          terrain.removeChildren().forEach((child) => child.destroy());
          const blocked = new Set(p.map.blocked.map((point) => `${point.x},${point.y}`));
          for (let y = 0; y < p.map.height; y++)
            for (let x = 0; x < p.map.width; x++) {
              spriteAt(blocked.has(`${x},${y}`) ? 1 : 0, x, y, terrain);
            }
          for (const exit of p.map.exits) spriteAt(8, exit.x, exit.y, terrain);
          world.hitArea = new Rectangle(0, 0, p.map.width * tile, p.map.height * tile);
        }
        const now = performance.now();
        if (p.revision !== lastRevision) {
          lastRevision = p.revision;
          const present = new Set<string>();
          for (const entity of p.entities) {
            present.add(entity.id);
            const frame =
              entity.kind === 'player'
                ? entity.id === p.actorId
                  ? 2
                  : 9
                : entity.kind === 'npc'
                  ? entity.visual === 'traveler'
                    ? 9
                    : 3
                  : entity.kind === 'door'
                    ? entity.open
                      ? 6
                      : 5
                    : entity.visual === 'key' || entity.id === 'key'
                      ? 4
                      : 7;
            let record = sprites.get(entity.id);
            if (!record) {
              const sprite = spriteAt(
                frame,
                entity.x,
                entity.y,
                entity.kind === 'player' || entity.kind === 'npc' ? actors : objects,
              );
              record = {
                sprite,
                x: entity.x * tile,
                y: entity.y * tile,
                previousX: entity.x * tile,
                previousY: entity.y * tile,
                changedAt: now,
                mapId: entity.mapId,
              };
              sprites.set(entity.id, record);
            }
            const suffix =
              entity.kind === 'npc'
                ? 'sprite'
                : `object:${entity.kind === 'door' ? (entity.open ? 'open' : 'closed') : 'default'}`;
            const binding =
              latest.current.art.find((entry) => entry.slot === `entity:${entity.id}:${suffix}`) ||
              latest.current.art.find(
                (entry) => entry.slot === `entity:${entity.id}:object:default`,
              );
            record.sprite.texture = (binding && artTextures.get(binding.url)) || frames[frame];
            if (
              record.x !== entity.x * tile ||
              record.y !== entity.y * tile ||
              record.mapId !== entity.mapId
            ) {
              const snap =
                reduced ||
                record.mapId !== entity.mapId ||
                Math.abs(record.x - entity.x * tile) + Math.abs(record.y - entity.y * tile) >
                  tile * 3;
              record.previousX = snap ? entity.x * tile : record.sprite.x;
              record.previousY = snap ? entity.y * tile : record.sprite.y;
              record.x = entity.x * tile;
              record.y = entity.y * tile;
              record.changedAt = now;
              record.mapId = entity.mapId;
            }
          }
          for (const [id, record] of sprites)
            if (!present.has(id)) {
              record.sprite.destroy();
              sprites.delete(id);
            }
          boundary.clear();
          if (p.encounter?.phase === 'planning') {
            const area = p.encounter.area;
            boundary
              .rect(area.x * tile, area.y * tile, area.width * tile, area.height * tile)
              .fill({ color: 0xd8b879, alpha: 0.08 })
              .stroke({ color: 0xe0bd79, width: 2, alpha: 0.8 });
          }
        }
        for (const record of sprites.values()) {
          const fraction = reduced ? 1 : Math.min(1, (now - record.changedAt) / 130);
          record.sprite.position.set(
            record.previousX + (record.x - record.previousX) * fraction,
            record.previousY + (record.y - record.previousY) * fraction,
          );
          record.sprite.zIndex = record.sprite.y;
        }
        actors.sortableChildren = true;
        const own = sprites.get(p.actorId);
        if (own) {
          const scale = zoomRef.current;
          world.scale.set(scale);
          world.position.set(
            app.screen.width / 2 - (own.sprite.x + tile / 2) * scale,
            app.screen.height / 2 - (own.sprite.y + tile / 2) * scale,
          );
          focus
            .clear()
            .ellipse(own.sprite.x + tile / 2, own.sprite.y + tile * 0.85, tile * 0.37, tile * 0.15)
            .stroke({ color: 0xf2d89b, width: 2 });
        }
      };

      app.ticker.maxFPS = latest.current.reducedMotion ? 30 : 60;
      app.ticker.add(render);
      render();
    })().catch(() => {
      if (!disposed) {
        cleanup();
        setFailed(true);
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
  const pressed = useRef<ReturnType<typeof setInterval> | null>(null);
  // Direction input sets a bounded one-tile goal. Releasing a quick tap must
  // not cancel it before the next server tick; at most that tile may complete.
  const releaseRepeat = () => {
    if (pressed.current) clearInterval(pressed.current);
    pressed.current = null;
  };
  const explicitStop = () => {
    releaseRepeat();
    if (!latest.current.disabled && !planning) onStop();
  };
  useEffect(
    () => () => {
      if (pressed.current) clearInterval(pressed.current);
    },
    [],
  );
  const step = (dx: number, dy: number) => {
    const p = latest.current.projection,
      self = p.entities.find((entity) => entity.id === p.actorId);
    if (!self || latest.current.disabled) return;
    const target = { x: self.x + dx, y: self.y + dy };
    if (target.x >= 0 && target.y >= 0 && target.x < p.map.width && target.y < p.map.height)
      latest.current.onMove(target);
  };
  const directions = [
    { key: 'ArrowUp', dx: 0, dy: -1, label: t('Вверх'), symbol: '↑' },
    { key: 'ArrowLeft', dx: -1, dy: 0, label: t('Влево'), symbol: '←' },
    { key: 'ArrowDown', dx: 0, dy: 1, label: t('Вниз'), symbol: '↓' },
    { key: 'ArrowRight', dx: 1, dy: 0, label: t('Вправо'), symbol: '→' },
  ];
  return (
    <section className={styles.mapSection}>
      <div
        className={styles.canvasWrap}
        tabIndex={0}
        role="group"
        aria-label={t('Карта приключения')}
        aria-describedby="game-controls-help"
        onBlur={explicitStop}
        onKeyUp={(event) => {
          if (
            ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            releaseRepeat();
          }
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const keys: Record<string, string> = {
            w: 'ArrowUp',
            a: 'ArrowLeft',
            s: 'ArrowDown',
            d: 'ArrowRight',
          };
          const direction = directions.find(
            (value) => value.key === (keys[event.key.toLowerCase()] || event.key),
          );
          if (direction) {
            event.preventDefault();
            if (event.repeat) return;
            releaseRepeat();
            step(direction.dx, direction.dy);
            if (!planning)
              pressed.current = setInterval(() => step(direction.dx, direction.dy), 150);
          }
        }}
      >
        <div ref={host} className={styles.canvas} />
        {failed && (
          <p className={styles.canvasFallback} role="status">
            {t('Графика недоступна. Используй список объектов и управление ниже.')}
          </p>
        )}
        <div className={styles.mapTools}>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(1.5, value + 0.2))}
            aria-label={t('Увеличить карту')}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.6, value - 0.2))}
            aria-label={t('Уменьшить карту')}
          >
            −
          </button>
          <button type="button" onClick={() => setZoom(1)} aria-label={t('Центрировать камеру')}>
            ◎
          </button>
        </div>
      </div>
      <div className={styles.controls}>
        <p id="game-controls-help">
          {t('Коснись клетки или используй стрелки / WASD. Действия доступны и под картой.')}
        </p>
        <div className={styles.dpad}>
          {directions.map((direction) => (
            <button
              key={direction.key}
              type="button"
              disabled={disabled}
              aria-label={direction.label}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                releaseRepeat();
                step(direction.dx, direction.dy);
                pressed.current = setInterval(() => step(direction.dx, direction.dy), 150);
              }}
              onPointerUp={releaseRepeat}
              onPointerCancel={explicitStop}
              onLostPointerCapture={releaseRepeat}
              onClick={(event) => {
                if (event.detail === 0) step(direction.dx, direction.dy);
              }}
            >
              {direction.symbol}
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            aria-label={t('Остановиться')}
            onClick={explicitStop}
          >
            ■
          </button>
        </div>
      </div>
    </section>
  );
}
