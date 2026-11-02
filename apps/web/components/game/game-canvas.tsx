'use client';
import { BATTLEMAP_CELLS, BATTLEMAP_TILE } from '@dreamwalk/contracts';
import { intersectsViewport, rendererActivity } from './renderer-activity';
import { sceneClick } from './scene-input';
import { entityLayout, containsScenePoint } from './scene-geometry';
import { MapActions, InventoryPanel } from './map-actions';
import { useItemText } from './item-messages';
import { committedPathSample, spriteFeedback } from './turn-ui';
import { useEffect, useRef, useState } from 'react';
import { mapCamera, mapRasterBounds, MIN_MAP_ZOOM, MAX_MAP_ZOOM } from './map-camera';
import { useObjectiveText } from './campaign-objectives';
import { drawBundledScene, drawJournal } from './bundled-scene';
import { TextureBudget, textureDimensions } from '../assets/texture-budget';
import { decodeArt } from '../assets/decode-art';
import { visibleSceneArt } from '../assets/art-visibility';
import type { VisibleArtBinding } from '../assets/use-campaign-art';
import { artPreviewUrl } from '../assets/types';
import type { GamePoint, GameProjection, GameAction } from '@dreamwalk/contracts';
import { resolveGameAtlas } from '@/lib/game-assets';
import { useT } from '@/lib/i18n';
import styles from './game.module.css';

