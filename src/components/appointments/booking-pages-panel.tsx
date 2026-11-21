'use client';

/**
 * Booking pages: a public link (/book/<slug>) listing chosen services, an
 * optional location, the WhatsApp number that receives the customer's
 * "BOOK <code>" confirmation (default number when unset) and an active flag.
 */
import { EmptyState } from '@/components/ui/empty-state';
import { OptionSelect } from '@/components/ui/option-select';
import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SettingsMoreMenu } from '@/components/settings/settings-row';
import { Switch } from '@/components/ui/switch';
import { useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import { apiRequest, useFailureText, type AppointmentConfig } from './shared';

export interface BookingPageDto {
  id: string; slug: string; title: string; active: boolean; location_id: string | null; whatsapp_config_id: string | null; service_ids: string[];
}
interface Draft { slug: string; title: string; serviceIds: string[]; locationId: string; numberId: string; active: boolean }
const BLANK: Draft = { slug: '', title: '', serviceIds: [], locationId: '', numberId: '', active: true };

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

/** The public link of a page on this deployment. */
export const bookingLink = (origin: string, slug: string) => `${origin.replace(/\/+$/, '')}/book/${slug}`;

export interface PageLink { kind: 'page' | 'service' | 'staff'; id: string; label: string; url: string }

/**
 * Direct links for one page: the page itself, one per live service on it
 * (?service=) and one per live practitioner who offers one of those services
 * at the page's place (?staff=). The booking page ignores ids it does not offer.
 */
export function pageLinks(origin: string, page: Pick<BookingPageDto, 'slug' | 'service_ids' | 'location_id'>, config: AppointmentConfig): PageLink[] {
  const base = bookingLink(origin, page.slug);
  const services = config.services.filter((s) => !s.archived_at && page.service_ids.includes(s.id));
  const serviceIds = new Set(services.map((s) => s.id));
  const staffIds = new Set(config.offerings
    .filter((o) => o.staff_id && serviceIds.has(o.service_id) && (!page.location_id || o.location_id === page.location_id))
    .map((o) => o.staff_id as string));
  const staff = config.staff.filter((s) => !s.archived_at && staffIds.has(s.id));
  return [
    { kind: 'page', id: page.slug, label: page.slug, url: base },
    ...services.map((s) => ({ kind: 'service' as const, id: s.id, label: s.name, url: `${base}?service=${encodeURIComponent(s.id)}` })),
    ...staff.map((s) => ({ kind: 'staff' as const, id: s.id, label: s.display_name, url: `${base}?staff=${encodeURIComponent(s.id)}` })),
  ];
}

export function BookingPagesPanel({ config, canEdit }: { config: AppointmentConfig; canEdit: boolean }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const confirm = useConfirm();
  const { numbers } = useWhatsAppNumbers();
  const [pages, setPages] = useState<BookingPageDto[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [linksFor, setLinksFor] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const services = config.services.filter((s) => !s.archived_at);

  const load = useCallback(async () => {
    const r = await apiRequest<{ pages: BookingPageDto[] }>('/api/appointments/booking-pages');
    setPages(r.ok ? r.data.pages ?? [] : []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const edit = (p: BookingPageDto | 'new') => {
    setDraft(p === 'new' ? BLANK : {
      slug: p.slug, title: p.title, serviceIds: p.service_ids, locationId: p.location_id ?? '', numberId: p.whatsapp_config_id ?? '', active: p.active,
    });
    setEditing(p === 'new' ? 'new' : p.id);
  };

  async function save() {
    const slug = draft.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return void toast.error(t('pages.slugHelp'));
    setBusy(true);
    const body = {
      slug, title: draft.title.trim(), service_ids: draft.serviceIds, location_id: draft.locationId || null,
      whatsapp_config_id: draft.numberId || null, active: draft.active,
    };
    const r = editing === 'new'
      ? await apiRequest('/api/appointments/booking-pages', { method: 'POST', body })
      : await apiRequest(`/api/appointments/booking-pages/${editing}`, { method: 'PATCH', body });
    setBusy(false);
    if (!r.ok) return void toast.error(r.field === 'slug' && r.detail === 'taken' ? t('pages.slugTaken') : failureText(r));
    setEditing(null);
    void load();
  }

  async function remove(id: string) {
    if (!(await confirm({ title: t('pages.deleteConfirm'), body: t('pages.deleteBody'), confirmLabel: t('exceptions.delete'), destructive: true }))) return;
    const r = await apiRequest(`/api/appointments/booking-pages/${id}`, { method: 'DELETE' });
    if (!r.ok) return void toast.error(failureText(r));
    void load();
  }

  /** The On/Off switch on a row: saves at once, and puts the switch back if the save fails. */
  async function setActive(id: string, active: boolean) {
    setPages((prev) => prev?.map((p) => (p.id === id ? { ...p, active } : p)) ?? prev);
    const r = await apiRequest(`/api/appointments/booking-pages/${id}`, { method: 'PATCH', body: { active } });
    if (!r.ok) {
      setPages((prev) => prev?.map((p) => (p.id === id ? { ...p, active: !active } : p)) ?? prev);
      toast.error(failureText(r));
    }
  }

  async function copy(slug: string) {
    await copyUrl(bookingLink(window.location.origin, slug));
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('pages.copied'));
    } catch {
      /* clipboard unavailable: the link is shown on screen */
    }
  }

  const linksPage = pages?.find((p) => p.id === linksFor) ?? null;
  const links = linksPage && typeof window !== 'undefined' ? pageLinks(window.location.origin, linksPage, config) : [];
  const linkGroups = (['page', 'service', 'staff'] as const)
    .map((kind) => ({ kind, items: links.filter((l) => l.kind === kind) }))
    .filter((g) => g.items.length > 0);

  const current = editing && editing !== 'new' ? pages?.find((p) => p.id === editing) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">{t('pages.title')}</h2>
        {canEdit && <Button type="button" className="min-h-11 sm:min-h-8" size="sm" onClick={() => edit('new')}>{t('pages.add')}</Button>}
      </div>
      {pages && pages.length === 0 && <EmptyState icon={Link2} title={t('pages.empty')} />}
      {!!pages?.length && (
        <GroupedList>
          {pages.map((p) => (
            <GroupedListRow
              key={p.id}
              title={p.title}
              subtitle={`/book/${p.slug}${p.active ? '' : ` · ${t('pages.inactive')}`}`}
              trailing={
                <span className="-mr-2 flex items-center gap-1">
                  {canEdit && (
                    <Switch checked={p.active} onCheckedChange={(v) => void setActive(p.id, v)} aria-label={`${t('pages.active')}: ${p.title}`} />
                  )}
                  <SettingsMoreMenu actions={[
                    { label: t('pages.copyLink'), icon: Copy, onSelect: () => void copy(p.slug) },
                    { label: t('pages.links'), icon: Link2, onSelect: () => setLinksFor(p.id) },
                    { label: t('form.edit'), icon: Pencil, onSelect: () => edit(p), hidden: !canEdit },
                    { label: t('exceptions.delete'), icon: Trash2, onSelect: () => void remove(p.id), destructive: true, hidden: !canEdit },
                  ]} />
                </span>
              }
            />
          ))}
        </GroupedList>
      )}

      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <SheetContent size="md" className="overflow-y-auto">
          <SheetHeader className="pr-12"><SheetTitle>{current ? current.title : t('pages.add')}</SheetTitle></SheetHeader>
          <div className="grid gap-3 px-4 pb-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="page-title">{t('pages.titleLabel')}</Label>
              <Input id="page-title" maxLength={120} value={draft.title} onChange={(e) => set('title')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="page-slug">{t('pages.slug')}</Label>
              <Input id="page-slug" maxLength={48} value={draft.slug} onChange={(e) => set('slug')(e.target.value.toLowerCase())} />
              <p className="text-[11px] text-muted-foreground">{t('pages.slugHelp')}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="page-location">{t('pages.location')}</Label>
              <OptionSelect id="page-location" value={draft.locationId} onValueChange={set('locationId')}
                options={[{ value: '', label: t('schedule.all') }, ...config.locations.filter((l) => !l.archived_at).map((l) => ({ value: l.id, label: l.name }))]} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="page-number">{t('pages.number')}</Label>
              <OptionSelect id="page-number" value={draft.numberId} onValueChange={set('numberId')}
                options={[{ value: '', label: t('pages.defaultNumber') }, ...numbers.filter((n) => !n.removed).map((n) => ({ value: n.id, label: n.display_name || n.phone_number_id }))]} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>{t('pages.services')}</Label>
              <div className="flex flex-wrap gap-3">
                {services.map((s) => (
                  <label key={s.id} className="flex min-h-11 items-center gap-1.5 sm:min-h-0">
                    <Checkbox checked={draft.serviceIds.includes(s.id)}
                      onCheckedChange={(v) => set('serviceIds')(v ? [...draft.serviceIds, s.id] : draft.serviceIds.filter((x) => x !== s.id))} />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex min-h-11 items-center gap-2">
              <Switch checked={draft.active} onCheckedChange={(v) => set('active')(v)} aria-label={t('pages.active')} /> {t('pages.active')}
            </label>
          </div>
          <SheetFooter className="flex-row flex-wrap justify-end border-t border-border/50">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t('sheet.close')}</Button>
            <Button type="button" disabled={busy || !draft.title.trim() || draft.serviceIds.length === 0} onClick={() => void save()}>{t('sheet.save')}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={linksPage !== null} onOpenChange={(open) => { if (!open) setLinksFor(null); }}>
        <SheetContent size="md" className="overflow-y-auto">
          {linksPage && (
            <>
              <SheetHeader className="pr-12">
                <SheetTitle>{t('pages.linksTitle', { title: linksPage.title })}</SheetTitle>
                <SheetDescription>{t('pages.linksHelp')}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                {linkGroups.map((group) => (
                  <GroupedList key={group.kind} header={t(`pages.linkGroup.${group.kind}`)}>
                    {group.items.map((link) => (
                      <GroupedListRow
                        key={`${link.kind}:${link.id}`}
                        title={link.kind === 'page' ? t('pages.wholePage') : link.label}
                        subtitle={link.url}
                        onClick={() => void copyUrl(link.url)}
                        trailing={<span className="inline-flex items-center gap-1 text-primary">
                          <Copy className="h-4 w-4" aria-hidden /> {t('pages.copy')}
                        </span>}
                      />
                    ))}
                  </GroupedList>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
