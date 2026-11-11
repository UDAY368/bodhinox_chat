'use client';

// The conversation starters (ice breakers) of one Instagram account, edited at
// Instagram › Conversation starters (Stage 2, 2E). Up to 4 questions, each
// linked to an Instagram flow the tap starts. Saving publishes them to
// Instagram (PUT /api/instagram/accounts/{id}/ice-breakers, admins); members
// see the list read-only.

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import type { InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ConversationStartersView } from '@/lib/instagram/ice-breakers';
import { INSTAGRAM_LIMITS, charLength } from '@/lib/instagram/graph-limits';

const MAX = INSTAGRAM_LIMITS.iceBreakers;
const MAX_CHARS = INSTAGRAM_LIMITS.iceBreakerQuestionChars;

interface Row { question: string; flowId: string }

/** The question as the server stores it (normaliseStarters in ice-breakers.ts): NFC, trimmed, inner spaces collapsed. */
export const normaliseQuestion = (question: string): string => question.normalize('NFC').trim().replace(/\s+/g, ' ');

/** The first problem with the rows (a message key), or null when they can be saved. */
export function startersProblem(rows: readonly Row[], flowIds: ReadonlySet<string>): 'max' | 'tooLong' | 'duplicate' | 'flow' | 'question' | null {
  if (rows.length > MAX) return 'max';
  const seen = new Set<string>();
  for (const row of rows) {
    const question = normaliseQuestion(row.question);
    if (!question) return 'question';
    if (charLength(question) > MAX_CHARS) return 'tooLong';
    if (seen.has(question.toLowerCase())) return 'duplicate';
    seen.add(question.toLowerCase());
    if (!flowIds.has(row.flowId)) return 'flow';
  }
  return null;
}

export function ConversationStartersEditor({ accountId, flows, canEdit }: {
  accountId: string;
  /** The Instagram flows a starter may start (not archived). */
  flows: InstagramFlowSummary[];
  canEdit: boolean;
}) {
  const t = useTranslations('Instagram.starters');
  const tc = useTranslations('Settings.instagram');
  const [view, setView] = useState<ConversationStartersView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const base = `/api/instagram/accounts/${accountId}/ice-breakers`;

  const accept = (next: ConversationStartersView) => {
    setView(next);
    setRows(next.starters.map((s) => ({ question: s.question, flowId: s.flowId })));
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { ok, json } = await instagramCall(base);
        if (!live) return;
        if (!ok) throw new Error('load');
        accept(json.starters as ConversationStartersView);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [base]);

  const flowIds = new Set(flows.map((f) => f.id));
  const problem = startersProblem(rows, flowIds);
  const unusable = new Set(view?.starters.filter((s) => !s.flowUsable).map((s) => s.flowId) ?? []);
  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      const { ok, json } = await instagramCall(base, jsonInit('PUT', {
        starters: rows.map((row) => ({ question: normaliseQuestion(row.question), flow_id: row.flowId })),
      }));
      if (!ok) {
        toast.error(typeof json.message === 'string' ? json.message : t('saveFailed'));
        return;
      }
      accept(json.starters as ConversationStartersView);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (failed) return <p className="text-destructive text-sm">{tc('loadFailed')}</p>;
  if (!view) return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tc('loading')} />;

  if (!canEdit) {
    return (
      <div className="space-y-2">
        {view.starters.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
        <ul className="space-y-1 text-sm">
          {view.starters.map((s) => (
            <li key={s.question} className="bg-muted/40 rounded-md p-2">
              <p className="text-foreground">{s.question}</p>
              <p className={s.flowUsable ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
                {s.flowUsable ? s.flowName : t('flowMissing')}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {!view.managed && <p className="text-muted-foreground text-xs">{t('replacesExisting')}</p>}
      {flows.length === 0 && <p className="text-muted-foreground text-sm">{t('noFlows')}</p>}
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`ig-starter-q-${accountId}-${index}`}>{t('question')}</Label>
            <Input id={`ig-starter-q-${accountId}-${index}`} value={row.question} maxLength={MAX_CHARS * 2}
              placeholder={t('questionPlaceholder')} onChange={(e) => update(index, { question: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ig-starter-f-${accountId}-${index}`}>{t('flow')}</Label>
            <select id={`ig-starter-f-${accountId}-${index}`} value={flowIds.has(row.flowId) ? row.flowId : ''}
              onChange={(e) => update(index, { flowId: e.target.value })}
              className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm">
              <option value="">{t('chooseFlow')}</option>
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
            </select>
            {row.flowId && (unusable.has(row.flowId) || !flowIds.has(row.flowId)) && (
              <p className="text-destructive text-xs">{t('flowMissing')}</p>
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" aria-label={t('remove')}
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {problem === 'tooLong' && <p className="text-destructive text-xs">{t('tooLong', { max: MAX_CHARS })}</p>}
      {problem === 'duplicate' && <p className="text-destructive text-xs">{t('duplicate')}</p>}
      {rows.length >= MAX && <p className="text-muted-foreground text-xs">{t('max', { max: MAX })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX || saving}
          onClick={() => setRows((current) => [...current, { question: '', flowId: '' }])}>
          <Plus className="size-3.5" />
          {t('add')}
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={problem !== null || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}