/** Rendering only: never advances a logical position or applies a game action. */
export function GameCanvas({
  projection,
  art = [],
  onMove,
  onSelectNpc,
  onInspectNpc,
  onAction,
  onApproach,
  onStop,
  disabled,
  reducedMotion,
  planning = false,
}: {
  projection: GameProjection;
  art?: VisibleArtBinding[];
  onMove: (point: GamePoint) => void;
  onSelectNpc: (npcId: string) => void;
  onInspectNpc?: (npcId: string) => void;
  onAction?: (action: GameAction) => void;
  onApproach?: (point: GamePoint) => void;
  onStop: () => void;
  disabled: boolean;
  reducedMotion: boolean;
  planning?: boolean;
}) {
  const { t } = useT();
  const itemText = useItemText();
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [menu, setMenu] = useState<{ ids: string[]; x: number; y: number; mapId: string } | null>(
    null,
  );
  const objectiveText = useObjectiveText();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({
    projection,
    art,
    onMove,
    onSelectNpc,
    onInspectNpc,
    disabled,
    reducedMotion,
  });
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
      onSelectNpc,
      onInspectNpc,
      disabled,
      reducedMotion: reducedMotion || systemReducedMotion,
    };
  }, [
    projection,
    art,
    onMove,
    onSelectNpc,
    onInspectNpc,
    disabled,
    reducedMotion,
    systemReducedMotion,
  ]);
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
        autoStart: false,
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight),
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
      // ResizePlugin's resizeTo renders unconditionally, even with a stopped
      // ticker. Own resizing here so offscreen/hidden canvases do no frame work.
      let synchronizeFrame = () => {};
      let resumeFrame = () => {};
      const resize = () =>
        app.renderer.resize(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight));
      element.dataset.rendererActive = 'false';
      const activity = rendererActivity({
        resume: () => {
          resize();
          resumeFrame();
          app.render();
          element.dataset.rendererActive = 'true';
          app.start(); // Pixi resets its RAF timestamp when restarting.
        },
        pause: () => {
          app.stop();
          element.dataset.rendererActive = 'false';
        },
      });
      const supportsIntersection = typeof IntersectionObserver !== 'undefined';
      let inViewport =
        !supportsIntersection ||
        intersectsViewport(element.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      const visibility = () => activity.visibility(inViewport, document.hidden);
      const intersection = supportsIntersection
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries.find((value) => value.target === element);
              if (!entry) return;
              inViewport =
                entry.isIntersecting &&
                entry.intersectionRect.width > 0 &&
                entry.intersectionRect.height > 0;
              visibility();
            },
            { threshold: [0, Number.EPSILON] },
          )
        : null;
      intersection?.observe(element);
      document.addEventListener('visibilitychange', visibility);
      visibility();
      const observer = new ResizeObserver(() => {
        if (!activity.isActive()) return;
        resize();
        synchronizeFrame();
        app.render();
      });
      observer.observe(element);
      let cleaned = false;
      cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        intersection?.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        observer.disconnect();
        activity.dispose();
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
      const targetsAt = (point: { x: number; y: number }) => {
        const p = latest.current.projection;
        const ids = [...sprites.entries()]
          .filter(
            ([id, r]) =>
              p.entities.some((e) => e.id === id && e.id !== p.actorId) &&
              containsScenePoint(
                { x: r.sprite.x, y: r.sprite.y, width: r.sprite.width, height: r.sprite.height },
                point,
              ),
          )
          .sort((a, b) => b[1].sprite.zIndex - a[1].sprite.zIndex)
          .map(([id]) => id);
        if (!ids.length)
          for (const exit of p.map.exits)
            if (
              containsScenePoint({ x: exit.x * 48, y: exit.y * 48, width: 48, height: 48 }, point)
            )
              ids.push('exit:' + exit.id);
        return ids;
      };
      const openMenu = (point: { x: number; y: number }, screen: { x: number; y: number }) => {
        const ids = targetsAt(point),
          p = latest.current.projection;
        setMenu(
          ids.length
            ? {
                ids,
                x: Math.min(screen.x, Math.max(8, element.clientWidth - 250)),
                y: Math.min(screen.y, Math.max(8, element.clientHeight - 240)),
                mapId: p.map.id,
              }
            : null,
        );
      };
      app.canvas.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const bounds = app.canvas.getBoundingClientRect();
        const screen = {
          x: ((event.clientX - bounds.left) * app.screen.width) / bounds.width,
          y: ((event.clientY - bounds.top) * app.screen.height) / bounds.height,
        };
        openMenu(world.toLocal(screen), screen);
      });

      const artBackground = new Container();
      const terrain = new Container();
      const sceneDecoration = new Graphics();
      const journalDrawing = new Graphics();
      drawJournal(journalDrawing);
      const journalTexture = app.renderer.generateTexture(journalDrawing);
      journalDrawing.destroy();
      const objects = new Container();
      const itemDrawing = new Graphics();
      const itemTextures = new Map<string, InstanceType<typeof Texture>>();
      for (const kind of ['food', 'cup', 'battery', 'object']) {
        itemDrawing.clear();
        if (kind === 'food') {
          itemDrawing.ellipse(32, 37, 29, 21).fill(0xe8dfcd).stroke({ color: 0x8e7b68, width: 3 });
          itemDrawing.ellipse(32, 34, 21, 14).fill(0xad5e30);
          itemDrawing.ellipse(23, 30, 7, 6).fill(0xe6ba65);
          itemDrawing.ellipse(41, 31, 8, 7).fill(0x698b49);
        } else if (kind === 'cup') {
          itemDrawing.ellipse(45, 29, 14, 15).stroke({ color: 0xe7d5c0, width: 7 });
          itemDrawing
            .roundRect(10, 14, 34, 39, 9)
            .fill(0xd9c5a7)
            .stroke({ color: 0x8e7866, width: 3 });
          itemDrawing.ellipse(27, 17, 16, 6).fill(0x71513c);
        } else if (kind === 'battery') {
          itemDrawing
            .roundRect(13, 10, 34, 45, 5)
            .fill(0x62949b)
            .stroke({ color: 0xb7d4cf, width: 3 });
          itemDrawing.rect(23, 4, 14, 7).fill(0xa0acae);
          itemDrawing
            .moveTo(34, 20)
            .lineTo(25, 34)
            .lineTo(34, 34)
            .lineTo(26, 46)
            .stroke({ color: 0xf4dc92, width: 4 });
        } else
          itemDrawing
            .roundRect(8, 12, 47, 43, 10)
            .fill(0xc4a478)
            .stroke({ color: 0x705c47, width: 3 });
        itemTextures.set(
          kind,
          app.renderer.generateTexture({ target: itemDrawing, frame: new Rectangle(0, 0, 64, 64) }),
        );
      }
      itemDrawing.destroy();
      const boundary = new Graphics();
      const grid = new Graphics();
      const actors = objects;
      objects.sortableChildren = true;
      const decorations: InstanceType<typeof Sprite>[] = [];
      const focus = new Graphics();
      world.addChild(artBackground, terrain, sceneDecoration, boundary, grid, objects, focus);
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
          direction: number;
          walkingUntil: number;
          animatedTexture?: InstanceType<typeof Texture>;
          animationBase?: InstanceType<typeof Texture>;
          animationFrame?: number;
          animated: boolean;
          offsetX?: number;
          offsetY?: number;
          traceSequence: number;
          trace?: GamePoint[];
          traceStartedAt: number;
          feedbackSequence: number;
          feedbackStartedAt: number;
          feedback?: { kind: 'hit' | 'push'; dx: number; dy: number };
        }
      >();
      const textureBudget = new TextureBudget();
      const artSurfaces = new Map<string, HTMLCanvasElement>();
      const artTextures = new Map<string, InstanceType<typeof Texture>>();
      const artRequests = new Map<string, AbortController>();
      const retryArtAt = new Map<string, number>();
      let artKey = '';
      const oldCleanup = cleanup;
      let resourcesCleaned = false;
      cleanup = () => {
        if (resourcesCleaned) return;
        resourcesCleaned = true;
        for (const controller of artRequests.values()) controller.abort();
        artRequests.clear();
        textureBudget.close();
        oldCleanup();
        journalTexture.destroy(true);
        for (const texture of itemTextures.values()) texture.destroy(true);
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
        const key =
          `${state.projection.map.id}:${state.projection.map.width}:${state.projection.map.height}:` +
          JSON.stringify(state.projection.map.composition) +
          visible
            .map(
              (entry) =>
                `${entry.slot}:${entry.revisionId}:${artTextures.has(entry.url)}:${JSON.stringify(entry.imageFraming ?? null)}`,
            )
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
          sceneDecoration.visible = !texture;
          terrain.visible = !texture || !state.projection.map.composition;
          if (texture) {
            const sprite = new Sprite(texture);
            const framing = mapRasterBounds(
              background?.width ?? texture.width,
              background?.height ?? texture.height,
              state.projection.map.width * tile,
              state.projection.map.height * tile,
              background?.imageFraming,
              state.projection.map,
            );
            sprite.position.set(framing.x, framing.y);
            sprite.width = framing.width;
            sprite.height = framing.height;
            artBackground.addChild(sprite);
          }
          for (const decoration of decorations) decoration.destroy();
          decorations.length = 0;
          for (const layer of state.projection.map.composition?.layers ?? []) {
            const binding = visible.find(
              (entry) => entry.slot === `map:${state.projection.map.id}:layer:${layer.id}`,
            );
            const layerTexture = binding && artTextures.get(binding.url);
            if (!layerTexture) continue;
            const sprite = new Sprite(layerTexture);
            sprite.width = layer.width * tile;
            sprite.height = (layer.height + (layer.solid ? 1 : 0)) * tile;
            sprite.position.set(layer.x * tile, (layer.y - (layer.solid ? 1 : 0)) * tile);
            sprite.zIndex = layer.solid ? (layer.y + layer.height) * tile - 1 : -100;
            actors.addChild(sprite);
            decorations.push(sprite);
          }
          element.dataset.artLoaded = String(artTextures.size);
        }
      };
      let mapKey = '';
      let lastRevision = -1;
      const tile = BATTLEMAP_TILE;
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
        if (event.button !== 0) return;
        const state = latest.current;
        const local = world.toLocal(event.global);
        const hits = targetsAt(local);
        if (
          hits.some(
            (id) =>
              state.projection.entities.find((e) => e.id === id)?.kind === 'item' ||
              id.startsWith('exit:'),
          ) ||
          (event.pointerType === 'touch' && hits.length)
        ) {
          openMenu(local, event.global);
          return;
        }
        setMenu(null);
        if (state.disabled) return;
        const x = Math.floor(local.x / tile),
          y = Math.floor(local.y / tile);
        const drawnNpc = hits.find((id) =>
          state.projection.entities.some((e) => e.id === id && e.kind === 'npc'),
        );
        if (drawnNpc) {
          state.onSelectNpc(drawnNpc);
          return;
        }
        const interaction = sceneClick(state.projection, x, y);
        if (interaction?.kind === 'npc') state.onSelectNpc(interaction.npcId);
        else if (interaction?.kind === 'move') state.onMove(interaction.target);
      });
      let resuming = false;
      const render = () => {
        const { projection: p, reducedMotion } = latest.current;
        const reduced = reducedMotion || resuming;
        app.ticker.maxFPS = reduced ? 30 : 60;
        synchronizeArt();
        const key = `${p.map.id}:${p.map.revision}:${p.map.width}:${p.map.height}:${p.map.sceneProfile || ''}:${JSON.stringify(p.map.composition)}`;
        if (key !== mapKey) {
          mapKey = key;
          lastRevision = -1;
          terrain.removeChildren().forEach((child) => child.destroy());
          drawBundledScene(sceneDecoration, p.map, tile);
          element.dataset.sceneProfile = p.map.sceneProfile || 'none';
          const blocked = new Set(p.map.blocked.map((point) => `${point.x},${point.y}`));
          for (let y = 0; y < p.map.height; y++)
            for (let x = 0; x < p.map.width; x++) {
              spriteAt(blocked.has(`${x},${y}`) ? 1 : 0, x, y, terrain);
            }
          for (const exit of p.map.exits) spriteAt(8, exit.x, exit.y, terrain);
          grid.clear();
          const edge = Math.max(BATTLEMAP_CELLS, p.map.width, p.map.height);
          for (let cell = 0; cell <= edge; cell++) {
            grid.moveTo(cell * tile, 0).lineTo(cell * tile, edge * tile);
            grid.moveTo(0, cell * tile).lineTo(edge * tile, cell * tile);
          }
          grid.stroke({ color: 0xf4ecd8, alpha: 0.4, width: 1 });
          element.dataset.battlemapGrid = `${edge}x${edge}`;
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
                direction: 0,
                walkingUntil: 0,
                animated: false,
                traceSequence: entity.movementTrace?.sequence ?? -1,
                traceStartedAt: 0,
                feedbackSequence: entity.feedback?.sequence ?? -1,
                feedbackStartedAt: 0,
              };
              sprites.set(entity.id, record);
            }
            const suffix =
              entity.kind === 'npc' || entity.kind === 'player'
                ? 'sprite'
                : `object:${entity.kind === 'door' ? (entity.open ? 'open' : 'closed') : 'default'}`;
            const binding =
              latest.current.art.find((entry) => entry.slot === `entity:${entity.id}:${suffix}`) ||
              latest.current.art.find(
                (entry) => entry.slot === `entity:${entity.id}:object:default`,
              );
            const boundTexture = binding && artTextures.get(binding.url);
            record.animated = !!(entity.characterAnimation && boundTexture);
            if (record.animated && boundTexture) {
              if (record.animationBase !== boundTexture) {
                record.animatedTexture?.destroy(false);
                record.animationBase = boundTexture;
                record.animatedTexture = new Texture({
                  source: boundTexture.source,
                  dynamic: true,
                  frame: new Rectangle(0, 0, boundTexture.width / 6, boundTexture.height / 4),
                });
                record.animationFrame = -1;
              }
              record.sprite.texture = record.animatedTexture!;
              record.sprite.width = tile;
              record.sprite.height = tile * 1.5;
            } else {
              record.animatedTexture?.destroy(false);
              record.animatedTexture = undefined;
              record.animationBase = undefined;
              record.sprite.texture =
                boundTexture ||
                (entity.item
                  ? itemTextures.get(entity.item.visual)!
                  : entity.visual === 'journal'
                    ? journalTexture
                    : frames[frame]);
              record.sprite.width = tile;
              record.sprite.height = boundTexture && entity.kind === 'door' ? tile * 1.5 : tile;
            }
            const layout = entityLayout(
              entity,
              p.entities,
              tile,
              record.sprite.texture.width / record.sprite.texture.height,
              record.animated ||
                (!!boundTexture && (entity.kind === 'npc' || entity.kind === 'player')),
            );
            record.sprite.width = layout.width;
            record.sprite.height = layout.height;
            record.offsetX = layout.x - entity.x * tile;
            record.offsetY = layout.y - entity.y * tile;
            if (entity.movementTrace && entity.movementTrace.sequence !== record.traceSequence) {
              record.traceSequence = entity.movementTrace.sequence;
              record.trace =
                record.mapId === entity.mapId ? entity.movementTrace.points : undefined;
              record.traceStartedAt = now;
            }
            if (entity.feedback && entity.feedback.sequence !== record.feedbackSequence) {
              record.feedbackSequence = entity.feedback.sequence;
              record.feedbackStartedAt = now;
              record.feedback = {
                kind: entity.feedback.kind,
                dx: entity.feedback.dx,
                dy: entity.feedback.dy,
              };
            }
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
              const dx = entity.x * tile - record.x,
                dy = entity.y * tile - record.y;
              record.direction = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
              record.walkingUntil = snap ? 0 : now + 200;
              record.previousX = snap ? entity.x * tile : record.sprite.x - (record.offsetX ?? 0);
              record.previousY = snap ? entity.y * tile : record.sprite.y - (record.offsetY ?? 0);
              record.x = entity.x * tile;
              record.y = entity.y * tile;
              record.changedAt = now;
              record.mapId = entity.mapId;
            }
          }
          for (const [id, record] of sprites)
            if (!present.has(id)) {
              record.sprite.destroy();
              record.animatedTexture?.destroy(false);
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
          if (resuming) {
            record.trace = undefined;
            record.feedback = undefined;
            record.walkingUntil = 0;
            record.previousX = record.x;
            record.previousY = record.y;
            record.changedAt = now - 200;
          }
          const fraction = reduced ? 1 : Math.min(1, (now - record.changedAt) / 130);
          const trace =
            !reduced && record.trace
              ? committedPathSample(record.trace, now - record.traceStartedAt)
              : null;
          const feedback =
            !reduced && record.feedback
              ? spriteFeedback(
                  record.feedback.kind,
                  now - record.feedbackStartedAt,
                  record.feedback.dx,
                  record.feedback.dy,
                )
              : { x: 0, y: 0, rotation: 0 };
          const x = trace
            ? trace.x * tile
            : record.previousX + (record.x - record.previousX) * fraction;
          const y = trace
            ? trace.y * tile
            : record.previousY + (record.y - record.previousY) * fraction;
          if (trace?.moving) {
            record.direction = trace.direction;
            record.walkingUntil = now + 130;
          } else if (record.trace) record.trace = undefined;
          record.sprite.position.set(
            x + feedback.x + (record.offsetX ?? 0),
            y + feedback.y + (record.offsetY ?? 0),
          );
          record.sprite.rotation = feedback.rotation;
          record.sprite.zIndex = y + tile + (record.offsetX ? 2 : 0);
          if (record.animated && record.animatedTexture && record.animationBase) {
            const col = reduced
              ? 0
              : now < record.walkingUntil
                ? 2 + (Math.floor(now / 125) % 4)
                : Math.floor(now / 700) % 2;
            const index = record.direction * 6 + col;
            if (index !== record.animationFrame) {
              record.animationFrame = index;
              const base = record.animationBase;
              record.animatedTexture.frame.x = (col * base.width) / 6;
              record.animatedTexture.frame.y = (record.direction * base.height) / 4;
              record.animatedTexture.updateUvs();
            }
          }
        }
        actors.sortableChildren = true;
        const renderedActor = p.entities.find((entity) => entity.id === p.actorId);
        const own = sprites.get(p.actorId);
        const camera = mapCamera({
          viewportWidth: app.screen.width,
          viewportHeight: app.screen.height,
          worldWidth: Math.max(BATTLEMAP_CELLS, p.map.width, p.map.height) * tile,
          worldHeight: Math.max(BATTLEMAP_CELLS, p.map.width, p.map.height) * tile,
          zoom: zoomRef.current,
          // Follow the animated world-cell center, not a tall/narrow sprite's top corner.
          focusX: own ? own.sprite.x + own.sprite.width / 2 : undefined,
          focusY: own ? own.sprite.y + own.sprite.height / 2 : undefined,
        });
        world.scale.set(camera.scale);
        world.position.set(camera.x, camera.y);
        for (const [key, value] of Object.entries({
          cameraX: camera.x,
          cameraY: camera.y,
          cameraScale: camera.scale,
          cameraFitScale: camera.fitScale,
          cameraZoom: zoomRef.current,
        })) {
          const text = value.toFixed(3);
          if (element.dataset[key] !== text) element.dataset[key] = text;
        }
        for (const [key, value] of Object.entries({
          renderedMapId: p.map.id,
          renderedActorX: String(renderedActor?.x ?? ''),
          renderedActorY: String(renderedActor?.y ?? ''),
        })) {
          if (element.dataset[key] !== value) element.dataset[key] = value;
        }
        if (own) {
          focus
            .clear()
            .ellipse(
              own.sprite.x + own.sprite.width / 2,
              own.sprite.y + own.sprite.height - tile * 0.15,
              tile * 0.37,
              tile * 0.15,
            )
            .stroke({ color: 0xf2d89b, width: 2 });
        }
      };

      app.ticker.maxFPS = latest.current.reducedMotion ? 30 : 60;
      app.ticker.add(render);
      synchronizeFrame = render;
      resumeFrame = () => {
        resuming = true;
        try {
          render();
        } finally {
          resuming = false;
        }
      };
      activity.ready();
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
  const explicitStop = () => {
    if (!latest.current.disabled && !planning) onStop();
  };
  return (
    <section className={styles.mapSection}>
      <div
        className={styles.canvasWrap}
        tabIndex={0}
        role="group"
        aria-label={t('Карта приключения')}
        aria-describedby="game-controls-help"
        onBlur={(event) => {
          // React blur bubbles from nested menu/inventory controls. Moving focus
          // within the map must not race the selected command with a stop revision.
          if (!event.currentTarget.contains(event.relatedTarget)) explicitStop();
        }}
      >
        <div ref={host} className={styles.canvas} />
        <button
          className={styles.inventoryToggle}
          type="button"
          aria-expanded={inventoryOpen}
          onClick={() => {
            setInventoryOpen((v) => !v);
            setMenu(null);
          }}
        >
          {itemText('inventory')} · {projection.inventory.length}
        </button>
        {inventoryOpen && (
          <InventoryPanel
            projection={projection}
            disabled={disabled}
            onAction={(action) => onAction?.(action)}
            onClose={() => setInventoryOpen(false)}
          />
        )}
        {menu && menu.mapId === projection.map.id && (
          <MapActions
            projection={projection}
            ids={menu.ids}
            position={menu}
            disabled={disabled}
            onAction={(action) => onAction?.(action)}
            onClose={() => setMenu(null)}
            onSay={onSelectNpc}
            onInspect={onInspectNpc}
            onApproach={onApproach ?? onMove}
          />
        )}

        {failed && (
          <p className={styles.canvasFallback} role="status">
            {itemText('unavailable')}{' '}
          </p>
        )}
        <div className={styles.mapTools}>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(MAX_MAP_ZOOM, value + 0.2))}
            disabled={zoom >= MAX_MAP_ZOOM}
            aria-label={t('Увеличить карту')}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(MIN_MAP_ZOOM, value - 0.2))}
            disabled={zoom <= MIN_MAP_ZOOM}
            aria-label={t('Уменьшить карту')}
          >
            −
          </button>
          <button type="button" onClick={() => setZoom(1)} aria-label={t('Центрировать камеру')}>
            ◎
          </button>
        </div>
      </div>
      {projection.map.sceneProfile && <small>{objectiveText.art}</small>}
      <div className={styles.controls}>
        <p id="game-controls-help">{itemText('help')} </p>
        <div className={styles.dpad}>
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
