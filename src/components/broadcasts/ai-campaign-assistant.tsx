'use client';

// AI campaign assistant for the wizard's first step. It only suggests: the
// server returns a draft (approved template, variable mapping, segment
// filter, send time) and "Apply" fills the wizard. Applying saves the
// suggested audience as a segment through the normal segments API so the
// audience step can select it; nothing is created or sent otherwise.

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/auth/client';
import type { MessageTemplate } from '@/types';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-create';

const GOAL_MAX = 2000;
const AUDIENCE_MAX = 1000;
/** Matches the segments API name limit. */
const SEGMENT_NAME_MAX = 100;
const FALLBACK_SEGMENT_NAME = 'AI segment';

export interface AiCampaignDraft {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  /** A saved segment audience, or null when none was suggested or saving it failed. */
  audience: AudienceConfig | null;
  /** Suggested ISO send time, or null for "send now". The user schedules it in the last step. */
  sendAt: string | null;
  notes: string;
}

interface Suggestion {
  draft: {
    templateId: string;
    templateName: string;
    variables: Record<string, VariableMapping>;
    segment: { name: string; filter: { conditions: unknown[] } } | null;
    sendAt: string | null;
    notes: string;
  };
  template: MessageTemplate;
  issues: string[];
}

export interface AiCampaignAssistantProps {
  onApply: (draft: AiCampaignDraft) => void;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * Segment names are unique per account. Returns `base` when it is free,
 * otherwise "base (2)", "base (3)", … trimmed to the API's length limit.
 */
export function uniqueSegmentName(base: string, existing: Iterable<string>): string {
  const taken = new Set(Array.from(existing, (n) => n.trim().toLowerCase()));
  const root = base.trim().slice(0, SEGMENT_NAME_MAX).trim() || FALLBACK_SEGMENT_NAME;
  if (!taken.has(root.toLowerCase())) return root;
  for (let i = 2; i <= 999; i++) {
    const suffix = ` (${i})`;
    const candidate = `${root.slice(0, SEGMENT_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  const stamp = ` ${new Date().toISOString().slice(0, 19)}`;
  return `${root.slice(0, SEGMENT_NAME_MAX - stamp.length).trimEnd()}${stamp}`;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Saves the suggested audience as a new segment under a name that does not
 * collide with the account's existing segments.
 */
export async function saveSuggestedSegment(
  fetcher: Fetcher,
  segment: { name: string; filter: { conditions: unknown[] } },
): Promise<{ id: string } | { error: string }> {
  let existing: string[] = [];
  try {
    const list = await fetcher('/api/segments');
    if (list.ok) {
      const payload = (await list.json().catch(() => ({}))) as { segments?: Array<{ name?: unknown }> };
      existing = (payload.segments ?? []).map((row) => (typeof row.name === 'string' ? row.name : ''));
    }
  } catch {
    // The create below still reports a duplicate name if the list was unavailable.
  }
  const res = await fetcher('/api/segments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: uniqueSegmentName(segment.name, existing), filter: segment.filter }),
  });
  const payload = (await res.json().catch(() => ({}))) as { segment?: { id: string }; error?: string };
  if (res.ok && payload.segment?.id) return { id: payload.segment.id };
  return { error: payload.error ?? String(res.status) };
}

export function AiCampaignAssistant({ onApply }: AiCampaignAssistantProps) {
  const t = useTranslations('AiCampaignAssistant');
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [audienceText, setAudienceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // The segment saved for the current suggestion, so applying it again reuses it.
  const savedSegment = useRef<{ suggestion: Suggestion; segmentId: string } | null>(null);

  async function suggest() {
    if (!goal.trim()) return;
    setBusy(true);
    setSuggestion(null);
    try {
      const res = await authFetch('/api/ai/campaign-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim(), audience: audienceText.trim(), timezone: browserTimeZone() }),
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<Suggestion> & { error?: string };
      if (!res.ok || !payload.draft || !payload.template) {
        toast.error(payload.error || t('failed'));
        return;
      }
      setSuggestion({ draft: payload.draft, template: payload.template, issues: payload.issues ?? [] });
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!suggestion) return;
    setApplying(true);
    try {
      let audience: AudienceConfig | null = null;
      const segment = suggestion.draft.segment;
      if (segment) {
        if (savedSegment.current?.suggestion === suggestion) {
          audience = { type: 'segment', segmentId: savedSegment.current.segmentId };
        } else {
          const saved = await saveSuggestedSegment(authFetch, segment).catch(() => ({ error: t('failed') }));
          if ('id' in saved) {
            savedSegment.current = { suggestion, segmentId: saved.id };
            audience = { type: 'segment', segmentId: saved.id };
          } else {
            toast.warning(t('segmentNotSaved', { reason: saved.error }));
          }
        }
      }
      onApply({
        template: suggestion.template,
        variables: suggestion.draft.variables,
        audience,
        sendAt: suggestion.draft.sendAt,
        notes: suggestion.draft.notes,
      });
      toast.success(t('applied'));
      setOpen(false);
    } finally {
      setApplying(false);
    }
  }

  const d = suggestion?.draft;
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          {t('title')}
        </span>
        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">{t('description')}</p>
          <div className="space-y-1.5">
            <Label htmlFor="ai-campaign-goal" className="text-muted-foreground">{t('goalLabel')}</Label>
            <Textarea id="ai-campaign-goal" rows={3} maxLength={GOAL_MAX} value={goal} disabled={busy}
              placeholder={t('goalPlaceholder')} onChange={(e) => setGoal(e.target.value)} className="bg-muted" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-campaign-audience" className="text-muted-foreground">{t('audienceLabel')}</Label>
            <Textarea id="ai-campaign-audience" rows={2} maxLength={AUDIENCE_MAX} value={audienceText} disabled={busy}
              placeholder={t('audiencePlaceholder')} onChange={(e) => setAudienceText(e.target.value)} className="bg-muted" />
          </div>
          <Button type="button" onClick={suggest} disabled={busy || !goal.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? t('suggesting') : t('suggest')}
          </Button>

          {d && (
            <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p><span className="text-muted-foreground">{t('template')}: </span>{d.templateName}</p>
              <p><span className="text-muted-foreground">{t('variables')}: </span>{t('variablesMapped', { count: Object.keys(d.variables).length })}</p>
              <p>
                <span className="text-muted-foreground">{t('audience')}: </span>
                {d.segment ? t('segmentSummary', { name: d.segment.name, count: d.segment.filter.conditions.length }) : t('noSegment')}
              </p>
              <p>
                <span className="text-muted-foreground">{t('sendTime')}: </span>
                {d.sendAt ? new Date(d.sendAt).toLocaleString() : t('sendNow')}
              </p>
              {d.notes && <p className="whitespace-pre-wrap text-muted-foreground">{d.notes}</p>}
              {suggestion.issues.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t('reviewIssues', { count: suggestion.issues.length })}</p>}
              <p className="text-xs text-muted-foreground">{t('reviewNote')}</p>
              <Button type="button" size="sm" onClick={apply} disabled={applying}>
                {applying && <Loader2 className="size-4 animate-spin" />}
                {t('apply')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
