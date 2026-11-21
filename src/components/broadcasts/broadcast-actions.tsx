'use client';

// Row and header actions of a campaign (Campaigns redesign): open, edit or
// reschedule, send now, cancel schedule, pause, resume, cancel remaining,
// retry failed, create a segment from a result, duplicate and delete. The status decides which ones are offered; every
// action goes through its campaign route (session, role, campaigns.send).

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Ban, CalendarClock, Copy, Eye, Loader2, MoreHorizontal, Pause, Pencil, Play, RotateCcw, Send, Trash2, UsersRound, X,
} from 'lucide-react';
import type { Broadcast } from '@/types';
import { createClient } from '@/lib/data/client';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  cancelRemaining, cancelSchedule, createResultSegment, pauseCampaign, resumeCampaign, sendScheduledNow,
} from '@/lib/broadcasts/campaign-client';
import { SEGMENT_RESULTS, type SegmentResult } from '@/lib/audience/outcomes';

export type BroadcastAction =
  | 'open' | 'edit' | 'reschedule' | 'sendNow' | 'cancelSchedule' | 'pause' | 'resume' | 'cancelRemaining' | 'retryFailed'
  | 'createSegment' | 'duplicate' | 'delete';

/** Statuses whose recipients have results to split into a segment (matches lib/broadcasts/result-segment). */
const STARTED = new Set(['sending', 'paused', 'sent', 'failed', 'cancelled']);

type ActionRow = Pick<Broadcast, 'id' | 'name' | 'status' | 'failed_count' | 'total_recipients' | 'kind'>;

/** Which actions a campaign offers, in menu order (pure; unit-tested). */
export function availableActions(b: ActionRow, opts: { inDetail?: boolean; canSend: boolean }): BroadcastAction[] {
  const list: BroadcastAction[] = [];
  if (!opts.inDetail) list.push('open');
  if (opts.canSend) {
    if (b.status === 'draft') list.push('edit');
    if (b.status === 'scheduled') list.push(...(opts.inDetail ? [] : ['reschedule' as const]), 'sendNow', 'cancelSchedule');
    if (b.status === 'sending' && b.kind !== 'api') list.push('pause');
    if (b.status === 'paused') list.push('resume');
    if ((b.status === 'sending' || b.status === 'paused') && b.kind !== 'api') list.push('cancelRemaining');
    if ((b.status === 'sent' || b.status === 'failed') && (b.failed_count ?? 0) > 0) list.push('retryFailed');
    if (opts.inDetail && STARTED.has(b.status)) list.push('createSegment');
    if (b.kind !== 'api') list.push('duplicate');
    // Deleting is an agent write (data contract); a viewer gets no dead menu item.
    list.push('delete');
  }
  return list;
}

/** The one action the campaign page leads with, by status (none for a finished campaign without failures). */
export function primaryAction(b: ActionRow, canSend: boolean): BroadcastAction | null {
  if (!canSend) return null;
  if (b.status === 'draft') return 'edit';
  if (b.status === 'scheduled') return 'sendNow';
  if (b.status === 'sending' && b.kind !== 'api') return 'pause';
  if (b.status === 'paused') return 'resume';
  if ((b.status === 'sent' || b.status === 'failed') && (b.failed_count ?? 0) > 0) return 'retryFailed';
  return null;
}

const ICONS: Record<BroadcastAction, typeof Eye> = {
  open: Eye, edit: Pencil, reschedule: CalendarClock, sendNow: Send, cancelSchedule: X, pause: Pause, resume: Play,
  cancelRemaining: Ban, retryFailed: RotateCcw, createSegment: UsersRound, duplicate: Copy, delete: Trash2,
};

/**
 * The action runner shared by the list rows and the campaign page: one place
 * for the confirmations (send now, delete) and the calls. `onChanged` reloads
 * the caller's data; `afterDelete` lets the campaign page leave.
 */
