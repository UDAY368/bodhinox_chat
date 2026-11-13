'use client';

/**
 * Booking pages: a public link (/book/<slug>) listing chosen services, an
 * optional location, the WhatsApp number that receives the customer's
 * "BOOK <code>" confirmation (default number when unset) and an active flag.
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import { apiRequest, selectClass, useFailureText, type AppointmentConfig } from './shared';

export interface BookingPageDto {
  id: string; slug: string; title: string; active: boolean; location_id: string | null; whatsapp_config_id: string | null; service_ids: string[];
}
interface Draft { slug: string; title: string; serviceIds: string[]; locationId: string; numberId: string; active: boolean }
const BLANK: Draft = { slug: '', title: '', serviceIds: [], locationId: '', numberId: '', active: true };

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

/** The public link of a page on this deployment. */
export const bookingLink = (origin: string, slug: string) => `${origin.replace(/\/+$/, '')}/book/${slug}`;

export function BookingPagesPanel({ config, canEdit }: { config: AppointmentConfig; canEdit: boolean }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const { numbers } = useWhatsAppNumbers();
  const [pages, setPages] = useState<BookingPageDto[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
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
    const r = await apiRequest(`/api/appointments/booking-pages/${id}`, { method: 'DELETE' });
    if (!r.ok) return void toast.error(failureText(r));
    void load();
  }

  async function copy(slug: string) {
    try {
      await navigator.clipboard.writeText(bookingLink(window.location.origin, slug));
      toast.success(t('pages.copied'));
    } catch {
      /* clipboard unavailable: the link is shown on screen */
    }
  }

  const form = (
    <div className="grid gap-3 rounded-xl border border-border p-3 text-sm sm:grid-cols-2">
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
        <select id="page-location" className={selectClass} value={draft.locationId} onChange={(e) => set('locationId')(e.target.value)}>
          <option value="">{t('schedule.all')}</option>
          {config.locations.filter((l) => !l.archived_at).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="page-number">{t('pages.number')}</Label>
        <select id="page-number" className={selectClass} value={draft.numberId} onChange={(e) => set('numberId')(e.target.value)}>
          <option value="">{t('pages.defaultNumber')}</option>
          {numbers.filter((n) => !n.removed).map((n) => <option key={n.id} value={n.id}>{n.display_name || n.phone_number_id}</option>)}
        </select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label>{t('pages.services')}</Label>
        <div className="flex flex-wrap gap-3">
          {services.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5">
              <Checkbox checked={draft.serviceIds.includes(s.id)}
                onCheckedChange={(v) => set('serviceIds')(v ? [...draft.serviceIds, s.id] : draft.serviceIds.filter((x) => x !== s.id))} />
              {s.name}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2">
        <Switch checked={draft.active} onCheckedChange={(v) => set('active')(v)} aria-label={t('pages.active')} /> {t('pages.active')}
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="button" size="sm" disabled={busy || !draft.title.trim() || draft.serviceIds.length === 0} onClick={() => void save()}>{t('sheet.save')}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('sheet.close')}</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">{t('pages.title')}</h2>
        {canEdit && editing === null && <Button type="button" size="sm" onClick={() => edit('new')}>{t('pages.add')}</Button>}
      </div>
      {editing === 'new' && form}
      {pages && pages.length === 0 && editing !== 'new' && <p className="text-sm text-muted-foreground">{t('pages.empty')}</p>}
      <ul className="space-y-2">
        {(pages ?? []).map((p) => (
          <li key={p.id}>
            {editing === p.id ? form : (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
                <span className="font-medium">{p.title}</span>
                <code className="truncate text-xs text-muted-foreground">/book/{p.slug}</code>
                {!p.active && <span className="text-xs text-muted-foreground">({t('pages.inactive')})</span>}
                <span className="ml-auto flex gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => void copy(p.slug)}><Copy className="h-3.5 w-3.5" /> {t('pages.copyLink')}</Button>
                  {canEdit && <Button type="button" size="sm" variant="ghost" onClick={() => edit(p)}>{t('form.edit')}</Button>}
                  {canEdit && <Button type="button" size="sm" variant="ghost" onClick={() => void remove(p.id)}>{t('exceptions.delete')}</Button>}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
