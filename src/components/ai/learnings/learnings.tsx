'use client';
import { authFetch } from '@/lib/auth/client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BookOpenCheck, Check, GraduationCap, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { UnansweredQuestion, UnansweredStatus } from '@/lib/ai/unanswered';

const STATUSES: UnansweredStatus[] = ['open', 'answered', 'dismissed'];
const PAGE_SIZE = 25;
const MAX_ANSWER_CHARS = 4000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export interface AgentLearningsProps {
  /** Admins and owners can teach answers to the agent (promote to knowledge). */
  canPromote: boolean;
}

/**
 * Questions the AI agent could not answer, grouped by the server (same
 * question = one row with a count). Agents answer inline or dismiss;
 * admins teach an answer to the agent, which saves it as knowledge.
 */
export function AgentLearnings({ canPromote }: AgentLearningsProps) {
  const t = useTranslations('AgentLearnings');
  const format = useFormatter();
  const [status, setStatus] = useState<UnansweredStatus>('open');
  const [items, setItems] = useState<UnansweredQuestion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (nextStatus: UnansweredStatus, offset: number) => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const res = await authFetch(`/api/ai/unanswered?status=${nextStatus}&limit=${PAGE_SIZE}&offset=${offset}`);
      const data = (await res.json().catch(() => ({}))) as { items?: UnansweredQuestion[]; total?: number; error?: string };
      if (request !== requestRef.current) return;
      if (!res.ok || !data.items) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setItems((prev) => (offset === 0 ? data.items! : [...prev, ...data.items!]));
      setTotal(data.total ?? 0);
    } catch {
      if (request === requestRef.current) toast.error(t('loadFailed'));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(status, 0);
  }, [load, status]);

  const act = async (id: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/ai/unanswered/${encodeURIComponent(id)}`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 409 && body.action === 'promote') {
        // An agent edited the answer after this admin saw it: show the current text before teaching it.
        toast.error(t('answerChanged'));
        void load(status, 0);
        return null;
      }
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : t('actionFailed'));
        return null;
      }
      return data;
    } catch {
      toast.error(t('actionFailed'));
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const removeRow = (id: string) => {
    setItems((prev) => prev.filter((q) => q.id !== id));
    setTotal((n) => Math.max(0, n - 1));
  };

  const saveAnswer = async (q: UnansweredQuestion, teach = false) => {
    const answer = (drafts[q.id] ?? q.answer ?? '').trim();
    if (!answer) {
      toast.error(t('answerRequired'));
      return;
    }
    const data = await act(q.id, { action: 'answer', answer });
    if (!data?.question) return;
    setEditing(null);
    if (teach) {
      // Teach exactly the answer this admin just saved.
      const promoted = await act(q.id, { action: 'promote', answer: (data.question as UnansweredQuestion).answer });
      if (promoted?.documentId) toast.success(promoted.indexed === false ? t('promotedNotIndexed') : t('promoted'));
    } else {
      toast.success(t('answerSaved'));
    }
    if (status === 'answered') {
      setItems((prev) => prev.map((row) => (row.id === q.id ? (data.question as UnansweredQuestion) : row)));
    } else {
      removeRow(q.id);
    }
  };

  const dismiss = async (q: UnansweredQuestion) => {
    if (await act(q.id, { action: 'dismiss' })) {
      toast.success(t('dismissed'));
      removeRow(q.id);
    }
  };

  const promote = async (q: UnansweredQuestion) => {
    const data = await act(q.id, { action: 'promote', answer: q.answer });
    if (!data?.documentId) return;
    toast.success(data.indexed === false ? t('promotedNotIndexed') : t('promoted'));
    setItems((prev) => prev.map((row) => (row.id === q.id ? { ...row, promoted_document_id: String(data.documentId) } : row)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
        <div role="tablist" aria-label={t('filterLabel')} className="mt-3 flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s}
              onClick={() => {
                if (s === status) return;
                setStatus(s); setItems([]); setEditing(null);
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                status === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted',
              )}>
              {t(`status.${s}`)}
              {status === s && !loading && <span className="ml-1.5 tabular-nums opacity-80">{total}</span>}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} />
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <BookOpenCheck className="mx-auto mb-2 h-6 w-6" />
            {t(`empty.${status}`)}
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((q) => {
              const busy = busyId === q.id;
              const showEditor = status === 'open' || editing === q.id;
              return (
                <li key={q.id} className="space-y-2 py-4 first:pt-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{q.question}</p>
                    <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-full bg-muted px-2 py-0.5 tabular-nums">{t('askedTimes', { count: q.occurrences })}</span>
                      <time dateTime={q.last_asked_at}>{format.relativeTime(new Date(q.last_asked_at))}</time>
                    </div>
                  </div>

                  {status === 'answered' && q.answer && editing !== q.id && (
                    <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5 text-sm">{q.answer}</p>
                  )}

                  {showEditor && status !== 'dismissed' && (
                    <div className="space-y-1">
                      <Textarea rows={3} maxLength={MAX_ANSWER_CHARS} disabled={busy} aria-label={t('answerLabel')}
                        placeholder={t('answerPlaceholder')} value={drafts[q.id] ?? q.answer ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))} />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {showEditor && status !== 'dismissed' && (
                      <Button size="sm" disabled={busy} onClick={() => void saveAnswer(q)}>
                        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                        {t('saveAnswer')}
                      </Button>
                    )}
                    {status === 'open' && canPromote && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveAnswer(q, true)}>
                        <GraduationCap className="mr-1.5 h-3.5 w-3.5" /> {t('saveAndTeach')}
                      </Button>
                    )}
                    {status === 'open' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss(q)}>
                        <X className="mr-1.5 h-3.5 w-3.5" /> {t('dismiss')}
                      </Button>
                    )}
                    {status === 'answered' && editing !== q.id && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(q.id)}>{t('editAnswer')}</Button>
                    )}
                    {status === 'answered' && editing === q.id && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t('cancel')}</Button>
                    )}
                    {status === 'answered' && canPromote && editing !== q.id && (
                      <Button size="sm" variant={q.promoted_document_id ? 'outline' : 'default'} disabled={busy} onClick={() => void promote(q)}>
                        <GraduationCap className="mr-1.5 h-3.5 w-3.5" />
                        {q.promoted_document_id ? t('updateKnowledge') : t('promote')}
                      </Button>
                    )}
                    {status === 'answered' && q.promoted_document_id && (
                      <span className="text-xs text-emerald-700 dark:text-emerald-400">{t('inKnowledge')}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {items.length > 0 && items.length < total && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(status, items.length)}>
              {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('loadMore')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
