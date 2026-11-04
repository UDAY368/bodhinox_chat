'use client';

// Advisory AI assessment of the open conversation, in the contact sidebar.
// Shows the intent, a lead score computed in code, the qualification signals
// and when it was assessed. It never changes anything: tags and deals stay
// the human's job through the existing CRM controls. A health topic raises a
// route-to-staff banner. Hidden for viewers, for a member whose role is
// restricted from 'ai.assist', and when the workspace has assessments off and
// none was ever stored.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import { useCan } from '@/hooks/use-can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface AssessmentPanelData {
  intent: string;
  intent_confidence: number;
  lead_score: number | null;
  source: 'model' | 'deterministic';
  rationale: string;
  created_at: string;
  qualification: Record<string, unknown> & { route_to_staff?: boolean };
}

/** Re-reads after a queued refresh, until the stored assessment changes. */
export const REFRESH_POLL_DELAYS_MS = [3000, 6000, 12000] as const;

/**
 * Calls `read` after each delay (cumulative) until it reports a created_at
 * other than `before`. Returns a cancel function (unmount, conversation switch).
 */
export function pollAfterRefresh(
  read: () => Promise<string | null | undefined>,
  before: string | null,
  delays: readonly number[] = REFRESH_POLL_DELAYS_MS,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancelTimer: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): () => void {
  let cancelled = false;
  let handle: unknown = null;
  const step = (i: number) => {
    if (cancelled || i >= delays.length) return;
    handle = schedule(async () => {
      if (cancelled) return;
      const after = await read().catch(() => undefined);
      if (!cancelled && (after === undefined || after === before)) step(i + 1);
    }, delays[i]);
  };
  step(0);
  return () => { cancelled = true; if (handle !== null) cancelTimer(handle); };
}

const SIGNALS = ['asked_price', 'purchase_intent', 'booking_intent', 'timeline_mentioned', 'budget_mentioned', 'decision_maker', 'complaint'] as const;

interface AssessmentPanelProps {
  conversationId: string | null | undefined;
  /** Changes when new messages arrive, to re-read the stored assessment. */
  refreshToken?: string | number;
}

export function AssessmentPanel({ conversationId, refreshToken }: AssessmentPanelProps) {
  const t = useTranslations('AiAssessment');
  const canUse = useCan('send-messages');
  const [state, setState] = useState<{ enabled: boolean; assessment: AssessmentPanelData | null } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const stopPolling = useRef<(() => void) | null>(null);

  // Clear only when the conversation changes. A new message re-reads in
  // place, so the panel (and its role="alert" banner) is not unmounted and
  // announced again on every message.
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setState(null);
    setHidden(false);
  }

  /** Reads the stored assessment; returns its created_at (null when none, undefined when unread). */
  const load = useCallback(async (): Promise<string | null | undefined> => {
    if (!conversationId || !canUse) return undefined;
    const current = ++request.current;
    try {
      const res = await authFetch(`/api/ai/assess/conversation/${encodeURIComponent(conversationId)}`);
      if (current !== request.current) return undefined;
      if (res.status === 403 || res.status === 404) { setHidden(true); return undefined; }
      if (!res.ok) return undefined;
      setHidden(false);
      const next = await res.json();
      setState(next);
      return next?.assessment?.created_at ?? null;
    } catch {
      // Advisory only: a failed read leaves the panel as it was.
      return undefined;
    }
  }, [conversationId, canUse]);

  useEffect(() => {
    void load();
    return () => {
      // The counter tracks async requests, not a DOM element.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
    };
  }, [load, refreshToken]);

  // Stop any refresh polling on a conversation switch or unmount.
  useEffect(() => () => { stopPolling.current?.(); stopPolling.current = null; }, [conversationId]);

  if (!conversationId || !canUse || hidden || !state) return null;
  const { enabled, assessment } = state;
  if (!enabled && !assessment) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/ai/assess/conversation/${encodeURIComponent(conversationId)}/refresh`, { method: 'POST' });
      if (res.status === 202) {
        toast.success(t('queued'));
        // The worker writes the new assessment shortly: re-read a few times until it lands.
        stopPolling.current?.();
        stopPolling.current = pollAfterRefresh(load, state?.assessment?.created_at ?? null);
      }
      else if (res.status === 409) toast.error(t('featureOff'));
      else if (res.status === 429) toast.error(t('rateLimited'));
      else if (res.status === 403) toast.error(t('noPermission'));
      else toast.error(t('refreshFailed'));
    } catch {
      toast.error(t('refreshFailed'));
    } finally {
      setBusy(false);
    }
  };

  return <AssessmentPanelView enabled={enabled} assessment={assessment} busy={busy} onRefresh={() => void refresh()} />;
}

/** The panel's markup (no data loading), for the sidebar and tests. */
export function AssessmentPanelView({ enabled, assessment, busy = false, onRefresh }: {
  enabled: boolean;
  assessment: AssessmentPanelData | null;
  busy?: boolean;
  onRefresh?: () => void;
}) {
  const t = useTranslations('AiAssessment');
  const intentLabel = (intent: string) => (t.has(`intents.${intent}`) ? t(`intents.${intent}`) : intent);
  const signals = assessment ? SIGNALS.filter((key) => assessment.qualification?.[key] === true) : [];

  return (
    <section className="border-border border-t pt-4" aria-label={t('title')}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase">
          <Sparkles className="size-3" aria-hidden />
          {t('title')}
        </h3>
        {enabled && onRefresh && (
          <Button size="icon" variant="ghost" aria-label={t('refresh')} title={t('refresh')} disabled={busy} onClick={onRefresh}>
            <RefreshCw className="size-4" />
          </Button>
        )}
      </div>
      {!assessment ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <div className="space-y-2 text-xs">
          {assessment.qualification?.route_to_staff && (
            <div role="alert" className="border-destructive/40 text-destructive flex gap-2 rounded-lg border p-2">
              <ShieldAlert className="size-4 shrink-0" aria-hidden />
              <span>{t('routeToStaff')}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{intentLabel(assessment.intent)}</Badge>
            <span className="text-muted-foreground">{t('confidence', { value: assessment.intent_confidence })}</span>
          </div>
          <p>
            <span className="font-medium">{t('leadScore')}: </span>
            {assessment.lead_score === null ? (
              <span className="text-muted-foreground">{t('noScore')}</span>
            ) : (
              <span>{assessment.lead_score}/100</span>
            )}
          </p>
          {signals.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {signals.map((key) => (
                <Badge key={key} variant="outline">{t(`signals.${key}`)}</Badge>
              ))}
            </div>
          )}
          {assessment.rationale && <p className="text-muted-foreground break-words whitespace-pre-wrap">{assessment.rationale}</p>}
          <p className="text-muted-foreground">
            {assessment.source === 'model' ? t('sourceModel') : t('sourceKeywords')}
            {' · '}
            {t('assessedAt', { at: new Date(assessment.created_at) })}
          </p>
          <p className="text-muted-foreground italic">{t('advisory')}</p>
        </div>
      )}
    </section>
  );
}
