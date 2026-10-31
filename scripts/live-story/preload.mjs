/** Loaded only by the explicitly gated live-evaluation child process. */
import { createPgStoryGuard } from './pg-guard.mjs';
if (
  process.env.LIVE_STORY_CHILD_APPROVED !== 'text-only-four-requests-carried-10769' ||
  !process.env.DATABASE_URL
)
  throw Error('LIVE_CHILD_NOT_APPROVED');
const transport =
  process.env.LIVE_STORY_FIXTURE_MODE === 'true'
    ? async (_url, init) => {
        const body = JSON.parse(init.body),
          { purpose, context } = JSON.parse(body.input);
        let proposal;
        if (purpose === 'narrative') {
          const connection = context.availableConnections[0];
          if (!connection) throw Error('FIXTURE_NO_CONNECTION');
          const next = context.canonRevision + 1;
          proposal = {
            narration: `Подтверждённый этап ${next}: путь к мастерской продолжается.`,
            newScene: {
              name: `Мастерская ${next}`,
              description: 'Комната реставрации инструментов обсерватории.',
              template: 'room',
              connection: { fromMapId: context.currentScene.id, x: connection.x, y: connection.y },
            },
            newNpc:
              next === 1
                ? {
                    name: 'Иона',
                    roleLabel: 'Реставратор инструментов',
                    description: 'Помогает восстанавливать приборы.',
                    appearance: 'Рабочий фартук.',
                    personalitySummary: 'Спокойная и внимательная.',
                    values: ['duty'],
                    publicSpeechStyle: 'warm',
                    goal: 'patrol',
                    placement: 'new_scene',
                    spawn: { x: 4, y: 3 },
                    knownEntityIds: [],
                  }
                : null,
            actions: [],
            evidenceIds: context.evidenceIds.slice(-1),
          };
        } else
          proposal = {
            text: `Я ${context.publicIdentity?.name ?? 'помощник'}, ${context.publicIdentity?.role ?? 'реставратор'}. Мы говорили о «Серебряном маяке».`,
          };
        return new Response(
          JSON.stringify({
            id: `fixture-${new Headers(init.headers).get('x-client-request-id')}`,
            status: 'completed',
            service_tier: 'default',
            usage: { input_tokens: 100, output_tokens: 100 },
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify(proposal) }],
              },
            ],
          }),
        );
      }
    : globalThis.fetch.bind(globalThis);
const guard = await createPgStoryGuard(process.env.DATABASE_URL, transport, {
  initialize: process.env.LIVE_STORY_LEDGER_INITIALIZE === 'true',
});
globalThis.fetch = (...args) => guard.fetch(...args);
// Never remove the guard lock on an unexpected exit: ambiguous exposure needs review.
process.on('SIGTERM', () => {
  void guard.close().then(() => process.exit(0));
});
