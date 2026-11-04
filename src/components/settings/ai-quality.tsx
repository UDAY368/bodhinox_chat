'use client';

/**
 * Settings -> AI assistant -> quality (Phase 13): how staff used the AI's
 * suggestions over the last 30 days (accepted as written, edited, rejected,
 * median edit size), how often guards fired, how assessments were made and
 * this month's AI tokens. Admins with 'ai.settings' only (GET /api/ai/quality).
 * Counts only: no suggestion text or customer content is shown here.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch } from '@/lib/auth/client';

export interface AiQualityView {
  window_days: number;
  replies: {
    total: number; accepted: number; edited: number; rejected: number; ignored: number;
    acceptance_rate: number | null; edit_rate: number | null; rejection_rate: number | null;
    median_edit_distance: number | null;
  };
  summaries: number;
  routed_to_staff: number;
  guard_flags: { flag: string; count: number }[];
  assessments: { model: number; deterministic: number };
  tokens_this_month: number;
}

/** Guard flags with a translated label (AiQuality.flags.<key>); anything else shows its code. */
export const KNOWN_FLAGS = [
  'pii_redacted', 'injection_marker', 'url_stripped', 'input_truncated', 'uncovered_script', 'claim_replaced', 'evidence_dropped',
] as const;

/** A 0..1 rate as a whole percentage, or a dash. */
export const pct = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
/** An edit distance (0..1000) as the share of the text changed, or a dash. */
export const editShare = (distance: number | null): string => (distance === null ? '—' : `${Math.round(distance / 10)}%`);

export function flagLabelKey(flag: string): string | null {
  if ((KNOWN_FLAGS as readonly string[]).includes(flag)) return `flags.${flag}`;
  if (flag.startsWith('claim_')) return 'flags.claim';
  if (flag.startsWith('fallback_')) return 'flags.fallback';
  return null;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
    </div>
  );
}

export function AiQuality() {
  const t = useTranslations('AiQuality');
  const [view, setView] = useState<AiQualityView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/ai/quality', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setView(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const n = (v: number) => v.toLocaleString();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description', { days: view?.window_days ?? 30 })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadFailed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!view && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
        {view && (
          <>
            {view.replies.total === 0 && view.summaries === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label={t('repliesShown')} value={n(view.replies.total)} hint={t('ignored', { count: view.replies.ignored })} />
              <Tile label={t('accepted')} value={pct(view.replies.acceptance_rate)} hint={n(view.replies.accepted)} />
              <Tile label={t('edited')} value={pct(view.replies.edit_rate)} hint={n(view.replies.edited)} />
              <Tile label={t('rejected')} value={pct(view.replies.rejection_rate)} hint={n(view.replies.rejected)} />
              <Tile label={t('medianEdit')} value={editShare(view.replies.median_edit_distance)} hint={t('medianEditHint')} />
              <Tile label={t('summaries')} value={n(view.summaries)} />
              <Tile label={t('routedToStaff')} value={n(view.routed_to_staff)} />
              <Tile label={t('tokensThisMonth')} value={n(view.tokens_this_month)} />
            </div>
            <div className="text-muted-foreground text-sm">
              {t('assessments', { model: view.assessments.model, keyword: view.assessments.deterministic })}
            </div>
            <div>
              <h3 className="text-foreground mb-2 text-sm font-medium">{t('guardFlags')}</h3>
              {view.guard_flags.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('noFlags')}</p>
              ) : (
                <ul className="divide-border divide-y rounded-lg border text-sm">
                  {view.guard_flags.map((f) => {
                    const key = flagLabelKey(f.flag);
                    return (
                      <li key={f.flag} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="min-w-0 truncate">
                          {key ? t(key) : f.flag}
                          {key && <span className="text-muted-foreground ml-2 font-mono text-xs">{f.flag}</span>}
                        </span>
                        <span className="tabular-nums">{n(f.count)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <p className="text-muted-foreground text-xs">{t('autonomyNote')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
