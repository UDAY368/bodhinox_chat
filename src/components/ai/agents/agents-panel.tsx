'use client';

// AI page, Agents tab: every AI agent as a card (role, tone, goal, channels,
// hours, conversations handled, share solved, on/off), with All/On/Off
// filters, search, a menu (test, edit, duplicate, move, delete), the editor
// dialog and the docked test chat. Admins change agents; agents and above
// test them; everyone sees the list (GET /api/ai/agents).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Clock, Copy, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';
import { cn } from '@/lib/utils';
import { AgentDialog } from './agent-dialog';
import { AgentTestPanel } from './agent-test-panel';
import { filterAgents, solvedPct, type AgentFilter, type AgentView } from './agent-view';

export function AgentsPanel({ canEdit, canTest, newRequest }: {
  /** Admins: create, edit, switch, duplicate, reorder and delete. */
  canEdit: boolean;
  /** Agents and above: open the test chat. */
  canTest: boolean;
  /** A new object each time the page header's "New agent" button is pressed. */
  newRequest: object | null;
}) {
  const t = useTranslations('AiStudio');
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ agent: AgentView | null; key: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentView | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/ai/agents', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error();
      setAgents(data.agents ?? []);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The header button opens a new agent, once per press.
  const [seenRequest, setSeenRequest] = useState<object | null>(null);
  if (newRequest && seenRequest !== newRequest) {
    setSeenRequest(newRequest);
    if (canEdit) setEditing({ agent: null, key: 'new' });
  }

  const roleLabel = useCallback((role: AgentView['role']) => t(`agents.roles.${role}`), [t]);
  const list = useMemo(() => filterAgents(agents ?? [], filter, query, roleLabel), [agents, filter, query, roleLabel]);
  const onCount = (agents ?? []).filter((a) => a.enabled).length;
  const testing = agents?.find((a) => a.id === testingId) ?? null;

  const patch = async (agent: AgentView, body: Record<string, unknown>, success?: string) => {
    setPending(agent.id);
    try {
      const res = await authFetch(`/api/ai/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('agents.toasts.failed')); return; }
      if (body.move) await load();
      else setAgents((all) => (all ?? []).map((a) => (a.id === agent.id ? { ...data.agent, stats: a.stats } : a)));
      if (success) toast.success(success);
    } catch {
      toast.error(t('agents.toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const duplicate = async (agent: AgentView) => {
    setPending(agent.id);
    try {
      const res = await authFetch(`/api/ai/agents/${agent.id}/duplicate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('agents.toasts.failed')); return; }
      setFilter('all');
      await load();
      toast.success(t('agents.toasts.duplicated', { name: data.agent.name }));
    } catch {
      toast.error(t('agents.toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const remove = async (agent: AgentView) => {
    setPending(agent.id);
    try {
      const res = await authFetch(`/api/ai/agents/${agent.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('agents.toasts.failed')); return; }
      setAgents((all) => (all ?? []).filter((a) => a.id !== agent.id));
      if (testingId === agent.id) setTestingId(null);
      setDeleting(null);
      toast.success(t('agents.toasts.deleted'));
    } catch {
      toast.error(t('agents.toasts.failed'));
    } finally {
      setPending(null);
    }
  };

  const hoursText = (a: AgentView) => a.hours.mode === 'always' ? t('agents.hoursAlways')
    : t(a.hours.mode === 'during' ? 'agents.hoursDuring' : 'agents.hoursOutside', { from: a.hours.from ?? '', to: a.hours.to ?? '' });

  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        <p className="text-destructive">{t('agents.toasts.loadFailed')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    );
  }
  if (!agents) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t('common.loading')} /></div>;

  const filters: [AgentFilter, string, number][] = [
    ['all', t('agents.filterAll'), agents.length], ['on', t('agents.filterOn'), onCount], ['off', t('agents.filterOff'), agents.length - onCount],
  ];
  const ids = agents.map((a) => a.id);

  return (
    <div className={cn('min-w-0', testing && 'xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start xl:gap-4')}>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className={segmentedTrack} role="group" aria-label={t('agents.filterLabel')}>
            {filters.map(([id, label, n]) => (
              <button key={id} type="button" aria-pressed={filter === id} className={segmentedItem(filter === id)} onClick={() => setFilter(id)}>
                {label} <b className="font-semibold tabular-nums">{n}</b>
              </button>
            ))}
          </div>
          <label className="relative flex h-9 w-full min-w-0 items-center sm:w-64">
            <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agents.search')} aria-label={t('agents.search')}
              className="h-9 w-full rounded-full border border-border bg-card pr-3 pl-9 text-sm outline-none transition-colors duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" />
          </label>
        </div>
        {agents.length > 1 && <p className="text-xs text-muted-foreground">{t('agents.orderHint')}</p>}

        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary"><Sparkles className="size-5" aria-hidden /></span>
            <h2 className="text-base font-semibold">{t('agents.emptyTitle')}</h2>
            <p className="max-w-sm text-sm text-muted-foreground">{t('agents.emptyBody')}</p>
            {canEdit && <Button type="button" variant="outline" onClick={() => setEditing({ agent: null, key: 'new' })}><Plus aria-hidden />{t('agents.createFirst')}</Button>}
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-12 text-center">
            <h2 className="text-base font-semibold">{t('agents.noMatchTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('agents.noMatchBody')}</p>
            <Button type="button" variant="outline" onClick={() => { setFilter('all'); setQuery(''); }}>{t('agents.clearFilters')}</Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3.5">
            {list.map((a) => {
              const pct = solvedPct(a.stats);
              const index = ids.indexOf(a.id);
              return (
                <article key={a.id} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 transition-[border-color,box-shadow] duration-150 hover:shadow-[0_6px_24px_rgb(0_0_0/0.08)]',
                  testingId === a.id ? 'border-primary' : 'border-border')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[11px]', a.enabled ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground')}>
                        <Sparkles className="size-4" aria-hidden />
                      </span>
                      <div className="min-w-0 leading-tight">
                        <strong className="block truncate text-[15px] font-semibold">{a.name}</strong>
                        <small className="block truncate text-xs text-muted-foreground">
                          {a.tone ? t('agents.roleTone', { role: roleLabel(a.role), tone: t(`agents.tones.${a.tone}`) }) : t('agents.roleOnly', { role: roleLabel(a.role) })}
                        </small>
                      </div>
                    </div>
                    <Switch checked={a.enabled} disabled={!canEdit || a.synthetic || pending === a.id} aria-label={t('agents.toggleLabel', { name: a.name })}
                      onCheckedChange={(v: boolean) => void patch(a, { enabled: v }, t(v ? 'agents.toasts.on' : 'agents.toasts.off', { name: a.name }))} />
                  </div>
                  <p className="line-clamp-2 min-h-[2.5rem] text-[13px] text-muted-foreground">{a.instructions || t('agents.noGoal')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {a.channels.map((c) => (
                      <Badge key={c} variant="outline" className="rounded-full">
                        <span aria-hidden className={cn('size-1.5 rounded-full', c === 'whatsapp' ? 'bg-emerald-500' : 'bg-pink-500')} />{t(`agents.channels.${c}`)}
                      </Badge>
                    ))}
                    <Badge variant="outline" className="rounded-full"><Clock aria-hidden />{hoursText(a)}</Badge>
                    {a.is_default && <Badge variant="secondary" className="rounded-full">{t('agents.defaultBadge')}</Badge>}
                  </div>
                  {a.synthetic && <p className="text-xs text-muted-foreground">{t('agents.legacyHint')}</p>}
                  {a.stats && (
                    <div className="grid grid-cols-2 gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
                      <span><b className="block text-[17px] font-bold tabular-nums text-foreground">{a.stats.handled.toLocaleString()}</b>{t('agents.handled')}</span>
                      <span><b className="block text-[17px] font-bold tabular-nums text-foreground">{pct === null ? t('agents.newLabel') : `${pct}%`}</b>{pct === null ? t('agents.noChats') : t('agents.solved')}</span>
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                    <Badge variant={a.enabled ? 'default' : 'outline'} className="rounded-full">{a.enabled ? t('agents.statusOn') : t('agents.statusOff')}</Badge>
                    <div className="flex items-center gap-1.5">
                      {canTest && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setTestingId(a.id)}>
                          <MessageSquare aria-hidden />{t('agents.test')}
                        </Button>
                      )}
                      {canEdit && !a.synthetic && <Button type="button" size="sm" variant="ghost" onClick={() => setEditing({ agent: a, key: a.id })}>{t('agents.edit')}</Button>}
                      {canEdit && !a.synthetic && (
                        <DropdownMenu>
                          <DropdownMenuTrigger aria-label={t('agents.more', { name: a.name })}
                            className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-muted">
                            <MoreHorizontal className="size-4" aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canTest && <DropdownMenuItem onClick={() => setTestingId(a.id)}><MessageSquare className="size-4" />{t('agents.test')}</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => setEditing({ agent: a, key: a.id })}><Pencil className="size-4" />{t('agents.edit')}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void duplicate(a)}><Copy className="size-4" />{t('agents.duplicate')}</DropdownMenuItem>
                            <DropdownMenuItem disabled={index <= 0} onClick={() => void patch(a, { move: 'up' }, t('agents.toasts.moved'))}><ArrowUp className="size-4" />{t('agents.moveUp')}</DropdownMenuItem>
                            <DropdownMenuItem disabled={index >= ids.length - 1} onClick={() => void patch(a, { move: 'down' }, t('agents.toasts.moved'))}><ArrowDown className="size-4" />{t('agents.moveDown')}</DropdownMenuItem>
                            {!a.is_default && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(a)}><Trash2 className="size-4" />{t('agents.delete')}</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!canEdit && <p className="text-xs text-muted-foreground">{t('agents.readOnly')}</p>}
      </div>

      {testing && <AgentTestPanel key={testing.id} agent={testing} onClose={() => setTestingId(null)} />}

      {editing && (
        <AgentDialog key={editing.key} open agent={editing.agent} takenNames={agents.map((a) => a.name)}
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          onSaved={(agent, created) => {
            if (created) { setFilter('all'); setQuery(''); void load(); toast.success(t('agents.toasts.created')); }
            else { setAgents((all) => (all ?? []).map((a) => (a.id === agent.id ? agent : a))); toast.success(t('agents.toasts.saved')); }
          }} />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('agents.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogDescription>{deleting?.enabled ? t('agents.deleteOn') : t('agents.deleteOff')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button type="button" variant="destructive" disabled={!deleting || pending === deleting.id} onClick={() => deleting && void remove(deleting)}>
              {t('agents.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
