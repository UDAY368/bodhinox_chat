'use client';

// Test chat for one agent (AI page, Agents tab), docked beside the agent cards
// on wide screens and over them on narrower ones. Each turn runs the same
// decision path as the live auto-reply (POST /api/ai/playground with the
// agent's id): its instructions, tone and handoff rules, the knowledge base
// and the confidence check. Nothing is sent to customers. A handover is shown
// as an event and locks the chat until "Start again"; each answer names the
// knowledge it came from, with the model and timing details underneath.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowUp, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STARTER_KEYS, type AgentView } from './agent-view';

interface Turn {
  kind: 'me' | 'ai' | 'event';
  text: string;
  sources?: string[];
  details?: string;
}

export function handoffKey(reason: unknown): 'keyword' | 'turns' | 'unsure' {
  return reason === 'handoff_keyword' ? 'keyword' : reason === 'max_turns' ? 'turns' : 'unsure';
}

export function AgentTestPanel({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const t = useTranslations('AiStudio.test');
  const tp = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [handed, setHanded] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [turns, sending]);
  useEffect(() => { field.current?.focus(); }, [agent.id]);

  const reset = () => { setTurns([]); setHanded(false); setError(''); setInput(''); requestAnimationFrame(() => field.current?.focus()); };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending || handed) return;
    const history = [...turns, { kind: 'me' as const, text }];
    setTurns(history);
    setInput('');
    setSending(true);
    setError('');
    try {
      const res = await authFetch('/api/ai/playground', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          messages: history.filter((m) => m.kind !== 'event' && m.text).map((m) => ({ role: m.kind === 'me' ? 'user' : 'assistant', content: m.text })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.code === 'ai_not_configured' ? tp('notConfigured') : data.error ?? tp('noReply'));
        setTurns(turns);
        setInput(text);
        return;
      }
      const d = data.diagnostics;
      const details = d ? tp('responseDetails', {
        model: d.model, count: d.knowledgeMatches, seconds: (d.totalMs / 1000).toFixed(1),
        retrieval: (d.retrievalMs / 1000).toFixed(1), generation: (d.generationMs / 1000).toFixed(1),
      }) : undefined;
      const next: Turn[] = [...history];
      if (data.handoff) {
        next.push({ kind: 'ai', text: t('handoverReply'), details });
        next.push({ kind: 'event', text: t(`handoff.${handoffKey(data.reason)}`) });
        setHanded(true);
      } else {
        next.push({ kind: 'ai', text: typeof data.reply === 'string' ? data.reply : '', sources: Array.isArray(data.sources) ? data.sources : [], details });
      }
      setTurns(next);
    } catch {
      setError(tp('unreachable'));
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside aria-label={t('panelLabel', { name: agent.name })}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-card shadow-[-16px_0_48px_rgb(0_0_0/0.12)] sm:w-[380px] xl:sticky xl:top-4 xl:z-auto xl:h-[calc(100dvh-7rem)] xl:w-auto xl:rounded-xl xl:border xl:shadow-none">
      <header className="flex items-center gap-2.5 border-b border-border py-3 pr-2 pl-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-primary-soft text-primary"><Sparkles className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <strong className="block truncate text-[15px] font-semibold">{agent.name}</strong>
          <small className="block truncate text-xs text-muted-foreground">{t('subtitle')}</small>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('reset')} title={t('reset')} onClick={reset} disabled={sending}>
          <RotateCcw aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('close')} title={t('close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>

      <div ref={box} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-4" aria-live="polite">
        {turns.length === 0 && (
          <p className="my-auto rounded-xl bg-muted px-3.5 py-3 text-center text-[13px] text-muted-foreground">
            {t('hint', { name: agent.name })}{agent.enabled ? '' : ` ${t('hintOff')}`}
          </p>
        )}
        {turns.map((m, i) => m.kind === 'event' ? (
          <p key={i} className="my-2 self-center rounded-full bg-amber-500/10 px-3 py-1 text-center text-xs font-medium text-amber-800 dark:text-amber-200">{m.text}</p>
        ) : (
          <div key={i} className={cn('flex max-w-[86%] flex-col', m.kind === 'me' ? 'mt-2 self-end items-end' : 'self-start items-start')}>
            <p className={cn('rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
              m.kind === 'me' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted text-foreground')}>
              {m.text}
            </p>
            {m.kind === 'ai' && !!m.sources?.length && (
              <span className="mt-1 text-[11px] text-muted-foreground">{t('from', { source: m.sources.join(', ') })}</span>
            )}
            {m.kind === 'ai' && m.details && <span className="mt-0.5 text-[11px] text-muted-foreground/80">{m.details}</span>}
          </div>
        ))}
        {sending && (
          <div className="inline-flex items-center gap-2 self-start rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-xs text-muted-foreground" aria-label={t('typing')}>
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t('typing')}
          </div>
        )}
      </div>

      {error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}

      {!handed && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none]">
          {STARTER_KEYS[agent.role].map((key) => (
            <button key={key} type="button" disabled={sending}
              className="h-7 shrink-0 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              onClick={() => void send(t(`starters.${key}`))}>
              {t(`starters.${key}`)}
            </button>
          ))}
        </div>
      )}
      <form className="flex items-center gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input ref={field} value={input} maxLength={300} disabled={handed} aria-label={t('inputLabel')}
          placeholder={handed ? t('lockedPlaceholder') : t('placeholder')}
          className="h-9 min-w-0 flex-1 rounded-full border border-border bg-background px-3.5 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:bg-muted"
          onChange={(e) => setInput(e.target.value)} />
        {handed ? (
          <Button type="button" size="sm" variant="outline" onClick={reset}>{t('reset')}</Button>
        ) : (
          <Button type="submit" size="icon" className="shrink-0 rounded-full" aria-label={t('send')} disabled={!input.trim() || sending}>
            <ArrowUp aria-hidden />
          </Button>
        )}
      </form>
    </aside>
  );
}
