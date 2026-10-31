'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GameAction,
  GameEvent,
  GameIntentInput,
  GamePoint,
  GameProjection,
} from '@dreamwalk/contracts';
import { gameEnvelopeSchema, type GameEnvelope } from '@dreamwalk/contracts';
import { api, ApiError } from '@/lib/client';
import {
  canRetryEncounterBegin,
  encounterRetryContext,
  type EncounterRetryContext,
} from './encounter-retry';

export type CampaignSummary = {
  id: string;
  ownerId: string;
  playableVersion: string;
  status: string;
  membership: 'accepted' | 'pending';
  title?: string | null;
  sourceRevision?: number | null;
  playableVersionId?: string | null;
};
export type { GameEnvelope } from '@dreamwalk/contracts';
export type CommandBody = {
  protocolVersion: 1;
  operationId: string;
  expectedRevision?: number;
  type:
    | 'action'
    | 'encounter.begin'
    | 'encounter.intent'
    | 'encounter.join'
    | 'encounter.end'
    | 'npc.request'
    | 'npc.speech'
    | 'npc.promise';
  promiseId?: string;
  decision?: 'accept' | 'decline';
  topicId?: string;
  npcId?: string;
  speech?: { channel: 'say' | 'whisper'; text: string };
  encounterId?: string;
  action?: GameAction;
  intent?: GameIntentInput;
};
type CommandResult = {
  status: 'committed' | 'rejected';
  code?: string;
  operationId: string;
  projection?: GameProjection;
  events?: GameEvent[];
};
export function useGame(campaignId: string) {
  const [campaign, setCampaign] = useState<GameEnvelope['campaign']>();
  const [projection, setProjection] = useState<GameProjection | null>(null);
  const [connection, setConnection] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'superseded'
  >('connecting');
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<(GameEvent & { id: string })[]>([]);
  const [clockOffset, setClockOffset] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const connectionState = useRef(connection);
  connectionState.current = connection;
  const envelope = useRef<GameEnvelope | null>(null);
  const seq = useRef(0);
  const stopping = useRef(false);
  const queuedTarget = useRef<GamePoint | null>(null);
  const alive = useRef(false);
  const commandInFlight = useRef(false);
  const retry = useRef<{
    key: string;
    body: CommandBody;
    encounterStart: EncounterRetryContext | null;
    encounterRetries: number;
  } | null>(null);
  const path = `/game/campaigns/${encodeURIComponent(campaignId)}`;
  const accept = useCallback((input: unknown) => {
    const parsed = gameEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      setError('VALIDATION_FAILED');
      return;
    }
    const value = parsed.data;
    const previous = envelope.current;
    if (
      previous?.streamId === value.streamId &&
      value.projectionRevision < previous.projectionRevision
    )
      return;
    if (
      value.type === 'delta' &&
      previous?.streamId === value.streamId &&
      value.baseProjectionRevision !== undefined &&
      value.baseProjectionRevision !== previous.projectionRevision
    ) {
      socket.current?.send(JSON.stringify({ type: 'snapshot' }));
      return;
    }
    envelope.current = value;
    setCampaign(value.campaign);
    const self = value.projection.entities.find((entity) => entity.id === value.projection.actorId);
    seq.current = Math.max(seq.current, self?.lastInputSeq || 0);
    if (typeof value.serverNowMs === 'number') setClockOffset(value.serverNowMs - Date.now());
    setProjection(value.projection);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const value = await api<GameEnvelope>(`${path}/snapshot`);
      if (alive.current) {
        accept(value);
        return value;
      }
    } catch (err) {
      if (alive.current) {
        setError(err instanceof ApiError ? err.code : 'NETWORK_ERROR');
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          setProjection(null);
          envelope.current = null;
        }
      }
    }
  }, [path, accept]);
  useEffect(() => {
    alive.current = true;
    envelope.current = null;
    setProjection(null);
    setError('');
    setEvents([]);
    setConnection('connecting');
    let stopped = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    const connect = () => {
      if (stopped) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${location.host}/api/v1/game/socket?campaignId=${encodeURIComponent(campaignId)}`,
      );
      socket.current = ws;
      ws.onopen = () => {
        if (stopped) return;
        attempts = 0;
        setConnection('connected');
        if (poll) clearInterval(poll);
        poll = undefined;
        ws.send(JSON.stringify({ type: 'snapshot' }));
      };
      ws.onmessage = (event) => {
        if (stopped) return;
        try {
          const message = JSON.parse(String(event.data)) as GameEnvelope & { code?: string };
          if (message.type === 'snapshot' || message.type === 'delta') accept(message);
          else if (message.code) setError(message.code);
        } catch {
          setError('NETWORK_ERROR');
        }
      };
      ws.onclose = (event) => {
        if (stopped) return;
        if (event.code === 4001) {
          setConnection('superseded');
          clearInterval(poll);
          clearTimeout(reconnect);
          return;
        }
        setConnection('reconnecting');
        if ([1008, 4401, 4403].includes(event.code)) {
          setError('FORBIDDEN');
          setProjection(null);
          return;
        }
        if (!poll)
          poll = setInterval(() => {
            void refresh();
          }, 1500);
        reconnect = setTimeout(connect, Math.min(10000, 1000 * 2 ** Math.min(attempts++, 4)));
      };
      ws.onerror = () => {
        if (!stopped) setConnection('reconnecting');
      };
    };
    void refresh().then(() => {
      if (!stopped) connect();
    });
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(reconnect);
      clearInterval(poll);
      socket.current?.close();
      socket.current = null;
    };
  }, [campaignId, refresh, accept, reconnectVersion]);
  const transmitMove = useCallback(
    (target: GamePoint) => {
      const value = envelope.current;
      const self = value?.projection.entities.find(
        (entity) => entity.id === value.projection.actorId,
      );
      if (!value || !self || !alive.current) return;
      const body = {
        connectionEpoch: value.connectionEpoch,
        inputSeq: ++seq.current,
        movementGeneration: self.movementGeneration || 0,
        target,
      };
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: 'move', ...body }));
      else
        void api(`${path}/move`, { method: 'POST', body: JSON.stringify(body) })
          .then(() => refresh())
          .catch((err: unknown) => {
            if (alive.current) setError(err instanceof ApiError ? err.code : 'NETWORK_ERROR');
          });
    },
    [path, refresh],
  );
  const move = useCallback(
    (target: GamePoint) => {
      if (stopping.current) {
        queuedTarget.current = target;
        return;
      }
      transmitMove(target);
    },
    [transmitMove],
  );
  const stop = useCallback(() => {
    queuedTarget.current = null;
    const value = envelope.current;
    if (!value || stopping.current || socket.current?.readyState !== WebSocket.OPEN) return;
    stopping.current = true;
    void api<GameEnvelope>(`${path}/stop`, {
      method: 'POST',
      body: JSON.stringify({ connectionEpoch: value.connectionEpoch }),
    })
      .then((next) => {
        if (alive.current) accept(next);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(err instanceof ApiError ? err.code : 'NETWORK_ERROR');
      })
      .finally(() => {
        stopping.current = false;
        const target = queuedTarget.current;
        queuedTarget.current = null;
        if (target && alive.current) transmitMove(target);
      });
  }, [path, accept, transmitMove]);
  const command = useCallback(
    async (body: Omit<CommandBody, 'protocolVersion' | 'operationId'>) => {
      if (commandInFlight.current) return false;
      commandInFlight.current = true;
      const key = JSON.stringify(body);
      let request: CommandBody =
        retry.current?.key === key
          ? retry.current.body
          : {
              protocolVersion: 1,
              operationId: crypto.randomUUID(),
              expectedRevision: envelope.current?.projection.revision,
              ...body,
            };
      const encounterStart =
        retry.current?.key === key
          ? retry.current.encounterStart
          : encounterRetryContext(envelope.current);
      let encounterRetries = retry.current?.key === key ? retry.current.encounterRetries : 0;
      const initialSocket = socket.current;
      retry.current = { key, body: request, encounterStart, encounterRetries };
      setBusy(true);
      setError('');
      try {
        let result = await api<CommandResult>(`${path}/commands`, {
          method: 'POST',
          body: JSON.stringify(request),
        });
        // A known rejection has made no world change. Never replay unknown network outcomes here.
        if (
          request.type === 'encounter.begin' &&
          result.status === 'rejected' &&
          result.code === 'STALE_STATE'
        ) {
          const refreshed = await refresh();
          const after = encounterRetryContext(envelope.current);
          if (
            refreshed &&
            canRetryEncounterBegin({
              type: request.type,
              status: result.status,
              code: result.code,
              attempts: encounterRetries,
              before: encounterStart,
              after,
              connected:
                connectionState.current === 'connected' &&
                alive.current &&
                socket.current === initialSocket &&
                initialSocket?.readyState === WebSocket.OPEN,
            })
          ) {
            encounterRetries++;
            request = {
              ...request,
              operationId: crypto.randomUUID(),
              expectedRevision: after!.revision,
            };
            // Preserve this new operation ID if its outcome is unknown. No third attempt is allowed.
            retry.current = { key, body: request, encounterStart, encounterRetries };
            result = await api<CommandResult>(`${path}/commands`, {
              method: 'POST',
              body: JSON.stringify(request),
            });
          }
        }
        retry.current = null;
        if (!alive.current) return false;
        if (result.status === 'rejected') setError(result.code || 'INVALID_ACTION');
        if (result.events?.length)
          setEvents((previous) =>
            [
              ...previous,
              ...result.events!.map((event, index) => ({
                ...event,
                id: `${result.operationId}:${index}`,
              })),
            ].slice(-40),
          );
        await refresh();
        return result.status === 'committed';
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) retry.current = null;
        if (alive.current) setError(err instanceof ApiError ? err.code : 'NETWORK_ERROR');
        return false;
      } finally {
        commandInFlight.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [path, refresh],
  );
  return {
    projection,
    campaign,
    connection,
    error,
    setError,
    busy,
    events,
    clockOffset,
    move,
    stop,
    command,
    refresh,
    reconnect: () => setReconnectVersion((value) => value + 1),
  };
}