export function useBroadcastActions({ onChanged, afterDelete }: { onChanged: () => void | Promise<void>; afterDelete?: () => void }) {
  const router = useRouter();
  const t = useTranslations('Campaigns.actions');
  const tc = useTranslations('Campaigns.sendControls');
  const canSend = useCan('send-messages');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'sendNow' | 'delete' | 'cancelRemaining'; b: ActionRow } | null>(null);
  const [segmentFor, setSegmentFor] = useState<ActionRow | null>(null);

  const label = (action: BroadcastAction, b: ActionRow): string =>
    action === 'open' ? (b.status === 'draft' ? t('open') : t('viewReport'))
      : action === 'edit' ? (b.status === 'draft' ? t('editAndSend') : t('edit'))
        : action === 'cancelRemaining' || action === 'createSegment' ? tc(action)
          : t(action);

  async function makeSegment(b: ActionRow, result: SegmentResult) {
    setBusy(b.id);
    try {
      const segment = await createResultSegment(b.id, result);
      setSegmentFor(null);
      toast.success(tc('toastSegmentCreated', { name: segment.name }), {
        action: { label: t('open'), onClick: () => router.push(`/contacts?segment=${encodeURIComponent(segment.id)}`) },
      });
    } catch (error) {
      toast.error(t('actionFailed', { error: error instanceof Error ? error.message : '' }));
    } finally {
      setBusy(null);
    }
  }

  async function guarded(b: ActionRow, work: () => Promise<unknown>, done: string) {
    setBusy(b.id);
    try {
      await work();
      toast.success(done);
      await onChanged();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && t.has(`errors.${code}`)) toast.error(t(`errors.${code}`));
      else toast.error(t('actionFailed', { error: error instanceof Error ? error.message : '' }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(b: ActionRow) {
    setBusy(b.id);
    // broadcast_recipients cascade on broadcasts.id; the data contract allows the delete to agents and up.
    const { error } = await createClient().from('broadcasts').delete().eq('id', b.id);
    setBusy(null);
    setConfirm(null);
    if (error) {
      toast.error(t('actionFailed', { error: error.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    if (afterDelete) afterDelete();
    else await onChanged();
  }

  function run(action: BroadcastAction, b: ActionRow) {
    switch (action) {
      case 'open':
      case 'reschedule':
        router.push(`/broadcasts/${b.id}`);
        return;
      case 'edit':
        router.push(`/broadcasts/new?from=${encodeURIComponent(b.id)}&draft=1`);
        return;
      case 'duplicate':
        router.push(`/broadcasts/new?from=${encodeURIComponent(b.id)}`);
        return;
      case 'sendNow':
        setConfirm({ kind: 'sendNow', b });
        return;
      case 'cancelRemaining':
        setConfirm({ kind: 'cancelRemaining', b });
        return;
      case 'createSegment':
        setSegmentFor(b);
        return;
      case 'delete':
        if (b.status === 'sending') {
          toast.error(t('cannotDeleteSending'));
          return;
        }
        setConfirm({ kind: 'delete', b });
        return;
      case 'cancelSchedule':
        void guarded(b, () => cancelSchedule(b.id), t('toastUnscheduled'));
        return;
      case 'pause':
        void guarded(b, () => pauseCampaign(b.id), t('toastPaused'));
        return;
      case 'resume':
        void guarded(b, () => resumeCampaign(b.id, 'pending'), t('toastResumed'));
        return;
      case 'retryFailed':
        void guarded(b, () => resumeCampaign(b.id, 'failed'), t('toastRetry'));
        return;
    }
  }

  const dialogs: ReactNode = (
    <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {confirm?.kind === 'delete' ? t('confirmDeleteTitle') : confirm?.kind === 'cancelRemaining' ? tc('cancelRemainingTitle') : t('confirmSendTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {confirm?.kind === 'delete'
              ? t('confirmDeleteBody', { name: confirm.b.name })
              : confirm?.kind === 'cancelRemaining'
                ? tc('cancelRemainingBody', { name: confirm.b.name })
                : t('confirmSendBody', { name: confirm?.b.name ?? '', count: confirm?.b.total_recipients ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy !== null}>{t('cancel')}</Button>
          {confirm?.kind === 'cancelRemaining' ? (
            <Button variant="destructive" disabled={busy !== null} onClick={() => {
              const target = confirm.b;
              setConfirm(null);
              void guarded(target, async () => {
                const result = await cancelRemaining(target.id);
                // Rows whose send outcome is unknown stay for reconciliation on the campaign page.
                if (result.heldForReview > 0) toast.warning(tc('heldForReview', { count: result.heldForReview }));
              }, tc('toastCancelled'));
            }}>
              <Ban />
              {tc('cancelRemaining')}
            </Button>
          ) : confirm?.kind === 'delete' ? (
            <Button variant="destructive" disabled={busy !== null} onClick={() => void remove(confirm.b)}>
              {busy && <Loader2 className="animate-spin" />}
              {t('delete')}
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={() => {
              const target = confirm?.b;
              if (!target) return;
              setConfirm(null);
              void guarded(target, () => sendScheduledNow(target.id), t('toastStarted'));
            }}>
              <Send />
              {t('sendNow')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const segmentDialog: ReactNode = (
    <Dialog open={segmentFor !== null} onOpenChange={(open) => { if (!open && !busy) setSegmentFor(null); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tc('createSegment')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{tc('createSegmentHint')}</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {SEGMENT_RESULTS.map((result) => (
            <button
              key={result}
              type="button"
              disabled={busy !== null}
              onClick={() => { if (segmentFor) void makeSegment(segmentFor, result); }}
              className="flex min-h-11 w-full items-center px-4 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
            >
              {tc(`segmentResults.${result}`)}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setSegmentFor(null)} disabled={busy !== null}>{t('cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { run, label, busy, canSend, dialogs: <>{dialogs}{segmentDialog}</>, icon: (action: BroadcastAction) => ICONS[action] };
}

export type BroadcastActions = ReturnType<typeof useBroadcastActions>;

/** The "More" button with the campaign's actions; render `actions.dialogs` once per page. */
export function BroadcastActionsMenu({ broadcast, actions, inDetail, exclude = [] }: {
  broadcast: ActionRow;
  actions: BroadcastActions;
  inDetail?: boolean;
  /** Actions already shown as buttons next to the menu. */
  exclude?: BroadcastAction[];
}) {
  const t = useTranslations('Campaigns.actions');
  const items = availableActions(broadcast, { inDetail, canSend: actions.canSend }).filter((a) => !exclude.includes(a));
  const working = actions.busy === broadcast.id;
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={inDetail ? t('more') : t('moreFor', { name: broadcast.name })}
            onClick={(e) => e.stopPropagation()}
            disabled={working}
          />
        }
      >
        {working ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        {items.map((action) => {
          const Icon = actions.icon(action);
          return (
            <span key={action} className="contents">
              {action === 'delete' && items.length > 1 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                variant={action === 'delete' || action === 'cancelRemaining' ? 'destructive' : 'default'}
                disabled={action === 'delete' && broadcast.status === 'sending'}
                onClick={() => actions.run(action, broadcast)}
              >
                <Icon />
                {actions.label(action, broadcast)}
              </DropdownMenuItem>
            </span>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
