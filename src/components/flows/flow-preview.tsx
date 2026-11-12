'use client';

/**
 * Phone preview of the flow being edited, floating over the canvas: a dark
 * WhatsApp chat or, for an Instagram flow, a light Instagram Direct thread (Stage 1; Stage 2 adds the
 * comment reply, private reply, cards and link buttons). Plays the live
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
import { ClipboardList, ExternalLink, FileText, Image as ImageIcon, List, MapPin, MessageCircle, Music, RotateCcw, SendHorizontal, Video, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { choose, PREVIEW_STEP_LIMIT, startPreview, type PreviewMessage, type PreviewState } from '@/lib/flows/preview';
import { useFlowEditor } from './flow-editor-state';
import { PhoneAvatar, PhoneFrame, type PhoneChannel } from './phone-frame';

/**
 * `floating`: over the canvas, left of its tools. Otherwise (the Simple
 * builder, whose settings must stay usable) a column beside the view.
 */
export function FlowPreview({ onClose, floating = true }: { onClose: () => void; floating?: boolean }) {
  const t = useTranslations('Flows.builder.preview');
  const { account } = useAuth();
  const { state, channelScope } = useFlowEditor();
  const instagram = channelScope === 'instagram';

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

  const phone: PhoneChannel = instagram ? 'instagram' : 'whatsapp';
  const dark = phone === 'whatsapp';
  // Choices the customer makes outside a bubble: a branch, a simulated share or timeout, a typed answer.
  const footer = (waiting?.kind === 'branch' || (waiting && waiting.simulate.length > 0) || waiting?.kind === 'text') ? (
    <div className="flex flex-col gap-2">
      {waiting?.kind === 'branch' && (
        <>
          <p className={cn('text-xs', dark ? 'text-white/55' : 'text-black/60')}>{t('chooseBranch')}</p>
          <div className="flex flex-wrap gap-1.5">
            {waiting.options.map((o) => (
              <button key={o.id} type="button" onClick={() => pick(o.id)} className={phoneChip(dark)}>{branchLabel(o.id, o.label, t)}</button>
            ))}
          </div>
        </>
      )}
      {waiting && waiting.simulate.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {waiting.simulate.map((o) => (
            <button key={o.id} type="button" onClick={() => pick(o.id)} className={cn(phoneChip(dark), 'border-dashed')}>
              {o.id === 'share'
                ? t(run.nodes.find((n) => n.node_key === run.at)?.node_type === 'ask_location' ? 'simulate.shareLocation' : 'simulate.shareMedia')
                : t(o.id === 'submit' ? 'simulate.submitForm' : o.id === 'timeout' ? 'simulate.timeout' : 'simulate.exhausted')}
            </button>
          ))}
        </div>
      )}
      {waiting?.kind === 'text' && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) pick('text', answer);
          }}
        >
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('answerPlaceholder')} aria-label={t('answerPlaceholder')} autoFocus
            className={cn('h-9 min-w-0 flex-1 rounded-full px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary',
              dark ? 'bg-[#2c3541] text-white placeholder:text-white/40' : 'bg-[#efefef] text-black placeholder:text-black/40')} />
          <button type="submit" disabled={!answer.trim()} aria-label={t('send')}
            className="bg-primary text-primary-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:opacity-40">
            <SendHorizontal className="h-4 w-4" />
          </button>
        </form>
      )}
    </div>
  ) : undefined;

  return (
    // A handset beside the builder; on a phone it covers the editor.
    <aside
      className={cn('absolute inset-0 z-30 flex items-center justify-center gap-3 bg-background/70 p-4 backdrop-blur-sm sm:items-start sm:p-0 sm:backdrop-blur-none',
        floating ? 'sm:inset-auto sm:bottom-4 sm:right-20 sm:top-4 sm:bg-transparent'
          : 'sm:static sm:shrink-0 sm:border-l sm:border-border sm:bg-card-2 sm:px-4 sm:py-4')}
      aria-label={t('title')}
      data-preview-channel={phone}
    >
      <PhoneFrame
        channel={phone}
        title={account?.name || t('phoneBusiness')}
        subtitle={instagram ? t('phoneSubtitleInstagram') : t('phoneSubtitleWhatsapp')}
        footer={footer}
        live
      >
        {run.messages.length === 0 && <p className={cn('px-4 py-8 text-center text-xs', dark ? 'text-white/55' : 'text-black/60')}>{t('empty')}</p>}
        {run.messages.map((m) => (
          <PhoneBubble
            key={m.id}
            message={m}
            channel={phone}
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
        {run.ended && run.messages.length > 0 && <p className={cn('pt-2 text-center text-[11px] uppercase tracking-wider', dark ? 'text-white/60' : 'text-black/60')}>{t('ended')}</p>}
        <div ref={endRef} />
      </PhoneFrame>
      <div className="flex flex-col gap-2">
        <button type="button" onClick={onClose} aria-label={t('close')} title={t('close')} className={PHONE_CONTROL}><X className="h-5 w-5" /></button>
        <button type="button" onClick={restart} aria-label={t('restart')} title={t('restart')} className={PHONE_CONTROL}><RotateCcw className="h-5 w-5" /></button>
      </div>
    </aside>
  );
}

/** The dark square buttons beside the phone. */
const PHONE_CONTROL = 'flex h-11 w-11 items-center justify-center rounded-lg bg-[#1f2329] text-white shadow-lg transition-colors hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const phoneChip = (dark: boolean) => cn('rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
  dark ? 'border-white/20 text-white hover:bg-white/10' : 'border-black/15 text-black hover:bg-black/5');

/**
 * One message inside the phone: the business's bubbles on the left beside its
 * avatar with their buttons inside the bubble (WhatsApp) or under it
 * (Instagram), the customer's on the right, notes in between.
 */
export function PhoneBubble({ message: m, channel, active, listOpen = false, onToggleList, onPickButton, onPickRow, t }: {
  message: PreviewMessage;
  channel: PhoneChannel;
  active: boolean;
  listOpen?: boolean;
  onToggleList?: () => void;
  onPickButton?: (index: number) => void;
  onPickRow?: (id: string) => void;
  t: T;
}) {
  const dark = channel === 'whatsapp';
  if (m.from === 'system') {
    return <p className={cn('mx-auto max-w-[90%] text-center text-[11px]', dark ? 'text-white/60' : 'text-black/60')}>{noteText(m, t)}</p>;
  }
  if (m.from === 'customer') {
    return (
      <div className={cn('ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px]',
        dark ? 'bg-[#005c4b] text-white' : 'bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white')}>
        {m.shared ? (
          <span className="flex items-center gap-1.5 italic">
            {m.shared === 'location' ? <MapPin className="h-4 w-4 shrink-0" /> : m.shared === 'form' ? <ClipboardList className="h-4 w-4 shrink-0" /> : <ImageIcon className="h-4 w-4 shrink-0" />}
            {t(m.shared === 'location' ? 'shared.location' : m.shared === 'form' ? 'shared.form' : 'shared.media')}
          </span>
        ) : m.text}
      </div>
    );
  }
  const MediaIcon = m.media?.type === 'video' ? Video : m.media?.type === 'document' ? FileText : m.media?.type === 'audio' ? Music : ImageIcon;
  const empty = !m.text && !m.media && !m.template && !m.cards;
  const muted = dark ? 'text-white/55' : 'text-black/60';
  const tap = (enabled: boolean) => cn('w-full rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors',
    dark ? 'bg-[#3b4552] text-white' : 'border border-black/10 bg-white text-[#0b62d6]',
    enabled ? (dark ? 'hover:bg-[#46515f]' : 'hover:bg-black/5') : 'cursor-default opacity-70');
  const buttons = (
    <>
      {m.buttons?.map((label, i) => (
        <button key={`${i}-${label}`} type="button" disabled={!active} onClick={() => onPickButton?.(i)} className={tap(active)}>{label}</button>
      ))}
      {m.links?.map((label, i) => (
        <span key={`link-${i}`} className={cn(tap(false), 'flex items-center justify-center gap-1.5 opacity-100')}><ExternalLink className="h-3.5 w-3.5" />{label}</span>
      ))}
      {m.list && (
        <button type="button" disabled={!active} onClick={onToggleList} aria-expanded={listOpen} className={cn(tap(active), 'flex items-center justify-center gap-1.5')}>
          <List className="h-3.5 w-3.5" />{m.list.button || t('listFallback')}
        </button>
      )}
    </>
  );
  const hasActions = !!(m.buttons?.length || m.links?.length || m.list);
  return (
    <div className="mr-auto flex max-w-[92%] items-end gap-2">
      <PhoneAvatar channel={channel} />
      <div className="flex min-w-0 flex-col gap-1.5">
        {m.cards ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {m.cards.map((card, i) => (
              <div key={i} className="w-48 shrink-0 overflow-hidden rounded-2xl border border-black/10 bg-white text-black">
                {card.hasImage && <div className="flex h-24 items-center justify-center bg-[#efefef] text-black/40"><ImageIcon className="h-6 w-6" /></div>}
                <div className="px-3 py-2">
                  <p className="break-words text-sm font-semibold">{card.title || <span className="italic text-black/40">{t('emptyMessage')}</span>}</p>
                  {card.subtitle && <p className="break-words text-xs text-black/55">{card.subtitle}</p>}
                </div>
                {card.buttons.map((btn, j) => (btn.replyId ? (
                  <button key={j} type="button" disabled={!active} onClick={() => onPickRow?.(btn.replyId!)}
                    className={cn('block w-full border-t border-black/10 px-3 py-1.5 text-center text-sm font-medium text-[#0b62d6]', active ? 'hover:bg-black/5' : 'opacity-70')}>
                    {btn.label}
                  </button>
                ) : (
                  <span key={j} className="flex w-full items-center justify-center gap-1.5 border-t border-black/10 px-3 py-1.5 text-sm font-medium text-[#0b62d6]"><ExternalLink className="h-3.5 w-3.5" />{btn.label}</span>
                )))}
              </div>
            ))}
          </div>
        ) : (
          <div className={cn('text-[15px] leading-snug', dark ? 'rounded-2xl bg-[#2c3541] p-3.5 text-white' : 'rounded-3xl bg-[#efefef] px-4 py-2.5 text-[#111]')}>
            {m.media && (
              <div className={cn('mb-2 flex items-center gap-2 rounded-lg px-3 py-4 text-xs', dark ? 'bg-white/10 text-white/70' : 'bg-white text-black/55')}>
                <MediaIcon className="h-5 w-5 shrink-0" />
                <span className="truncate">{m.media.filename || t(`media.${m.media.type === 'video' || m.media.type === 'document' || m.media.type === 'audio' ? m.media.type : 'image'}`)}</span>
              </div>
            )}
            {m.template !== undefined && <p className={cn('text-xs italic', muted)}>{m.template ? t('template', { name: m.template }) : t('templateUnset')}</p>}
            {m.header && <p className="mb-1 whitespace-pre-wrap break-words font-semibold">{m.header}</p>}
            {m.publicReply && <p className={cn('mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider', muted)}><MessageCircle className="h-3 w-3" />{t('publicReply')}</p>}
            {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
            {empty && <p className={cn('italic', muted)}>{t('emptyMessage')}</p>}
            {m.footer && <p className={cn('mt-1 whitespace-pre-wrap break-words text-xs', muted)}>{m.footer}</p>}
            {/* WhatsApp draws the reply buttons inside the bubble. */}
            {dark && hasActions && <div className="mt-3 flex flex-col gap-1.5">{buttons}</div>}
          </div>
        )}
        {!dark && hasActions && <div className="flex flex-col gap-1.5">{buttons}</div>}
        {m.list && listOpen && active && (
          <div className={cn('overflow-hidden rounded-xl', dark ? 'bg-[#2c3541]' : 'border border-black/10 bg-white')} role="listbox" aria-label={m.list.button || t('listFallback')}>
            {m.list.rows.map((row) => (
              <button key={row.id} type="button" role="option" aria-selected={false} onClick={() => onPickRow?.(row.id)}
                className={cn('block w-full border-b px-3 py-2 text-left last:border-b-0', dark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5')}>
                <span className="block text-sm">{row.title}</span>
                {row.description && <span className={cn('block text-xs', muted)}>{row.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export type PreviewT = ReturnType<typeof useTranslations>;
type T = PreviewT;

export function branchLabel(id: string, label: string, t: T) {
  if (id === 'true') return t('branchTrue');
  if (id === 'false') return t('branchFalse');
  if (id === 'fallback') return t('branchFallback');
  return label || id;
}

/** One trace message; reused by the dry-run panel. `instagram` draws Direct-style rounded bubbles. */
export function Bubble({ message: m, active, listOpen, onToggleList, onPickButton, onPickRow, instagram = false, t }: {
  message: PreviewMessage;
  active: boolean;
  listOpen: boolean;
  onToggleList: () => void;
  onPickButton: (index: number) => void;
  onPickRow: (id: string) => void;
  instagram?: boolean;
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
      <div className={cn('ml-auto max-w-[80%] whitespace-pre-wrap break-words px-3 py-2 text-sm shadow-sm',
        instagram ? 'rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white' : 'bg-primary-soft-2 text-foreground rounded-lg rounded-tr-none')}>
        {m.shared ? (
          <span className="flex items-center gap-1.5 italic">
            {m.shared === 'location' ? <MapPin className="h-4 w-4 shrink-0" /> : m.shared === 'form' ? <ClipboardList className="h-4 w-4 shrink-0" /> : <ImageIcon className="h-4 w-4 shrink-0" />}
            {t(m.shared === 'location' ? 'shared.location' : m.shared === 'form' ? 'shared.form' : 'shared.media')}
          </span>
        ) : m.text}
      </div>
    );
  }
  const MediaIcon = m.media?.type === 'video' ? Video : m.media?.type === 'document' ? FileText : m.media?.type === 'audio' ? Music : ImageIcon;
  if (m.cards) return <CardsBubble message={m} active={active} onPickRow={onPickRow} t={t} />;
  const empty = !m.text && !m.media && !m.template;
  return (
    <div className="mr-auto flex max-w-[85%] flex-col gap-1">
      <div className={cn('text-foreground px-3 py-2 text-sm', instagram ? 'bg-muted rounded-2xl' : 'border-border bg-card rounded-lg rounded-tl-none border shadow-sm')}>
        {m.media && (
          <div className="bg-muted text-muted-foreground mb-2 flex items-center gap-2 rounded-md px-3 py-4 text-xs">
            <MediaIcon className="h-5 w-5 shrink-0" />
            <span className="truncate">{m.media.filename || t(`media.${m.media.type === 'video' || m.media.type === 'document' || m.media.type === 'audio' ? m.media.type : 'image'}`)}</span>
          </div>
        )}
        {m.template !== undefined && <p className="text-muted-foreground text-xs italic">{m.template ? t('template', { name: m.template }) : t('templateUnset')}</p>}
        {m.header && <p className="mb-1 whitespace-pre-wrap break-words font-semibold">{m.header}</p>}
        {m.publicReply && <PublicReplyLabel />}
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
      {m.links?.map((label, i) => <LinkChip key={`link-${i}`} label={label} />)}
    </div>
  );
}

/** Marks a bot bubble as the public reply under the customer's comment. */
function PublicReplyLabel() {
  const tNodes = useTranslations('Flows.builder.nodes');
  return (
    <p className="text-muted-foreground mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider">
      <MessageCircle className="h-3 w-3" />{tNodes('ig_comment_reply.label')}
    </p>
  );
}

/** A link button: shown as Instagram draws it, never tappable here (a link tap does not continue the flow). */
function LinkChip({ label }: { label: string }) {
  return (
    <span className="border-border bg-card text-primary flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium opacity-80 shadow-sm">
      <ExternalLink className="h-3.5 w-3.5" />{label}
    </span>
  );
}

/** Instagram cards (a gallery scrolls sideways); postback buttons answer the wait like reply buttons. */
function CardsBubble({ message: m, active, onPickRow, t }: { message: PreviewMessage; active: boolean; onPickRow: (id: string) => void; t: T }) {
  return (
    <div className="mr-auto flex max-w-[90%] gap-2 overflow-x-auto pb-1">
      {(m.cards ?? []).map((card, i) => (
        <div key={i} className="border-border bg-card w-52 shrink-0 overflow-hidden rounded-2xl border shadow-sm">
          {card.hasImage && <div className="bg-muted text-muted-foreground flex h-24 items-center justify-center"><ImageIcon className="h-6 w-6" /></div>}
          <div className="px-3 py-2">
            <p className="text-sm font-semibold break-words">{card.title || <span className="text-muted-foreground italic">{t('emptyMessage')}</span>}</p>
            {card.subtitle && <p className="text-muted-foreground text-xs break-words">{card.subtitle}</p>}
          </div>
          {card.buttons.map((b, j) => (b.replyId ? (
            <button key={j} type="button" disabled={!active} onClick={() => onPickRow(b.replyId!)}
              className={cn('border-border text-primary block w-full border-t px-3 py-1.5 text-center text-sm font-medium', active ? 'hover:bg-primary-soft' : 'opacity-60')}>
              {b.label}
            </button>
          ) : (
            <span key={j} className="border-border text-primary flex w-full items-center justify-center gap-1.5 border-t px-3 py-1.5 text-sm font-medium opacity-80">
              <ExternalLink className="h-3.5 w-3.5" />{b.label}
            </span>
          )))}
        </div>
      ))}
    </div>
  );
}

export function noteText(m: PreviewMessage, t: T): string {
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
    case 'condition_result':
      return t(m.detail === 'true' ? 'notes.condition_true' : 'notes.condition_false');
    case 'api_port':
      return t('notes.api_port', { port: m.detail ?? '' });
    case undefined:
      return '';
    default:
      return t(`notes.${m.note}`);
  }
}
