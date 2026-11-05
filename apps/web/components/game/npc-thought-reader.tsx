'use client';
import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui';
import { npcThoughtMessages } from './npc-thought-messages';
import styles from './npc-public-inspection.module.css';

/** Separate authorized DTO: never a field on the shared world projection or story feed. */
export type NpcInnerThoughtResponse = {
  npcId: string;
  thought: null | {
    text: string;
    roundId: string | null;
    roundNumber: number | null;
    tick: number;
  };
};

export function NpcThoughtReader({ campaignId, npcId }: { campaignId: string; npcId: string }) {
  const { locale } = useT();
  const text = npcThoughtMessages[locale];
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div className={styles.thoughtReader} data-testid="npc-thought-reader">
      <Button
        type="button"
        variant="secondary"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        {text.open}
      </Button>
      <div id={contentId} hidden={!open}>
        {open && <ThoughtContent campaignId={campaignId} npcId={npcId} />}
      </div>
    </div>
  );
}

function ThoughtContent({ campaignId, npcId }: { campaignId: string; npcId: string }) {
  const { locale } = useT();
  const text = npcThoughtMessages[locale];
  const [result, setResult] = useState<NpcInnerThoughtResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult(null);
    setFailed(false);
    void api<NpcInnerThoughtResponse>(
      `/game/campaigns/${encodeURIComponent(campaignId)}/npcs/${encodeURIComponent(npcId)}/inner-thought`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then((value) => {
        if (!active) return;
        if (value.npcId !== npcId) throw new Error('Unexpected NPC');
        setResult(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [campaignId, npcId, attempt]);
  return (
    <div aria-live="polite" aria-busy={!result && !failed}>
      <p className={styles.thoughtProvenance}>{text.provenance}</p>
      {failed ? (
        <p role="status">{text.unavailable}</p>
      ) : !result ? (
        <p role="status">{text.loading}</p>
      ) : result.thought ? (
        <>
          <p data-testid="npc-inner-thought">{result.thought.text}</p>
          <small>
            {text.round} {result.thought.roundNumber} · {text.tick} {result.thought.tick}
          </small>
        </>
      ) : (
        <p role="status">{text.empty}</p>
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={!result && !failed}
        onClick={() => setAttempt((value) => value + 1)}
      >
        {failed ? text.retry : text.refresh}
      </Button>
    </div>
  );
}
