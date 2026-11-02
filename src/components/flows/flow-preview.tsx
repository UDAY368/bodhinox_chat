'use client';

/**
 * WhatsApp-style preview of the flow being edited. Plays the live
 * editor state (unsaved edits included) through the pure simulator in
 * `@/lib/flows/preview`: bot bubbles on the left, the customer's taps
 * and answers on the right, grey notes for silent steps.
 *
 * Nothing here sends, saves or calls an API — it is a local walk over
 * the builder's nodes. Placeholders such as `{{vars.name}}` are shown
 * literally, as written.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Image as ImageIcon, List, MapPin, RotateCcw, SendHorizontal, Smartphone, Video, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { choose, PREVIEW_STEP_LIMIT, startPreview, type PreviewMessage, type PreviewState } from '@/lib/flows/preview';
import { useFlowEditor } from './flow-editor-state';

export function FlowPreview({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Flows.builder.preview');
  const { state } = useFlowEditor();

  // Restart whenever the flow's content changes — but not on canvas
  // drags, which only move positions.
  const signature = useMemo(
    () => JSON.stringify([state.entry_node_id, state.nodes.map((n) => [n.node_key, n.node_type, n.config])]),
    [state.entry_node_id, state.nodes]
  );
  const [run, setRun] = useState<PreviewState>(() => startPreview(state.nodes, state.entry_node_id));
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setRun(startPreview(state.nodes, state.entry_node_id));
  }
  const restart = () => setRun(startPreview(state.nodes, state.entry_node_id));

  const [answer, setAnswer] = useState('');
  const [openList, setOpenList] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [run.messages.length]);

  const pick = (id: string, text?: string) => {
    setOpenList(null);
    setAnswer('');
    setRun((current) => choose(current, id, text));
  };

  // The bubble the customer is answering: the newest message from the
  // node the preview is waiting on. Only its buttons / list are live.
  const activeId = run.waiting ? [...run.messages].reverse().find((m) => m.nodeKey === run.at)?.id : undefined;
  const waiting = run.waiting;

  return (
    <aside className="flow-studio-inspector absolute inset-0 z-20 flex min-h-0 flex-col border-l border-border bg-card sm:static sm:w-[340px] sm:shrink-0" aria-label={t('title')}>
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Smartphone className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="text-muted-foreground text-xs">{t('subtitle')}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={restart} aria-label={t('restart')} title={t('restart')}><RotateCcw className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('close')}><X className="h-4 w-4" /></Button>
      </div>

      <div className="bg-muted/60 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-4" aria-live="polite">
        {run.messages.length === 0 && <p className="text-muted-foreground px-4 py-8 text-center text-xs">{t('empty')}</p>}
        {run.messages.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            active={m.id === activeId}
            listOpen={openList === m.id}
            onToggleList={() => setOpenList((v) => (v === m.id ? null : m.id))}
            // Buttons line up with waiting.options; list rows carry their own ids.
            onPickButton={(i) => {
              const option = waiting?.options[i];
              if (option) pick(option.id);
            }}
            onPickRow={(id) => pick(id)}
            t={t}
          />
        ))}
        {run.ended && run.messages.length > 0 && <p className="text-muted-foreground pt-2 text-center text-[11px] uppercase tracking-wider">{t('ended')}</p>}
        <div ref={endRef} />
      </div>

      {waiting?.kind === 'branch' && (
        <div className="border-border border-t px-3 py-3">
          <p className="text-muted-foreground mb-2 text-xs">{t('chooseBranch')}</p>
          <div className="flex flex-wrap gap-1.5">
            {waiting.options.map((o) => (
              <Button key={o.id} variant="outline" size="sm" onClick={() => pick(o.id)}>{branchLabel(o.id, o.label, t)}</Button>
            ))}
          </div>
        </div>
      )}

      {waiting && waiting.simulate.length > 0 && (
        <div className="border-border flex flex-wrap gap-1.5 border-t px-3 py-3">
          {waiting.simulate.map((o) => (
            <Button key={o.id} variant="outline" size="sm" className="border-dashed" onClick={() => pick(o.id)}>
              {o.id === 'share'
                ? t(run.nodes.find((n) => n.node_key === run.at)?.node_type === 'ask_location' ? 'simulate.shareLocation' : 'simulate.shareMedia')
                : t(o.id === 'timeout' ? 'simulate.timeout' : 'simulate.exhausted')}
            </Button>
          ))}
        </div>
      )}

      {waiting?.kind === 'text' && (
        <form
          className="border-border flex items-center gap-2 border-t px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) pick('text', answer);
          }}
        >
          <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('answerPlaceholder')} aria-label={t('answerPlaceholder')} className="h-9 text-sm" autoFocus />
          <Button type="submit" size="icon-sm" disabled={!answer.trim()} aria-label={t('send')}><SendHorizontal className="h-4 w-4" /></Button>
        </form>
      )}
    </aside>
  );
}

type T = ReturnType<typeof useTranslations>;

function branchLabel(id: string, label: string, t: T) {
  if (id === 'true') return t('branchTrue');
  if (id === 'false') return t('branchFalse');
  if (id === 'fallback') return t('branchFallback');
  return label || id;
}

function Bubble({ message: m, active, listOpen, onToggleList, onPickButton, onPickRow, t }: {
  message: PreviewMessage;
  active: boolean;
  listOpen: boolean;
  onToggleList: () => void;
  onPickButton: (index: number) => void;
  onPickRow: (id: string) => void;
  t: T;
}) {
  if (m.from === 'system') {
    return (
      <p className="bg-card/70 text-muted-foreground mx-auto max-w-[90%] rounded-md px-2.5 py-1 text-center text-[11px]">
        {noteText(m, t)}
      </p>
    );
  }
  if (m.from === 'customer') {
    return (
      <div className="bg-primary-soft-2 text-foreground ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-lg rounded-tr-none px-3 py-2 text-sm shadow-sm">
        {m.shared ? (
          <span className="flex items-center gap-1.5 italic">
            {m.shared === 'location' ? <MapPin className="h-4 w-4 shrink-0" /> : <ImageIcon className="h-4 w-4 shrink-0" />}
            {t(m.shared === 'location' ? 'shared.location' : 'shared.media')}
          </span>
        ) : m.text}
      </div>
    );
  }
  const MediaIcon = m.media?.type === 'video' ? Video : m.media?.type === 'document' ? FileText : ImageIcon;
  const empty = !m.text && !m.media && !m.template;
  return (
    <div className="mr-auto flex max-w-[85%] flex-col gap-1">
      <div className="border-border bg-card text-foreground rounded-lg rounded-tl-none border px-3 py-2 text-sm shadow-sm">
        {m.media && (
          <div className="bg-muted text-muted-foreground mb-2 flex items-center gap-2 rounded-md px-3 py-4 text-xs">
            <MediaIcon className="h-5 w-5 shrink-0" />
            <span className="truncate">{m.media.filename || t(`media.${m.media.type === 'video' || m.media.type === 'document' ? m.media.type : 'image'}`)}</span>
          </div>
        )}
        {m.template !== undefined && <p className="text-muted-foreground text-xs italic">{m.template ? t('template', { name: m.template }) : t('templateUnset')}</p>}
        {m.header && <p className="mb-1 whitespace-pre-wrap break-words font-semibold">{m.header}</p>}
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {empty && <p className="text-muted-foreground italic">{t('emptyMessage')}</p>}
        {m.footer && <p className="text-muted-foreground mt-1 whitespace-pre-wrap break-words text-xs">{m.footer}</p>}
        {m.list && (
          <button
            type="button"
            disabled={!active}
            onClick={onToggleList}
            aria-expanded={listOpen}
            className="border-border text-primary mt-2 flex w-full items-center justify-center gap-1.5 border-t pt-2 text-sm font-medium disabled:opacity-60"
          >
            <List className="h-3.5 w-3.5" />{m.list.button || t('listFallback')}
          </button>
        )}
      </div>
      {m.list && listOpen && active && (
        <div className="border-border bg-card overflow-hidden rounded-lg border shadow-sm" role="listbox" aria-label={m.list.button || t('listFallback')}>
          {m.list.rows.map((row) => (
            <button key={row.id} type="button" role="option" aria-selected={false} onClick={() => onPickRow(row.id)} className="hover:bg-muted border-border block w-full border-b px-3 py-2 text-left last:border-b-0">
              <span className="block text-sm">{row.title}</span>
              {row.description && <span className="text-muted-foreground block text-xs">{row.description}</span>}
            </button>
          ))}
        </div>
      )}
      {m.buttons?.map((label, i) => (
        <button
          key={`${i}-${label}`}
          type="button"
          disabled={!active}
          onClick={() => onPickButton(i)}
          className={cn(
            'border-border bg-card text-primary rounded-lg border px-3 py-1.5 text-center text-sm font-medium shadow-sm transition-colors',
            active ? 'hover:bg-primary-soft' : 'opacity-60'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function noteText(m: PreviewMessage, t: T): string {
  switch (m.note) {
    case 'delay':
      return t('notes.delay', { seconds: Number(m.detail ?? 0) });
    case 'loop':
      return t('notes.loop', { limit: PREVIEW_STEP_LIMIT });
    case 'missing_node':
      return t('notes.missing_node', { key: m.detail ?? '' });
    case 'invalid_answer': {
      const [attempt, max] = (m.detail ?? '').split('/').map(Number);
      return t('notes.invalid_answer', { attempt: attempt || 0, max: max || 0 });
    }
    case 'timeout':
      return t('notes.timeout', { minutes: Number(m.detail) || 0 });
    case undefined:
      return '';
    default:
      return t(`notes.${m.note}`);
  }
}
