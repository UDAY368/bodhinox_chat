'use client';

// Advisory lead score next to a contact's name in the contacts list. The
// scores of the contacts on screen are read in one request (at most 100 ids)
// for agents and above; viewers, restricted members and workspaces without
// assessments see nothing. A score is computed in code from qualification
// signals and CRM facts, never by the model; a health topic shows a
// route-to-staff marker instead.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';

export interface LeadScoreEntry {
  conversation_id: string;
  intent: string;
  intent_confidence: number;
  lead_score: number | null;
  source: 'model' | 'deterministic';
  route_to_staff: boolean;
  created_at: string;
}

const MAX_IDS = 100;

/** The stored assessments of the given contacts, keyed by contact id (empty when unavailable). */
export function useLeadScores(contactIds: readonly string[]): Record<string, LeadScoreEntry> {
  const canUse = useCan('send-messages');
  const [scores, setScores] = useState<Record<string, LeadScoreEntry>>({});
  const key = contactIds.slice(0, MAX_IDS).join(',');
  useEffect(() => {
    if (!canUse || !key) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`/api/ai/assess/contacts?ids=${encodeURIComponent(key)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { assessments?: Record<string, LeadScoreEntry> };
        if (!cancelled) setScores(body.assessments ?? {});
      } catch {
        // Advisory only: no scores on a failed read.
      }
    })();
    return () => { cancelled = true; };
  }, [canUse, key]);
  return canUse && key ? scores : {};
}

const tone = (score: number) =>
  score >= 70 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    : score >= 40 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      : 'bg-muted text-muted-foreground';

/** A small lead-score badge (or the route-to-staff marker); nothing without an assessment. */
export function LeadScoreCell({ entry }: { entry: LeadScoreEntry | undefined }) {
  const t = useTranslations('AiAssessment');
  if (!entry) return null;
  const intent = t.has(`intents.${entry.intent}`) ? t(`intents.${entry.intent}`) : entry.intent;
  if (entry.route_to_staff)
    return (
      <span className="text-destructive ml-2 inline-flex align-middle" title={t('routeToStaff')} aria-label={t('routeToStaff')}>
        <ShieldAlert className="size-3.5" aria-hidden />
      </span>
    );
  if (entry.lead_score === null) return null;
  return (
    <span
      className={cn('ml-2 inline-flex rounded-full px-1.5 py-0.5 align-middle text-[10px] font-semibold', tone(entry.lead_score))}
      title={t('leadScoreTitle', { score: entry.lead_score, intent })}
      aria-label={t('leadScoreTitle', { score: entry.lead_score, intent })}
    >
      {entry.lead_score}
    </span>
  );
}
