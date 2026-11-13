'use client';

// Row and header actions of a campaign (Campaigns redesign): open, edit or
// reschedule, send now, cancel schedule, pause, resume, retry failed,
// duplicate and delete. The status decides which ones are offered; every
// action goes through its campaign route (session, role, campaigns.send).

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CalendarClock, Copy, Eye, Loader2, MoreHorizontal, Pause, Pencil, Play, RotateCcw, Send, Trash2, X,
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
  cancelSchedule, pauseCampaign, resumeCampaign, sendScheduledNow,
} from '@/lib/broadcasts/campaign-client';

export type BroadcastAction =
  | 'open' | 'edit' | 'reschedule' | 'sendNow' | 'cancelSchedule' | 'pause' | 'resume' | 'retryFailed' | 'duplicate' | 'delete';

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
    if ((b.status === 'sent' || b.status === 'failed') && (b.failed_count ?? 0) > 0) list.push('retryFailed');
    if (b.kind !== 'api') list.push('duplicate');
  }
  list.push('delete');
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
  retryFailed: RotateCcw, duplicate: Copy, delete: Trash2,
};

/**
 * The action runner shared by the list rows and the campaign page: one place
 * for the confirmations (send now, delete) and the calls. `onChanged` reloads
 * the caller's data; `afterDelete` lets the campaign page leave.
 */
export function useBroadcastActions({ onChanged, afterDelete }: { onChanged: () => void | Promise<void>; afterDelete?: () => void }) {
  const router = useRouter();
  const t = useTranslations('Campaigns.actions');
  const canSend = useCan('send-messages');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'sendNow' | 'delete'; b: ActionRow } | null>(null);

  const label = (action: BroadcastAction, b: ActionRow): string =>
    action === 'open' ? (b.status === 'draft' ? t('open') : t('viewReport'))
      : action === 'edit' ? (b.status === 'draft' ? t('editAndSend') : t('edit'))
        : t(action);

  async function guarded(b: ActionRow, work: () => Promise<unknown>, done: string) {
    setBusy(b.id);
    try {
      await work();
      toast.success(done);
      await onChanged();
    } catch (error) {
      toast.error(t('actionFailed', { error: error instanceof Error ? error.message : '' }));
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
          <DialogTitle>{confirm?.kind === 'delete' ? t('confirmDeleteTitle') : t('confirmSendTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {confirm?.kind === 'delete'
              ? t('confirmDeleteBody', { name: confirm.b.name })
              : t('confirmSendBody', { name: confirm?.b.name ?? '', count: confirm?.b.total_recipients ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy !== null}>{t('cancel')}</Button>
          {confirm?.kind === 'delete' ? (
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

  return { run, label, busy, canSend, dialogs, icon: (action: BroadcastAction) => ICONS[action] };
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
                variant={action === 'delete' ? 'destructive' : 'default'}
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
