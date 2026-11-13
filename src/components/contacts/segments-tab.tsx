'use client';

// Contacts > Segments: every saved segment as a card with its live count, a
// few member faces and its conditions in plain words, with View people, Use
// in campaign and a menu (Edit, Duplicate, Export people, Delete). Counts come
// from GET /api/segments/overview; writes go through the segment routes.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Download, Filter, Loader2, Megaphone, MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { fetchLists, type ListSummary, type SegmentSummary } from '@/lib/audience/client';
import type { AudienceCondition } from '@/lib/audience/filter';
import { planAllows, usePlan } from '@/lib/billing/client';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { cn } from '@/lib/utils';
import { useCan } from '@/hooks/use-can';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { Tag } from '@/types';
import { ContactsHeader } from './contacts-header';
import { downloadContactsCsv, useCustomFields } from './contacts-client';
import { formatDay } from './format';
import { SegmentBuilderDialog } from './segment-builder-dialog';

interface SegmentCard extends SegmentSummary {
  total: number | null;
  sendable: number | null;
  sample: { id: string; name: string | null }[];
}

export function SegmentsTab() {
  const t = useTranslations('Contacts.redesign');
  const ts = useTranslations('Contacts.segments');
  const tf = useTranslations('Contacts.filters');
  const locale = useLocale();
  const router = useRouter();
  const db = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const plan = usePlan();
  const canExport = canEditSettings && planAllows(plan, 'contact_export');
  const { data: channels } = useWorkspaceChannels();
  const whatsappOn = channels?.enabled.includes('whatsapp') ?? true;
  const { fields } = useCustomFields();

  const [cards, setCards] = useState<SegmentCard[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<SegmentSummary | null>(null);
  const [deleting, setDeleting] = useState<SegmentCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    const res = await authFetch('/api/segments/overview', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) {
      toast.error(t('segmentsTab.loadFailed'));
      setCards([]);
      return;
    }
    setCards(((await res.json()) as { segments: SegmentCard[] }).segments);
  }, [t]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [tagRes, listRes, sentRes] = await Promise.all([
        db.from('tags').select('*').order('name'),
        fetchLists().catch(() => [] as ListSummary[]),
        db.from('broadcasts').select('id,name').in('status', ['sending', 'sent', 'failed']).order('created_at', { ascending: false }).limit(200),
      ]);
      if (!live) return;
      setTags((tagRes.data ?? []) as Tag[]);
      setLists(listRes);
      setCampaigns(sentRes.data ?? []);
    })();
    void load();
    return () => {
      live = false;
    };
  }, [db, load]);

  function changed() {
    setRefreshKey((k) => k + 1);
    void load();
  }

  async function duplicate(card: SegmentCard) {
    setBusy(true);
    try {
      let name = t('segmentsTab.copyName', { name: card.name }).slice(0, 100);
      for (let n = 2; cards?.some((c) => c.name.toLowerCase() === name.toLowerCase()) && n < 50; n++)
        name = t('segmentsTab.copyNameN', { name: card.name, n }).slice(0, 100);
      const res = await authFetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filter: card.filter }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('segmentsTab.duplicateFailed'));
        return;
      }
      toast.success(t('segmentsTab.duplicated'));
      changed();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const res = await authFetch(`/api/segments/${deleting.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      toast.error(t('segmentsTab.deleteFailed'));
      return;
    }
    toast.success(t('segmentsTab.deleted'));
    setDeleting(null);
    changed();
  }

  async function exportPeople(card: SegmentCard) {
    const done = await downloadContactsCsv(`segmentId=${card.id}`);
    if (!done.ok) toast.error(done.error || t('segmentsTab.exportFailed'));
  }

  function startCampaign(card: SegmentCard) {
    if (!card.sendable) {
      toast.error(t('segmentsTab.nobodyToMessage'));
      return;
    }
    router.push(`/broadcasts/new?segmentId=${card.id}`);
  }

  /** One condition in plain words, from the same labels the segment builder uses. */
  function describe(c: AudienceCondition): string {
    const tagNames = (ids: string[]) => ids.map((id) => tags.find((x) => x.id === id)?.name ?? t('segmentsTab.deletedItem')).join(', ');
    const fieldLabel = c.field === 'whatsapp' || c.field === 'instagram_subscription'
      ? tf(c.field === 'whatsapp' ? 'whatsappField' : 'instagramSubscriptionField')
      : ts(`fields.${c.field}`);
    switch (c.field) {
      case 'tags':
        return `${fieldLabel} ${ts(`ops.${c.op}`)} ${tagNames(c.tagIds)}`;
      case 'list':
        return `${fieldLabel} ${ts(`ops.${c.op}`)} ${c.listIds.map((id) => lists.find((l) => l.id === id)?.name ?? t('segmentsTab.deletedItem')).join(', ')}`;
      case 'campaign':
        return `${campaigns.find((x) => x.id === c.broadcastId)?.name ?? ts('olderCampaign')} · ${ts(`campaignOps.${c.op}`)}`;
      case 'custom_field': {
        const name = fields.find((f) => f.id === c.fieldId)?.field_name ?? t('segmentsTab.deletedItem');
        return [name, ts(`ops.${c.op}`), c.value ?? ''].join(' ').trim();
      }
      case 'created_at':
        return `${fieldLabel} ${ts(`ops.${c.op}`)} ${formatDay(`${c.value}T12:00:00`, locale)}`;
      case 'opted_out':
      case 'blocked':
        return `${fieldLabel}: ${c.value ? ts('yes') : ts('no')}`;
      case 'ad':
        return `${ts(`ops.${c.op}`)} ${c.adIds.length ? c.adIds.join(', ') : ts('anyAd')}`;
      case 'lead_form':
        return `${ts(`ops.${c.op}`)} ${c.formIds.length ? c.formIds.join(', ') : ts('anyForm')}`;
      case 'instagram':
        return ts(`ops.${c.op}`);
      case 'instagram_profile':
        return `${ts(`igFacts.${c.fact}`)} ${ts(`ops.${c.op}`)}`;
      case 'instagram_followers':
        return `${fieldLabel} ${ts(`ops.${c.op}`)} ${c.value.toLocaleString(locale)}`;
      case 'instagram_window':
        return `${fieldLabel} ${ts(`ops.${c.op}`)}`;
      case 'whatsapp':
        return c.op === 'has_number' ? tf('hasWhatsApp') : tf('hasNoWhatsApp');
      case 'instagram_subscription':
        return `${fieldLabel}: ${c.op === 'subscribed' ? t('segmentsTab.subscribed') : t('segmentsTab.unsubscribed')}`;
      default:
        return `${fieldLabel} ${ts(`ops.${c.op}`)} ${'value' in c && typeof c.value === 'string' ? c.value : ''}`.trim();
    }
  }

  return (
    <div className="min-w-0 space-y-5">
      <ContactsHeader
        tab="segments"
        refreshKey={refreshKey}
        known={{ segments: cards ? cards.length : null }}
        actions={canEdit && (
          <Button onClick={() => { setEditing(null); setBuilderOpen(true); }}>
            <Plus className="size-4" />
            {ts('newTitle')}
          </Button>
        )}
      />

      {cards === null ? (
        <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t('loading')} /></div>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Filter className="size-5" /></span>
          <h2 className="text-base font-semibold text-foreground">{t('segmentsTab.emptyTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('segmentsTab.emptyText')}</p>
          {canEdit && (
            <Button variant="outline" onClick={() => { setEditing(null); setBuilderOpen(true); }}>
              <Plus className="size-4" />
              {ts('newTitle')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">{t('segmentsTab.hint')}</p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))]">
            {cards.map((card) => (
              <article key={card.id} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate text-[15px] font-semibold text-foreground" title={card.name}>{card.name}</h2>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0 text-muted-foreground" aria-label={t('segmentsTab.actionsFor', { name: card.name })} />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-popover border-border">
                      {canEdit && (
                        <DropdownMenuItem onClick={() => { setEditing(card); setBuilderOpen(true); }}>
                          <Pencil className="size-4" />
                          {t('segmentsTab.edit')}
                        </DropdownMenuItem>
                      )}
                      {canEdit && (
                        <DropdownMenuItem disabled={busy} onClick={() => void duplicate(card)}>
                          <Copy className="size-4" />
                          {t('segmentsTab.duplicate')}
                        </DropdownMenuItem>
                      )}
                      {canExport && (
                        <DropdownMenuItem onClick={() => void exportPeople(card)}>
                          <Download className="size-4" />
                          {t('segmentsTab.export')}
                        </DropdownMenuItem>
                      )}
                      {canEdit && (
                        <>
                          <DropdownMenuSeparator className="bg-border" />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(card)}>
                            <Trash2 className="size-4" />
                            {t('segmentsTab.delete')}
                          </DropdownMenuItem>
                        </>
                      )}
                      {!canEdit && !canExport && (
                        <DropdownMenuItem onClick={() => router.push(`/contacts?segment=${card.id}`)}>
                          <Users className="size-4" />
                          {t('segmentsTab.view')}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {card.total === null ? (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t('segmentsTab.broken')}</p>
                ) : (
                  <div className="flex min-w-0 items-center gap-2">
                    <strong className="text-[26px] leading-none font-bold tracking-tight tabular-nums text-foreground">{card.total.toLocaleString(locale)}</strong>
                    <span className="min-w-0 text-[13px] text-muted-foreground">{t('segmentsTab.people', { count: card.total })}</span>
                    <span className="ml-auto flex shrink-0 pl-1.5" aria-hidden>
                      {card.sample.map((c) => (
                        <span key={c.id} className={cn('-ml-1.5 flex size-6 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-card', avatarTone(c.name || c.id))}>
                          {initials(c.name)}
                        </span>
                      ))}
                    </span>
                  </div>
                )}

                <ul className="flex flex-1 flex-col gap-1 text-[13px] text-foreground">
                  <li className="text-xs text-muted-foreground">{card.filter.match === 'any' ? t('segmentsTab.matchesAny') : t('segmentsTab.matchesAll')}</li>
                  {card.filter.conditions.map((c, i) => (
                    <li key={i} className="break-words">{describe(c)}</li>
                  ))}
                </ul>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => router.push(`/contacts?segment=${card.id}`)}>
                    <Users className="size-3.5" />
                    {t('segmentsTab.view')}
                  </Button>
                  {canEdit && whatsappOn && (
                    <Button variant="outline" size="sm" disabled={card.total === null} onClick={() => startCampaign(card)}>
                      <Megaphone className="size-3.5" />
                      {t('segmentsTab.useInCampaign')}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <SegmentBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        segment={editing}
        tags={tags}
        lists={lists}
        campaigns={campaigns}
        customFields={fields.map((f) => ({ id: f.id, field_name: f.field_name, field_type: f.field_type, user_id: '', account_id: '', created_at: f.created_at }))}
        onSaved={changed}
      />

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('segmentsTab.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('segmentsTab.deleteText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setDeleting(null)}>{ts('cancel')}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('segmentsTab.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
