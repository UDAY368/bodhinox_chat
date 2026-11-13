'use client';

// Small display pieces for campaigns (Campaigns redesign): the channel dot,
// the "when" line, the sent percentage, and the phone-style message preview
// used by the wizard and the campaign report.

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Broadcast, BroadcastStatus } from '@/types';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** True once a campaign has started sending (drafts and scheduled ones have no numbers yet). */
export function broadcastStarted(status: BroadcastStatus): boolean {
  return status !== 'draft' && status !== 'scheduled' && status !== 'cancelled';
}

/** Share of the audience already attempted (sent or failed), 0-100. */
export function sentPercent(b: Pick<Broadcast, 'sent_count' | 'failed_count' | 'total_recipients'>): number {
  if (!b.total_recipients) return 0;
  return Math.min(100, Math.round(((b.sent_count + b.failed_count) / b.total_recipients) * 100));
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

type WhenFields = Pick<Broadcast, 'status' | 'scheduled_at' | 'created_at'> & Partial<Pick<Broadcast, 'started_at' | 'finished_at'>>;

/**
 * "Sends 14 Nov, 9:00", "Started ...", "Paused", "Not sent yet", "Sent ...", "Failed ...". `t` is the Campaigns
 * namespace. Started and finished times come from the send itself (started_at / finished_at); rows from before
 * those columns fall back to the schedule time, then the creation time.
 */
export function broadcastWhen(b: WhenFields, t: Translate): string {
  const started = b.started_at ?? b.scheduled_at ?? b.created_at;
  switch (b.status) {
    case 'draft': return t('when.draft');
    case 'scheduled': return t('when.scheduled', { when: when(b.scheduled_at) });
    case 'sending': return t('when.sending', { when: when(started) });
    case 'paused': return t('when.paused');
    case 'cancelled': return t('when.cancelled');
    case 'failed': return t('when.failed', { when: when(b.finished_at ?? started) });
    default: return t('when.sent', { when: when(b.finished_at ?? started) });
  }
}

/** How often the list's per-status tab counts are re-read while it polls a sending campaign. */
export const COUNTS_REFRESH_MS = 30_000;

/** A page of rows reduced to what the tab counts depend on: each row's id and status. */
export function statusSignature(rows: ReadonlyArray<Pick<Broadcast, 'id' | 'status'>>): string {
  return rows.map((r) => `${r.id}:${r.status}`).join(',');
}

/**
 * Whether a list fetch should also re-read the per-status counts (eight head-only queries): always for a fetch
 * the member caused (load, tab, search, page, an action), and on a poll only when a listed campaign changed
 * status or the counts are COUNTS_REFRESH_MS old.
 */
export function shouldRefreshCounts(input: { poll: boolean; prevSignature: string | null; nextSignature: string; lastAt: number | null; now: number }): boolean {
  if (!input.poll || input.lastAt === null || input.prevSignature === null) return true;
  if (input.prevSignature !== input.nextSignature) return true;
  return input.now - input.lastAt >= COUNTS_REFRESH_MS;
}

export function ChannelDot({ channel, className }: { channel: 'whatsapp' | 'instagram'; className?: string }) {
  return (
    <i
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        channel === 'instagram' ? 'bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600' : 'bg-emerald-500',
        className,
      )}
    />
  );
}

/** A phone frame around a chat, as the prototype draws message previews. */
export function PhoneFrame({ who, children, className }: { who: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[270px] rounded-[28px] border border-border bg-card p-2 shadow-sm', className)}>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-2.5 text-[13px] font-semibold text-foreground">
        <span aria-hidden className="inline-flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
          {who.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">{who}</span>
      </div>
      <div className="flex max-h-[400px] min-h-[200px] flex-col gap-1 overflow-y-auto rounded-[20px] bg-muted px-2.5 py-3">{children}</div>
    </div>
  );
}

/**
 * A text chat bubble. `{first name}` shows as the sample name in bold, or as
 * a highlighted token when there is no sample.
 */
export function TextBubble({ text, sampleName, emptyLabel }: { text: string; sampleName?: string | null; emptyLabel: string }) {
  const parts = text.split('{first name}');
  return (
    <div className="flex w-fit max-w-[94%] flex-col gap-0.5 self-start rounded-[4px_14px_14px_14px] bg-card px-2.5 pt-2 pb-1.5 text-[13px] text-foreground shadow-sm [overflow-wrap:anywhere]">
      <p className="whitespace-pre-wrap">
        {text.trim()
          ? parts.map((part, i) => (
            <span key={i}>
              {part}
              {i < parts.length - 1 && (sampleName
                ? <b className="font-semibold">{sampleName}</b>
                : <mark className="rounded bg-primary/15 px-1 font-semibold text-primary">{'{first name}'}</mark>)}
            </span>
          ))
          : <span className="text-muted-foreground">{emptyLabel}</span>}
      </p>
      <time className="self-end text-[10px] text-muted-foreground">10:24</time>
    </div>
  );
}
