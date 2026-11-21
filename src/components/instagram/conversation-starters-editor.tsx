'use client';

// The conversation starters (ice breakers) of one Instagram account, edited at
// Instagram › Conversation starters (Stage 2, 2E). Up to 4 questions, each
// linked to an Instagram flow the tap starts. Saving publishes them to
// Instagram (PUT /api/instagram/accounts/{id}/ice-breakers, admins); members
// see the list read-only.
// Apple's way (b7): a grouped list, the shared flow menu (Select), 44px row
// buttons, and the shared loading and failed states.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessagesSquare, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import type { InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoading } from '@/components/ui/page-loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

  const load = useCallback(async (isLive: () => boolean = () => true) => {
    try {
      const { ok, json } = await instagramCall(base);
      if (!isLive()) return;
      if (!ok) throw new Error('load');
      accept(json.starters as ConversationStartersView);
      setFailed(false);
    } catch {
      if (isLive()) setFailed(true);
    }
  }, [base]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

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

  if (failed) return <InlineError message={tc('loadFailed')} onRetry={() => void load()} className="py-6" />;
  if (!view) return <PageLoading rows={2} />;

  if (!canEdit) {
    return view.starters.length === 0 ? (
      <EmptyState icon={MessagesSquare} title={t('empty')} body={t('adminOnly')} className="py-6" />
    ) : (
      <GroupedList footer={t('adminOnly')}>
        {view.starters.map((s) => (
          <GroupedListRow key={s.question} title={s.question}
            subtitle={<span className={s.flowUsable ? undefined : 'text-destructive'}>{s.flowUsable ? s.flowName : t('flowMissing')}</span>} />
        ))}
      </GroupedList>
    );
  }

  const addRow = () => setRows((current) => [...current, { question: '', flowId: '' }]);

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <EmptyState icon={MessagesSquare} title={t('empty')} className="py-6"
          action={(
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving} onClick={addRow}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          )} />
      )}
      {!view.managed && <p className="text-muted-foreground text-xs">{t('replacesExisting')}</p>}
      {flows.length === 0 && <p className="text-muted-foreground text-sm">{t('noFlows')}</p>}
      {rows.length > 0 && <GroupedList>{rows.map((row, index) => (
        <div key={index} className="not-first:border-separator grid grid-cols-1 gap-2 px-4 py-3 not-first:border-t sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`ig-starter-q-${accountId}-${index}`}>{t('question')}</Label>
            <Input id={`ig-starter-q-${accountId}-${index}`} value={row.question} maxLength={MAX_CHARS * 2}
              placeholder={t('questionPlaceholder')} onChange={(e) => update(index, { question: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ig-starter-f-${accountId}-${index}`}>{t('flow')}</Label>
            <Select value={flowIds.has(row.flowId) ? row.flowId : ''}
              onValueChange={(v) => update(index, { flowId: typeof v === 'string' ? v : '' })}>
              <SelectTrigger id={`ig-starter-f-${accountId}-${index}`} className="min-h-11 w-full sm:min-h-8">
                <SelectValue>{flows.find((flow) => flow.id === row.flowId)?.name ?? t('chooseFlow')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {flows.map((flow) => <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {row.flowId && (unusable.has(row.flowId) || !flowIds.has(row.flowId)) && (
              <p className="text-destructive text-xs">{t('flowMissing')}</p>
            )}
          </div>
          <Button type="button" variant="ghost" size="icon" className="text-destructive size-11 justify-self-end" aria-label={t('remove')}
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}</GroupedList>}
      {problem === 'tooLong' && <p className="text-destructive text-xs">{t('tooLong', { max: MAX_CHARS })}</p>}
      {problem === 'duplicate' && <p className="text-destructive text-xs">{t('duplicate')}</p>}
      {rows.length >= MAX && <p className="text-muted-foreground text-xs">{t('max', { max: MAX })}</p>}
      <div className="flex flex-wrap gap-2">
        {rows.length > 0 && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={rows.length >= MAX || saving} onClick={addRow}>
            <Plus className="size-3.5" />
            {t('add')}
          </Button>
        )}
        <Button type="button" className="min-h-11 sm:min-h-8" onClick={() => void save()} disabled={problem !== null || saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}
