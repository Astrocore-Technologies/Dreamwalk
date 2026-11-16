'use client';
import { useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { ErrorBox, Loading, Panel } from '../ui';

interface TurnCostReport {
  days: number;
  turns: number;
  paidTurns: number;
  failedShare: number;
  callsPerTurn: number | null;
  inputTokensPerTurn: number | null;
  outputTokensPerTurn: number | null;
  apiCentsPerTurn: { average: number | null; median: number | null; p90: number | null };
  secondsPerTurn: { median: number | null; p90: number | null };
  starterGrant: { dreams: number; turns: number | null };
  recent: {
    key: string;
    startedAt: string;
    calls: number;
    cachedCalls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    apiCents: number;
    seconds: number | null;
  }[];
}
const messages = {
  ru: {
    title: 'Стоимость хода',
    hint: 'Реальные данные из ИИ-вызовов за последние 7 дней. Ход — всё, что запустило одно сообщение игрока.',
    turns: 'Ходов',
    calls: 'Вызовов на ход',
    cents: 'Стоимость хода (цент API)',
    seconds: 'Время хода (с)',
    tokens: 'Токенов на ход (вход / выход)',
    failed: 'Доля ходов с ошибкой',
    starter: 'Хватит стартовых {dreams} грёз на ходов',
    p90: 'p90',
    average: 'среднее',
    median: 'медиана',
    recent: 'Последние ходы',
    when: 'Когда',
    cached: 'из кэша',
    empty: 'За период нет ходов с ИИ.',
    none: '—',
  },
  uk: {
    title: 'Вартість ходу',
    hint: 'Реальні дані з ШІ-викликів за останні 7 днів. Хід — усе, що запустило одне повідомлення гравця.',
    turns: 'Ходів',
    calls: 'Викликів на хід',
    cents: 'Вартість ходу (цент API)',
    seconds: 'Час ходу (с)',
    tokens: 'Токенів на хід (вхід / вихід)',
    failed: 'Частка ходів з помилкою',
    starter: 'Вистачить стартових {dreams} мрій на ходів',
    p90: 'p90',
    average: 'середнє',
    median: 'медіана',
    recent: 'Останні ходи',
    when: 'Коли',
    cached: 'з кешу',
    empty: 'За період немає ходів з ШІ.',
    none: '—',
  },
  en: {
    title: 'Turn cost',
    hint: 'Real data from AI calls over the last 7 days. A turn is everything one player message set off.',
    turns: 'Turns',
    calls: 'Calls per turn',
    cents: 'Turn cost (API cents)',
    seconds: 'Turn time (s)',
    tokens: 'Tokens per turn (in / out)',
    failed: 'Share of turns with an error',
    starter: 'Turns the starter {dreams} Dreams cover',
    p90: 'p90',
    average: 'average',
    median: 'median',
    recent: 'Recent turns',
    when: 'When',
    cached: 'cached',
    empty: 'No AI turns in this period.',
    none: '—',
  },
};
export function AdminTurnCosts() {
  const { locale } = useT();
  const text = messages[locale];
  const report = useResource<TurnCostReport>('/admin/turn-costs?days=7');
  const format = (value: number | null, digits = 2) =>
    value === null ? text.none : value.toLocaleString(locale, { maximumFractionDigits: digits });
  if (report.loading && !report.data) return <Loading />;
  if (report.error || !report.data) return <ErrorBox message={report.error} />;
  const data = report.data;
  return (
    <Panel>
      <h2>{text.title}</h2>
      <p className="muted">{text.hint}</p>
      {!data.turns ? (
        <p>{text.empty}</p>
      ) : (
        <>
          <dl className="admin-stats" data-testid="turn-costs">
            <div>
              <dt>{text.turns}</dt>
              <dd>{data.turns}</dd>
            </div>
            <div>
              <dt>{text.calls}</dt>
              <dd>{format(data.callsPerTurn, 1)}</dd>
            </div>
            <div>
              <dt>{text.cents}</dt>
              <dd>
                {text.average} {format(data.apiCentsPerTurn.average, 2)} · {text.median}{' '}
                {format(data.apiCentsPerTurn.median, 2)} {' · '}
                {text.p90} {format(data.apiCentsPerTurn.p90, 2)}
              </dd>
            </div>
            <div>
              <dt>{text.seconds}</dt>
              <dd>
                {text.median} {format(data.secondsPerTurn.median, 1)} {' · '}
                {text.p90} {format(data.secondsPerTurn.p90, 1)}
              </dd>
            </div>
            <div>
              <dt>{text.tokens}</dt>
              <dd>
                {format(data.inputTokensPerTurn, 0)} / {format(data.outputTokensPerTurn, 0)}
              </dd>
            </div>
            <div>
              <dt>{text.failed}</dt>
              <dd>{format(data.failedShare * 100, 1)}%</dd>
            </div>
            <div>
              <dt>{text.starter.replace('{dreams}', String(data.starterGrant.dreams))}</dt>
              <dd>{data.starterGrant.turns ?? text.none}</dd>
            </div>
          </dl>
          <h3>{text.recent}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{text.when}</th>
                  <th>{text.calls}</th>
                  <th>{text.cents}</th>
                  <th>{text.seconds}</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((turn) => (
                  <tr key={turn.key}>
                    <td>{new Date(turn.startedAt).toLocaleString(locale)}</td>
                    <td>
                      {turn.calls}
                      {turn.cachedCalls ? ` (${turn.cachedCalls} ${text.cached})` : ''}
                    </td>
                    <td>{format(turn.apiCents, 2)}</td>
                    <td>{format(turn.seconds, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
