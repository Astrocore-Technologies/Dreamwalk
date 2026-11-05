'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MapPin, Paintbrush, UserRound } from 'lucide-react';
import type { AuthoredGameDraft, GameProjection, VisualPackage } from '@dreamwalk/contracts';
import { api, ApiError, errorMessage, useResource, useClient, type Hero } from '@/lib/client';
import {
  Button,
  ButtonLink,
  ErrorBox,
  Field,
  Input,
  PageHeading,
  Select,
  Textarea,
  UploadField,
} from '../ui';
import { CampaignObjectives } from '../game/campaign-objectives';
import { GameCanvas } from '../game/game-canvas';
import type { VisibleArtBinding } from '../assets/use-campaign-art';
import { useVisualText, type VisualMessage } from './messages';
import { LiveTestPanel, useLiveTestStatus } from '../live-test/live-test-panel';
import { ExternalGeneration } from './external-generation';
import { admittedConcept, type GenerationState } from './generation-types';
import { useGenerationText } from './generation-messages';
import { SpatialPlanner } from './spatial-planner';
import { useSpatialText } from './spatial-messages';
import styles from './workshop.module.css';

type Project = {
  id: string;
  kind: 'character' | 'location';
  name: string;
  sourceHash: string;
  status: 'concept' | 'approved' | 'ready' | 'cancelled';
  revision: number;
  provider?: 'fixture' | 'external';
  generationReady?: boolean;
  planProvenance?: 'deterministic-editable-template' | 'ai-pending' | 'ai-generated-plan';
  conceptUrl: string | null;
  plan: AuthoredGameDraft | null;
  projection: GameProjection | null;
  frames?: GameProjection[];
};
type Package = VisualPackage & { unavailable?: boolean };
const file = (id: string) => `/api/v1/asset-library/revisions/${id}/file`;

