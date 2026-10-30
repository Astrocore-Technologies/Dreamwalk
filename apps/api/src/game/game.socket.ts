import type { Server } from 'node:http';
import type { Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { HttpException } from '@nestjs/common';
import { config } from '../config';
import { GameService } from './game.service';

/** Every outbound projection rechecks session and membership. No global event payload is broadcast. */
export function attachGameSockets(server: Server, game: GameService) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  game.onShutdown(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/v1/game/socket') return;
    const id = url.searchParams.get('campaignId') ?? '';
    if (req.headers.origin !== config.WEB_ORIGIN) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    void game
      .connected(req as Request, id)
      .then((access) => {
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          let busy = false,
            closed = false,
            revision = 0,
            last = '',
            requests = 0,
            windowStart = Date.now(),
            alive = true;
          const send = (data: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              if (ws.bufferedAmount > 131072) {
                ws.close(1013, 'Backpressure');
                return;
              }
              ws.send(JSON.stringify(data));
            }
          };
          const publish = async (force = false) => {
            if (busy || closed) return;
            busy = true;
            try {
              const snap = await game.snapshot(req as Request, id),
                serialized = JSON.stringify(snap.projection);
              if (snap.connectionEpoch !== access.connectionEpoch) {
                ws.close(4001, 'Control superseded');
                return;
              }
              if (force || serialized !== last) {
                const base = revision;
                revision = snap.projectionRevision;
                send({
                  ...snap,
                  type: force ? 'snapshot' : 'delta',
                  baseProjectionRevision: base,
                  projectionRevision: revision,
                });
                last = serialized;
                await game.delivered(id);
              }
            } catch {
              ws.close(1008, 'Access expired');
            } finally {
              busy = false;
            }
          };
          const unsubscribe = game.subscribe((campaignId) => {
            if (campaignId === id) void publish();
          });
          // Covers session revocation even while simulation sleeps or no world change occurs.
          const authTimer = setInterval(() => {
            if (!alive) {
              ws.terminate();
              return;
            }
            alive = false;
            ws.ping();
            void publish();
          }, 1000);
          ws.on('pong', () => {
            alive = true;
          });
          authTimer.unref();
          ws.on('message', (bytes) => {
            if (Date.now() - windowStart >= 1000) {
              windowStart = Date.now();
              requests = 0;
            }
            if (++requests > 30) {
              send({ type: 'error', code: 'RATE_LIMITED' });
              return;
            }
            void (async () => {
              let body: Record<string, unknown>;
              try {
                body = JSON.parse(bytes.toString());
              } catch {
                send({ type: 'error', code: 'VALIDATION_FAILED' });
                return;
              }
              try {
                if (body.type === 'snapshot') {
                  await publish(true);
                  return;
                }
                if (body.type === 'stop') {
                  if (body.connectionEpoch !== access.connectionEpoch) {
                    send({ type: 'error', code: 'STALE_STATE' });
                    return;
                  }
                  await game.stop(req as Request, id, { connectionEpoch: body.connectionEpoch });
                } else if (body.type === 'move') {
                  const { type: _type, ...input } = body;
                  void _type;
                  if (input.connectionEpoch !== access.connectionEpoch) {
                    send({ type: 'error', code: 'STALE_STATE' });
                    return;
                  }
                  await game.move(req as Request, id, input);
                } else if (body.type === 'command') {
                  const { type: _type, command } = body;
                  void _type;
                  send({
                    type: 'operation.result',
                    result: await game.command(req as Request, id, command, access.connectionEpoch),
                  });
                } else {
                  send({ type: 'error', code: 'VALIDATION_FAILED' });
                  return;
                }
                await publish();
              } catch (error) {
                const response = error instanceof HttpException ? error.getResponse() : null;
                send({
                  type: 'error',
                  code:
                    response && typeof response === 'object' && 'code' in response
                      ? response.code
                      : 'VALIDATION_FAILED',
                });
              }
            })();
          });
          ws.on('close', () => {
            closed = true;
            unsubscribe();
            clearInterval(authTimer);
            void game.disconnected(id, access.actorId, access.connectionEpoch).catch(() => {});
          });
          ws.on('error', () => ws.close());
          void publish(true);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
      });
  });
  return wss;
}
