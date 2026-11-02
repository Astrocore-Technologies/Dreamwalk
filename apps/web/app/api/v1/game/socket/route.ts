import { upgradeWebSocket } from '@vercel/functions';
import { openGameSocketRelay, socketRelayTarget } from '@/lib/game-socket-relay';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (process.env.VERCEL !== '1') return new Response(null, { status: 404 });
  let target;
  try {
    target = socketRelayTarget(request, process.env);
  } catch {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!target) return new Response(null, { status: 404 });
  return upgradeWebSocket(
    (socket) => {
      openGameSocketRelay(socket, target);
    },
    { maxPayload: 8192 },
  );
}
