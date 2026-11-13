'use client';

// "Ask the knowledge base" (AI page, Knowledge tab): what the AI would find
// for a question, before a customer asks (POST /api/ai/knowledge/ask). Shows
// the best-matching text, its source, a match percentage and a "team only"
// warning, or offers to write an answer when nothing matches.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, Loader2, Plus, Search } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AskMatch {
  text: string;
  question: string | null;
  match: number;
  document_title: string | null;
  source: { id: string; title: string; kind: string; qa: boolean; customer_facing: boolean } | null;
}

type Result = { kind: 'empty' } | { kind: 'none'; q: string } | { kind: 'hit'; q: string; match: AskMatch } | { kind: 'error' };

export function AskBox({ onWriteAnswer, canWrite }: { onWriteAnswer: (question: string) => void; canWrite: boolean }) {
  const t = useTranslations('AiStudio.knowledge');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ask = async () => {
    const question = q.replace(/\s+/g, ' ').trim();
    if (!question) { setResult({ kind: 'empty' }); return; }
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/knowledge/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ kind: 'error' }); return; }
      setResult(data.match ? { kind: 'hit', q: question, match: data.match } : { kind: 'none', q: question });
    } catch {
      setResult({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3 rounded-xl bg-muted p-4" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-card text-primary"><BookOpen className="size-4" aria-hidden /></span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{t('askTitle')}</h2>
          <p className="text-[13px] text-muted-foreground">{t('askBody')}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
          <input value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} placeholder={t('askPlaceholder')} aria-label={t('askLabel')}
            className="h-9 w-full rounded-full border border-border bg-card pr-3 pl-9 text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" />
        </label>
        <Button type="submit" variant="outline" className="h-9 shrink-0 px-4" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{t('ask')}
        </Button>
      </div>
      <div aria-live="polite">
        {result?.kind === 'empty' && <p className="text-xs font-medium text-destructive">{t('askEmpty')}</p>}
        {result?.kind === 'error' && <p className="text-xs font-medium text-destructive">{t('askFailed')}</p>}
        {result?.kind === 'none' && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3.5 py-3 text-sm">
            <p><strong>{t('noMatch', { q: result.q })}</strong> {t('noMatchBody')}</p>
            {canWrite && <Button type="button" size="sm" variant="outline" onClick={() => onWriteAnswer(result.q)}><Plus aria-hidden />{t('writeAnswer')}</Button>}
          </div>
        )}
        {result?.kind === 'hit' && (
          <div className="flex flex-col gap-2 rounded-xl bg-card px-3.5 py-3">
            {result.match.question && <small className="text-xs text-muted-foreground">{result.match.question}</small>}
            <p className="text-sm whitespace-pre-wrap break-words">{result.match.text}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="max-w-full rounded-full"><span className="truncate">{result.match.source?.title ?? result.match.document_title ?? t('untitled')}</span></Badge>
              <Badge variant="secondary" className="rounded-full tabular-nums">{t('matchPct', { n: result.match.match })}</Badge>
              {result.match.source && !result.match.source.customer_facing && (
                <Badge variant="outline" className="rounded-full border-amber-500/40 text-amber-800 dark:text-amber-200">{t('teamOnly')}</Badge>
              )}
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