export function CharacterMotionPreview({ pack }: { pack: VisualPackage }) {
  const m = useVisualText();
  const [direction, setDirection] = useState(0),
    [walk, setWalk] = useState(true),
    [frame, setFrame] = useState(0);
  const sheet = pack.parts.find((p) => p.role === 'sheet');
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), walk ? 125 : 700);
    return () => clearInterval(timer);
  }, [walk]);
  if (!sheet) return <p>{m('approved')}</p>;
  const col = walk ? 2 + (frame % 4) : frame % 2;
  return (
    <div>
      <p>{m('sheet')}</p>
      <div
        role="img"
        aria-label={m('sheet')}
        className={styles.sprite}
        style={{
          backgroundImage: `url("${file(sheet.revisionId)}")`,
          backgroundSize: '768px 768px',
          backgroundPosition: `${-col * 128}px ${-direction * 192}px`,
        }}
      />
      <div className={styles.toolbar}>
        <Select
          aria-label={m('direction')}
          value={direction}
          onChange={(e) => setDirection(Number(e.target.value))}
        >
          {['↓', '←', '→', '↑'].map((d, i) => (
            <option key={i} value={i}>
              {d}
            </option>
          ))}
        </Select>
        <Button type="button" variant="secondary" onClick={() => setWalk(!walk)}>
          {m(walk ? 'idle' : 'walk')}
        </Button>
      </div>
    </div>
  );
}
export function VisualWorkshop() {
  const g = useGenerationText(),
    spatial = useSpatialText();
  const [spatialMode, setSpatialMode] = useState<'ai' | 'manual'>('ai');
  const [plannerBusy, setPlannerBusy] = useState(false),
    [liveVersion, setLiveVersion] = useState(0);
  const [editingMapId, setEditingMapId] = useState('');
  const [generationMode, setGenerationMode] = useState<'fixture' | 'external'>('fixture');
  const generationModeChosen = useRef(false);
  const { user } = useClient();
  const live = useLiveTestStatus();
  const liveStatus = live.status;
  const [generationState, setGenerationState] = useState<GenerationState | null>(null);
  const [generationBusy, setGenerationBusy] = useState(false);

  const m = useVisualText(),
    params = useSearchParams();
  const adventureId = params.get('adventureId');
  const [kind, setKind] = useState<'character' | 'location'>(
    adventureId ? 'location' : 'character',
  );
  const [name, setName] = useState(adventureId ? 'Rainlight Atelier' : 'Lyra');
  const [description, setDescription] = useState(''),
    [outfit, setOutfit] = useState('Emerald cloak, embroidered coat, boots, satchel');
  const [appearance, setAppearance] = useState(''),
    [source, setSource] = useState<'text' | 'photo'>('text');
  const [photoId, setPhotoId] = useState(''),
    [photoConsent, setPhotoConsent] = useState(false),
    [reuse, setReuse] = useState(false);
  const [project, setProject] = useState<Project | null>(null),
    [pack, setPack] = useState<Package | null>(null);
  const [projection, setProjection] = useState<GameProjection | null>(null);
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null),
    mounted = useRef(true),
    playback = useRef<ReturnType<typeof setTimeout>[]>([]);
  const packages = useResource<Package[]>('/visual-authoring/packages'),
    projects = useResource<Project[]>('/visual-authoring/projects');
  const heroes = useResource<Hero[]>('/heroes');
  const npcs = useResource<{ id: string; name: string }[]>('/npcs');
  const [targetType, setTargetType] = useState<'hero' | 'npc'>('hero');
  const [heroId, setHeroId] = useState(params.get('heroId') ?? ''),
    [replace, setReplace] = useState(false);
  const [layerId, setLayerId] = useState('worktable'),
    [layerX, setLayerX] = useState(3),
    [layerY, setLayerY] = useState(4),
    [visual, setVisual] = useState('table');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playback.current.forEach(clearTimeout);
    };
  }, []);
  useEffect(() => {
    setProjection(project?.projection ?? null);
  }, [project]);
  async function run<T>(path: string, body: object, after: (result: T) => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const key = JSON.stringify({ path, body });
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    try {
      const result = await api<T>(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: pending.current.id }),
      });
      pending.current = null;
      if (mounted.current) {
        after(result);
        packages.reload();
        projects.reload();
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof ApiError && e.code === 'STALE_STATE' ? m('sourceChanged') : errorMessage(e),
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const working = busy || generationBusy || plannerBusy;
  const editingMap =
    project?.plan?.maps.find((map) => map.id === editingMapId) ?? project?.plan?.maps[0];
  const editingLayer =
    editingMap?.composition?.layers.find((layer) => layer.id === layerId) ??
    editingMap?.composition?.layers[0];
  useEffect(() => {
    if (!editingMap || !editingLayer) return;
    setEditingMapId(editingMap.id);
    setLayerId(editingLayer.id);
    setLayerX(editingLayer.x);
    setLayerY(editingLayer.y);
    setVisual(editingLayer.visual);
  }, [editingMap?.id, editingLayer?.id, editingLayer?.x, editingLayer?.y, editingLayer?.visual]);
  const ownerReferencesUnavailable =
    generationMode === 'external' &&
    (liveStatus?.mode === 'owner' || liveStatus?.mode === 'release') &&
    liveStatus.imageConfiguration?.requestProfile?.maxReferenceImages === 0;
  const unsupportedPhoto = kind === 'character' && source === 'photo' && ownerReferencesUnavailable;
  const external = project?.provider === 'external';
  const generation =
    generationState?.projectId === project?.id &&
    generationState?.projectRevision === project?.revision
      ? generationState
      : null;
  useEffect(() => {
    if (
      (liveStatus?.mode === 'owner' || liveStatus?.mode === 'release') &&
      !generationModeChosen.current &&
      !project
    )
      setGenerationMode('external');
  }, [liveStatus?.mode, project]);
  function selectProject(p: Project) {
    generationModeChosen.current = true;
    setGenerationMode(p.provider ?? 'fixture');
    setSpatialMode(p.planProvenance === 'deterministic-editable-template' ? 'manual' : 'ai');
    setGenerationState(null);
    playback.current.forEach(clearTimeout);
    setProject(p);
    setPack(null);
    setError('');
    setNotice('');
  }
  async function refreshAppliedPlan() {
    if (!project) return;
    const current = await api<Project>(`/visual-authoring/projects/${project.id}`);
    if (mounted.current) {
      selectProject(current);
      projects.reload();
    }
  }
  async function preview(action: object) {
    if (!project) return;
    await run<Project>(
      `/visual-authoring/projects/${project.id}/preview`,
      { expectedRevision: project.revision, action },
      (p) => {
        setProject(p);
        playback.current.forEach(clearTimeout);
        const frames = p.frames ?? [];
        frames.forEach((frame, i) =>
          playback.current.push(
            setTimeout(() => {
              if (mounted.current) setProjection(frame);
            }, i * 100),
          ),
        );
      },
    );
  }
  const previewArt: VisibleArtBinding[] = (projection?.artBindings ?? []).map((b) => ({
    ...b,
    url: file(b.revisionId),
    attribution: 'Dreamwalk',
    licenseLabel: external ? g('externalArtwork') : 'Dreamwalk original fixture',
  }));
  const currentPack =
    pack ??
    (project
      ? packages.data?.find((p) => p.projectId === project.id && project.status === 'ready')
      : null);
  return (
    <div className={styles.workshop} data-workshop-kind={kind}>
      <PageHeading
        eyebrow="DREAMWALK · DRAWN 2D"
        title={m('title')}
        description={m('intro')}
        action={
          adventureId ? (
            <ButtonLink href={`/studio/adventures/${adventureId}`}>{m('back')}</ButtonLink>
          ) : undefined
        }
      />
      <p className={styles.note}>
        {generationMode === 'fixture' ? m('fixture') : g('externalNote')}
      </p>
      {user?.role === 'admin' && (
        <LiveTestPanel key={liveVersion} onStatusChange={live.setStatus} />
      )}
      <ErrorBox message={error} />
      {notice && (
        <p role="status" className={styles.note}>
          {notice}
        </p>
      )}
      <div className={styles.kindSwitch} role="group" aria-label={m('title')}>
        <Button
          type="button"
          disabled={working}
          variant={kind === 'character' ? 'primary' : 'secondary'}
          aria-pressed={kind === 'character'}
          onClick={() => {
            setKind('character');
            setName('Lyra');
          }}
        >
          <UserRound size={24} aria-hidden="true" />
          {m('character')}
        </Button>
        <Button
          type="button"
          disabled={working}
          variant={kind === 'location' ? 'primary' : 'secondary'}
          aria-pressed={kind === 'location'}
          onClick={() => {
            setKind('location');
            setName('Rainlight Atelier');
          }}
        >
          <MapPin size={24} aria-hidden="true" />
          {m('location')}
        </Button>
      </div>
      <div className={styles.layout}>
        <form
          className={`${styles.form} ${styles.brief}`}
          data-workshop-brief
          onSubmit={(e) => {
            e.preventDefault();
            if (unsupportedPhoto) {
              setError(g('ownerReferencesUnavailable'));
              return;
            }
            void run<Project>(
              '/visual-authoring/projects',
              {
                kind,
                generationMode,
                ...(kind === 'location' && generationMode === 'external' ? { spatialMode } : {}),
                ...(kind === 'location' ? { adventureId } : {}),
                brief: {
                  name,
                  description:
                    description || m(kind === 'character' ? 'defaultHero' : 'defaultLocation'),
                  style: 'drawn2D',
                  ...(kind === 'character'
                    ? {
                        outfit,
                        appearance,
                        source,
                        ...(source === 'photo'
                          ? { sourcePhotoAssetId: photoId, sourcePhotoPermission: photoConsent }
                          : {}),
                        allowOutputReuse: reuse,
                      }
                    : {}),
                },
              },
              selectProject,
            );
          }}
        >
          <fieldset disabled={working} className="stack" style={{ border: 0, padding: 0 }}>
            <Field label={g('mode')}>
              <Select
                aria-label={g('mode')}
                value={generationMode}
                onChange={(e) => {
                  generationModeChosen.current = true;
                  setGenerationMode(e.target.value as 'fixture' | 'external');
                }}
              >
                <option value="fixture">{g('fixture')}</option>
                <option value="external">{g('external')}</option>
              </Select>
            </Field>
            {kind === 'location' && generationMode === 'external' && (
              <Field label={spatial('mode')}>
                <Select
                  aria-label={spatial('mode')}
                  value={spatialMode}
                  onChange={(e) => setSpatialMode(e.target.value as 'ai' | 'manual')}
                >
                  <option value="ai">{spatial('ai')}</option>
                  <option value="manual">{spatial('manual')}</option>
                </Select>
              </Field>
            )}
            <Field label={m('name')}>
              <Input
                required
                minLength={2}
                maxLength={kind === 'character' ? 80 : 120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={m('description')}>
              <Textarea
                minLength={10}
                maxLength={2000}
                value={description}
                placeholder={m(kind === 'character' ? 'defaultHero' : 'defaultLocation')}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {kind === 'character' && (
              <>
                <Select
                  aria-label={m('character')}
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value as 'text' | 'photo');
                    setPhotoId('');
                    setPhotoConsent(false);
                  }}
                >
                  <option value="text">{m('text')}</option>
                  <option value="photo" disabled={ownerReferencesUnavailable}>
                    {m('photo')}
                  </option>
                </Select>
                {ownerReferencesUnavailable && (
                  <p role="status">{g('ownerReferencesUnavailable')}</p>
                )}
                {source === 'photo' && (
                  <>
                    <UploadField
                      label={m('upload')}
                      onUploaded={(a) => {
                        setPhotoId(a.id);
                        setPhotoConsent(false);
                      }}
                    />
                    {photoId && (
                      <img width={110} src={`/api/v1/assets/${photoId}/file`} alt={m('upload')} />
                    )}
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={photoConsent}
                        onChange={(e) => setPhotoConsent(e.target.checked)}
                      />
                      {m('photoConsent')}
                    </label>
                    <small>{m('private')}</small>
                    {generationMode === 'external' && <small>{g('photoTransfer')}</small>}
                  </>
                )}
                <Field label={m('outfit')}>
                  <Input
                    required
                    maxLength={500}
                    value={outfit}
                    onChange={(e) => setOutfit(e.target.value)}
                  />
                </Field>
                <Field label={m('appearance')}>
                  <Input
                    maxLength={500}
                    value={appearance}
                    onChange={(e) => setAppearance(e.target.value)}
                  />
                </Field>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={reuse}
                    onChange={(e) => setReuse(e.target.checked)}
                  />
                  {m('reuse')}
                </label>
              </>
            )}
            {kind === 'location' && !adventureId && <p>{m('story')}</p>}
            <Button
              type="submit"
              busy={working}
              disabled={
                unsupportedPhoto ||
                (kind === 'location' && !adventureId) ||
                (kind === 'character' && source === 'photo' && (!photoId || !photoConsent))
              }
            >
              {generationMode === 'fixture' ? m('create') : g('create')}
            </Button>
          </fieldset>
        </form>
        <div className={styles.preview} data-workshop-preview>
          {!project && !currentPack && (
            <div className={styles.emptyPreview}>
              <Paintbrush size={44} aria-hidden="true" />
              <h2>{m('previewEmpty')}</h2>
              <p>{m('previewEmptyHint')}</p>
            </div>
          )}
          {project && project.status !== 'cancelled' && (
            <>
              <h2>{m(project.kind === 'character' ? 'concept' : 'plan')}</h2>
              {(external
                ? generation?.items.find(
                    (item) => item.role === 'concept' && item.validation?.valid,
                  )?.url
                : project.conceptUrl) && (
                <div className={styles.concept}>
                  <img
                    src={
                      (external
                        ? generation?.items.find(
                            (item) => item.role === 'concept' && item.validation?.valid,
                          )?.url
                        : project.conceptUrl) ?? undefined
                    }
                    alt={project.name}
                  />
                </div>
              )}
              {project.kind === 'location' && external && (
                <p className={styles.note}>
                  {project.planProvenance === 'ai-pending'
                    ? spatial('pending')
                    : project.planProvenance === 'ai-generated-plan'
                      ? spatial('validated')
                      : g('plan')}
                </p>
              )}
              {project.kind === 'location' &&
                external &&
                project.planProvenance?.startsWith('ai-') && (
                  <SpatialPlanner
                    key={`spatial:${project.id}:${project.revision}`}
                    project={project}
                    session={liveStatus}
                    disabled={busy || generationBusy}
                    onBusyChange={setPlannerBusy}
                    onApplied={refreshAppliedPlan}
                    onBudgetRefresh={() => {
                      void live.refresh();
                      setLiveVersion((value) => value + 1);
                    }}
                  />
                )}
              {external && (project.kind === 'character' || project.status !== 'concept') && (
                <ExternalGeneration
                  key={`${project.id}:${project.revision}`}
                  project={project}
                  session={liveStatus}
                  disabled={busy}
                  onStateChange={setGenerationState}
                  onBusyChange={setGenerationBusy}
                />
              )}
              {projection && (
                <>
                  <p>
                    {m(project.status === 'ready' ? 'preview' : 'plan')} · {m('sandbox')}
                  </p>
                  <GameCanvas
                    projection={projection}
                    art={previewArt}
                    disabled={working}
                    reducedMotion={false}
                    onMove={(target) => void preview({ kind: 'move_to', target })}
                    onSelectNpc={() => {}}
                    onStop={() => {}}
                  />
                  <CampaignObjectives objectives={projection.objectives} />
                  <div className={styles.toolbar}>
                    {projection.entities
                      .filter((e) => e.kind === 'door')
                      .map((door) => (
                        <Button
                          key={door.id}
                          type="button"
                          disabled={working}
                          onClick={() =>
                            void preview({ kind: door.open ? 'close' : 'open', targetId: door.id })
                          }
                        >
                          {m(door.open ? 'closeDoor' : 'door')}
                        </Button>
                      ))}
                    {projection.map.exits.map((exit) => (
                      <Button
                        key={exit.id}
                        type="button"
                        variant="secondary"
                        disabled={working}
                        onClick={() => void preview({ kind: 'transition', targetId: exit.id })}
                      >
                        {m('transition')} · {exit.label ?? exit.id}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              {editingMap && editingLayer && project.status === 'concept' && (
                <div className={styles.form}>
                  <Field label={spatial('mapToEdit')}>
                    <Select
                      aria-label={spatial('mapToEdit')}
                      value={editingMap.id}
                      onChange={(e) => setEditingMapId(e.target.value)}
                    >
                      {project.plan?.maps.map((map) => (
                        <option key={map.id} value={map.id}>
                          {map.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={m('element')}>
                    <Select
                      aria-label={m('element')}
                      value={layerId}
                      onChange={(e) => {
                        setLayerId(e.target.value);
                        const l = editingMap.composition?.layers.find(
                          (l) => l.id === e.target.value,
                        );
                        if (l) {
                          setLayerX(l.x);
                          setLayerY(l.y);
                          setVisual(l.visual);
                        }
                      }}
                    >
                      {editingMap.composition?.layers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {m(l.visual)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className={styles.coordinates}>
                    <Field label={m('x')}>
                      <Input
                        type="number"
                        min={0}
                        max={Math.max(0, editingMap.width - editingLayer.width)}
                        value={layerX}
                        onChange={(e) => setLayerX(Number(e.target.value))}
                      />
                    </Field>
                    <Field label={m('y')}>
                      <Input
                        type="number"
                        min={0}
                        max={Math.max(0, editingMap.height - editingLayer.height)}
                        value={layerY}
                        onChange={(e) => setLayerY(Number(e.target.value))}
                      />
                    </Field>
                  </div>
                  <Field label={m('visual')}>
                    <Select
                      aria-label={m('visual')}
                      value={visual}
                      onChange={(e) => setVisual(e.target.value)}
                    >
                      {['table', 'counter', 'shelf', 'plant', 'rug'].map((v) => (
                        <option key={v} value={v}>
                          {m(v as VisualMessage)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    type="button"
                    disabled={working}
                    onClick={() =>
                      void run<Project>(
                        `/visual-authoring/projects/${project.id}/layers`,
                        {
                          expectedRevision: project.revision,
                          layerId,
                          mapId: editingMap.id,
                          point: { x: layerX, y: layerY },
                          visual,
                        },
                        setProject,
                      )
                    }
                  >
                    {m('move')}
                  </Button>
                </div>
              )}
              {external && project.kind === 'character' && !admittedConcept(generation) && (
                <p>{g('approveNeeded')}</p>
              )}
              {project.kind === 'location' && !project.plan && <p>{spatial('applyFirst')}</p>}
              {project.status === 'concept' && (
                <Button
                  type="button"
                  busy={working}
                  disabled={
                    (external && project.kind === 'character' && !admittedConcept(generation)) ||
                    (project.kind === 'location' && !project.plan)
                  }
                  onClick={() =>
                    void run<Project>(
                      `/visual-authoring/projects/${project.id}/approve`,
                      { expectedRevision: project.revision, consent: true },
                      setProject,
                    )
                  }
                >
                  {m('approve')}
                </Button>
              )}
              {project.status === 'approved' && (
                <>
                  <p>{m('approved')}</p>
                  {external && <p>{g('review')}</p>}
                  <Button
                    type="button"
                    busy={working}
                    disabled={external && !generation?.readyForReview}
                    onClick={() =>
                      void run<Package>(
                        `/visual-authoring/projects/${project.id}/complete`,
                        {
                          expectedRevision: project.revision,
                          consent: true,
                          ...(external ? { visualReview: true } : {}),
                        },
                        (p) => {
                          setPack(p);
                          void api<Project>(`/visual-authoring/projects/${project.id}`).then(
                            setProject,
                          );
                        },
                      )
                    }
                  >
                    {external ? g('complete') : m('assemble')}
                  </Button>
                </>
              )}
              {['concept', 'approved'].includes(project.status) && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={working}
                  onClick={() =>
                    void run(
                      `/visual-authoring/projects/${project.id}/cancel`,
                      { expectedRevision: project.revision },
                      () => {
                        setProject(null);
                        setPack(null);
                      },
                    )
                  }
                >
                  {m('cancel')}
                </Button>
              )}
            </>
          )}
          {currentPack && (
            <div className={styles.form}>
              <h2>
                {currentPack.name} · {m('ready')}
              </h2>
              {currentPack.unavailable ? (
                <p>{m('unavailable')}</p>
              ) : currentPack.kind === 'character' ? (
                <>
                  <div className={styles.parts}>
                    <img
                      src={file(currentPack.parts.find((p) => p.role === 'portrait')!.revisionId)}
                      alt={m('portrait')}
                    />
                    <CharacterMotionPreview key={currentPack.id} pack={currentPack} />
                  </div>
                  <Select
                    aria-label={m('target')}
                    value={targetType}
                    onChange={(e) => {
                      setTargetType(e.target.value as 'hero' | 'npc');
                      setHeroId('');
                    }}
                  >
                    <option value="hero">{m('playerHero')}</option>
                    <option value="npc">{m('authorNpc')}</option>
                  </Select>
                  <Select
                    aria-label={m('equip')}
                    value={heroId}
                    onChange={(e) => setHeroId(e.target.value)}
                  >
                    <option value="">{m('use')}</option>
                    {(targetType === 'hero' ? heroes.data : npcs.data)?.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    busy={working}
                    onClick={() => {
                      void run<{ targetId: string }>(
                        `/visual-authoring/packages/${currentPack.id}/equip`,
                        { ...(heroId ? { heroId } : { createTarget: true }), targetType },
                        (result) => {
                          setHeroId(result.targetId);
                          setNotice(m('applied'));
                          heroes.reload();
                          npcs.reload();
                        },
                      );
                    }}
                  >
                    {m('equip')}
                  </Button>
                </>
              ) : adventureId ? (
                <>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={replace}
                      onChange={(e) => setReplace(e.target.checked)}
                    />
                    {m('replace')}
                  </label>
                  <Button
                    type="button"
                    disabled={!replace || working}
                    onClick={() => {
                      void api<{ sourceHash: string }>(
                        `/visual-authoring/stories/${adventureId}/source`,
                      )
                        .then((source) =>
                          run(
                            `/visual-authoring/packages/${currentPack.id}/apply`,
                            {
                              adventureId,
                              expectedSourceHash: source.sourceHash,
                              replaceDraft: true,
                            },
                            () => setNotice(m('applied')),
                          ),
                        )
                        .catch((e) => setError(errorMessage(e)));
                    }}
                  >
                    {m('apply')}
                  </Button>
                </>
              ) : (
                <p>{m('story')}</p>
              )}
            </div>
          )}
        </div>
      </div>
      <h2>{m('library')}</h2>
      <ErrorBox
        message={packages.error || projects.error}
        retry={() => {
          packages.reload();
          projects.reload();
        }}
      />
      <div className={styles.library}>
        {packages.data?.map((p) => (
          <article className={styles.card} key={p.id}>
            <strong>
              {p.name} · {m('version')} {p.version}
            </strong>
            <span>
              {m(p.kind)} · {p.parts.length}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={working || p.unavailable}
              onClick={() => {
                setPack(p);
                if (p.kind === 'location')
                  void api<Project>(`/visual-authoring/projects/${p.projectId}`)
                    .then(setProject)
                    .catch((e) => setError(errorMessage(e)));
                else {
                  setProject(null);
                  setProjection(null);
                }
              }}
            >
              {m(p.unavailable ? 'unavailable' : 'use')}
            </Button>
          </article>
        ))}
      </div>
      <h2>{m('pending')}</h2>
      <div className={styles.library}>
        {projects.data
          ?.filter((p) => !['cancelled', 'ready'].includes(p.status))
          .map((p) => (
            <article className={styles.card} key={p.id}>
              <strong>{p.name}</strong>
              <Button
                type="button"
                variant="secondary"
                disabled={working}
                onClick={() => selectProject(p)}
              >
                {m('open')}
              </Button>
            </article>
          ))}
      </div>
    </div>
  );
}
