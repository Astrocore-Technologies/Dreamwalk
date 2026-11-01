'use client';
import { useT } from '@/lib/i18n';
import { formatUsd } from './types';
import { useLiveText, type LiveMessage } from './messages';
import type { RequestEstimateSnapshot, TextRequestEstimateSnapshot } from './request-reserve-types';
import styles from './live-test.module.css';
export function RequestReserve({ snapshot }: { snapshot: RequestEstimateSnapshot }) {
  const m = useLiveText(),
    { locale } = useT();
  const rows: [LiveMessage, number | null][] = [
    ['reserveEstimate', snapshot.estimatedTotalMicros],
    ['reserveTextInput', snapshot.inputTextMicros],
    ['reserveImageInput', snapshot.inputImageMicros],
    ['reserveImageOutput', snapshot.outputImageMicros],
    ['reserveMargin', snapshot.percentageMarginMicros],
    ['reserveFixed', snapshot.fixedMarginMicros],
    ['reserveReferences', snapshot.referenceAllowanceMicros],
    ['reserveTotal', snapshot.reserveMicros],
  ];
  return (
    <section
      className={styles.request}
      aria-label={m('reserveTitle')}
      data-testid="request-reserve"
    >
      <h4>{m('reserveTitle')}</h4>
      {snapshot.basis === 'legacy_fixed' && <p>{m('reserveLegacy')}</p>}
      <dl className={styles.budget}>
        {rows
          .filter(
            (row): row is [LiveMessage, number] =>
              typeof row[1] === 'number' && Number.isFinite(row[1]),
          )
          .map(([label, value]) => (
            <div key={label}>
              <dt>
                {m(label)}
                {label === 'reserveMargin' && typeof snapshot.marginBps === 'number'
                  ? ' (' + String(snapshot.marginBps / 100) + '%)'
                  : ''}
              </dt>
              <dd>{formatUsd(value, locale)}</dd>
            </div>
          ))}
      </dl>
      <p>{m('reserveNotCap')}</p>
      {snapshot.uncertainReferences && <p role="status">{m('reserveReferenceRisk')}</p>}
      <small>
        {m('reservePrompt')}: {snapshot.promptUtf8Bytes} · {m('reserveReferenceCount')}:{' '}
        {snapshot.referenceCount}
      </small>
    </section>
  );
}

export function TextRequestReserve({ snapshot }: { snapshot: TextRequestEstimateSnapshot }) {
  const m = useLiveText(),
    { locale } = useT();
  const rows: [LiveMessage, number][] = [
    ['reserveEstimate', snapshot.estimatedTotalMicros],
    ['reserveTextInput', snapshot.inputMicros],
    ['reserveTextOutput', snapshot.outputMicros],
    ['reserveMargin', snapshot.percentageMarginMicros],
    ['reserveFixed', snapshot.fixedMarginMicros],
    ['reserveTotal', snapshot.reserveMicros],
  ];
  return (
    <section
      className={styles.request}
      aria-label={m('reserveTitle')}
      data-testid="text-request-reserve"
    >
      <h4>{m('reserveTitle')}</h4>
      {snapshot.costBasis === 'legacy_fixed' && <p>{m('reserveLegacy')}</p>}
      <dl className={styles.budget}>
        {rows
          .filter((row) => typeof row[1] === 'number' && Number.isFinite(row[1]))
          .map(([label, value]) => (
            <div key={label}>
              <dt>
                {m(label)}
                {label === 'reserveMargin' ? ' (' + String(snapshot.marginBps / 100) + '%)' : ''}
              </dt>
              <dd>{formatUsd(value, locale)}</dd>
            </div>
          ))}
      </dl>
      <p>{m('reserveNotCap')}</p>
      {snapshot.contextWindow && (
        <section data-testid="text-context-window">
          <dl className={styles.budget}>
            {(
              [
                ['contextModelCapacity', snapshot.contextWindow.modelContextTokens],
                ['contextRequested', snapshot.contextWindow.requestedContextTokens],
                ['contextEffective', snapshot.contextWindow.effectiveContextTokens],
                ['contextAnswer', snapshot.contextWindow.reservedOutputTokens],
              ] as [LiveMessage, number][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{m(label)}</dt>
                <dd>{value.toLocaleString(locale)}</dd>
              </div>
            ))}
          </dl>
          <p>
            {m(snapshot.contextWindow.precision === 'exact' ? 'contextExact' : 'contextEstimate')}
          </p>
          <p>{m('contextHistory')}</p>
        </section>
      )}
      <small>
        {m('reserveBodyBytes')}: {snapshot.serializedBytes} · {m('reserveInputTokens')}:{' '}
        {snapshot.estimatedInputTokens} · {m('policyOutputTokens')}: {snapshot.maxOutputTokens}
      </small>
    </section>
  );
}
