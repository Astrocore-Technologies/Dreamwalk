/**
 * Real cost and speed of a played turn, from the AI jobs the game already records. One "turn" is
 * everything one player message set off: the director call plus every character reply.
 * Pure over plain rows so it can be tested without a database.
 */
export interface TurnJobRow {
  key: string;
  started: Date | string;
  finished: Date | string | null;
  calls: number | string;
  in_tokens: number | string | null;
  out_tokens: number | string | null;
  micros: number | string | null;
  failed: number | string;
  cached: number | string;
}
export interface TurnCost {
  key: string;
  startedAt: string;
  calls: number;
  cachedCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  apiCents: number;
  seconds: number | null;
}
const STARTER_DREAMS = 50;
const UNITS_PER_API_CENT = 2;
const num = (value: unknown) => Number(value ?? 0) || 0;
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index),
    high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};
const round = (value: number | null, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export function summarizeTurnCosts(rows: TurnJobRow[]) {
  const turns: TurnCost[] = rows.map((row) => {
    const started = new Date(row.started).getTime(),
      finished = row.finished ? new Date(row.finished).getTime() : null;
    return {
      key: row.key,
      startedAt: new Date(row.started).toISOString(),
      calls: num(row.calls),
      cachedCalls: num(row.cached),
      failedCalls: num(row.failed),
      inputTokens: num(row.in_tokens),
      outputTokens: num(row.out_tokens),
      // Provider cost is in micro-dollars: 10 000 per cent.
      apiCents: num(row.micros) / 10000,
      seconds: finished && finished >= started ? (finished - started) / 1000 : null,
    };
  });
  const paid = turns.filter((turn) => turn.apiCents > 0);
  const cents = paid.map((turn) => turn.apiCents);
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const seconds = turns.flatMap((turn) => (turn.seconds === null ? [] : [turn.seconds]));
  const averageCents = mean(cents);
  return {
    turns: turns.length,
    paidTurns: paid.length,
    failedShare: turns.length
      ? round(turns.filter((turn) => turn.failedCalls > 0).length / turns.length, 3)
      : 0,
    callsPerTurn: round(mean(turns.map((turn) => turn.calls))),
    inputTokensPerTurn: round(mean(turns.map((turn) => turn.inputTokens)), 0),
    outputTokensPerTurn: round(mean(turns.map((turn) => turn.outputTokens)), 0),
    apiCentsPerTurn: {
      average: round(averageCents, 3),
      median: round(percentile(cents, 0.5), 3),
      p90: round(percentile(cents, 0.9), 3),
    },
    secondsPerTurn: {
      median: round(percentile(seconds, 0.5), 1),
      p90: round(percentile(seconds, 0.9), 1),
    },
    // The starter grant is 50 Dreams and 2 units pay for one API cent.
    starterGrant: {
      dreams: STARTER_DREAMS,
      turns: averageCents ? Math.floor(STARTER_DREAMS / UNITS_PER_API_CENT / averageCents) : null,
    },
    recent: turns.slice(0, 20),
  };
}
