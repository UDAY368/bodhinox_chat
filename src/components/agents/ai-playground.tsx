'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { RotateCcw, Send, Loader2, UserCircle2, ArrowRight } from 'lucide-react';
import { KhagaIcon } from '@/components/agents/khaga-icon';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  diagnostics?: { model: string; knowledgeMatches: number; retrievalMs: number; generationMs: number; totalMs: number };
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const t = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [requestError, setRequestError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  useEffect(() => {
    if (!sending) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    setElapsedSeconds(0);
    setRequestError('');
    try {
      const res = await authFetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content — the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestError(data.code === 'ai_not_configured' ? t('notConfigured') : data.error ?? t('noReply'));
        if (data.code === 'ai_not_configured') {
          toast.error(t('notConfigured'));
        } else {
          toast.error(data.error ?? t('noReply'));
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content:
            typeof data.reply === 'string' && data.reply.trim()
              ? data.reply
              : '',
          handoff: Boolean(data.handoff),
          diagnostics: data.diagnostics,
        },
      ]);
    } catch {
      toast.error(t('unreachable'));
      setRequestError(t('unreachable'));
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="studio-ai-playground flex h-[60vh] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <KhagaIcon />
          <span className="text-sm font-medium text-foreground">{t('title')}</span>
          <span className="text-xs text-muted-foreground">
            {t('subtitle')}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setTurns([]); setRequestError(''); }}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {t('reset')}
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto bg-background p-4 sm:p-6">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card"><KhagaIcon className="h-12 w-12" /></div>
            <p className="text-base font-medium tracking-tight text-foreground">{t('emptyTitle')}</p>
            <p className="mt-2 max-w-sm text-xs leading-relaxed">
              {t('emptyDesc')}
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                {t('goToSetup')} <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((turn, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              turn.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {turn.role === 'assistant' && (
              <KhagaIcon className="mt-1" />
            )}
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
                turn.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm border border-border bg-card text-foreground',
              )}
            >
              {turn.content && <p className="whitespace-pre-wrap break-words">{turn.content}</p>}
              {turn.role === 'assistant' && turn.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400',
                    turn.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  {t('handoff')}
                </p>
              )}
              {turn.role === 'assistant' && turn.diagnostics && (
                <p className="mt-2 border-t border-border/50 pt-1.5 text-xs text-muted-foreground">
                  {t('responseDetails', { model: turn.diagnostics.model, count: turn.diagnostics.knowledgeMatches,
                    seconds: (turn.diagnostics.totalMs / 1000).toFixed(1),
                    retrieval: (turn.diagnostics.retrievalMs / 1000).toFixed(1),
                    generation: (turn.diagnostics.generationMs / 1000).toFixed(1) })}
                </p>
              )}
            </div>
            {turn.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <KhagaIcon activity="thinking" />
            <Loader2 className="h-4 w-4 animate-spin" />
            <div><p>{t('thinkingElapsed', { seconds: elapsedSeconds })}</p>
              {elapsedSeconds >= 5 && <p className="mt-1 text-xs">{t('waitingHint')}</p>}
            </div>
          </div>
        )}
      </div>

      {requestError && <p role="alert" className="mx-3 mb-2 rounded-md border border-destructive/30 p-2 text-sm text-destructive">{requestError}</p>}

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('placeholder')}
          rows={1}
          className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={send}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
