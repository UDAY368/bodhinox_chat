'use client';

// Leads tab of the Ads page: Meta lead-ad leads with filters by form, ad and
// date, keyset paging, CSV export and per-lead erasure (admins), and
// "Broadcast to these leads", which saves a lead-form segment and opens a new
// broadcast (agents and above, as POST /api/segments requires). Leads are
// never opted in to WhatsApp automatically.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, Loader2, Megaphone, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole } from '@/lib/auth/roles';
import type { LeadDto } from '@/lib/meta-ads/leads';

export interface LeadsTableProps {
  /** Admins may export and delete leads. */
  canManage: boolean;
}

type Filters = { formId: string; adId: string; from: string; to: string };
const EMPTY: Filters = { formId: '', adId: '', from: '', to: '' };
const selectClass = 'h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground';

/** Hands out request tokens; only the latest token may still update state. */
export function createRequestSequencer() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token: number) => token === latest,
  };
}

function query(filters: Filters, cursor?: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function LeadsTable({ canManage }: LeadsTableProps) {
  const t = useTranslations('Ads');
  const router = useRouter();
  const { accountRole } = useAuth();
  const canSegment = !!accountRole && hasMinRole(accountRole, 'agent');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [forms, setForms] = useState<{ id: string; name: string | null }[]>([]);
  const [leads, setLeads] = useState<LeadDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    authFetch('/api/meta-ads/leads/forms')
      .then(async (res) => (res.ok ? setForms((await res.json()).forms ?? []) : undefined))
      .catch(() => undefined);
  }, []);

  // A newer load (another filter, or the first page after a filter change)
  // supersedes older ones, so a slow stale response never overwrites or
  // appends to the current results.
  const sequencer = useRef(createRequestSequencer());
  const load = useCallback(async (next: Filters, after: string | null) => {
    const token = sequencer.current.next();
    setLoading(true);
    setFailed(false);
    try {
      const res = await authFetch(`/api/meta-ads/leads${query(next, after)}`);
      if (!res.ok) throw new Error('load');
      const body = (await res.json()) as { leads: LeadDto[]; nextCursor: string | null };
      if (!sequencer.current.isCurrent(token)) return;
      setLeads((prev) => (after ? [...prev, ...body.leads] : body.leads));
      setCursor(body.nextCursor);
    } catch {
      if (sequencer.current.isCurrent(token)) setFailed(true);
    } finally {
      if (sequencer.current.isCurrent(token)) setLoading(false);
    }
  }, []);

  // Reload from the first page whenever a filter changes (the ad id once it is a full id or cleared).
  const adReady = filters.adId === '' || /^\d{1,32}$/.test(filters.adId);
  // The ad id waits 300ms after the last keystroke; other filters reload at once.
  const adDelay = useRef(filters.adId);
  useEffect(() => {
    if (!adReady) return;
    const typing = adDelay.current !== filters.adId;
    adDelay.current = filters.adId;
    if (!typing) {
      void load(filters, null);
      return;
    }
    const timer = setTimeout(() => void load(filters, null), 300);
    return () => clearTimeout(timer);
  }, [filters, adReady, load]);

  async function exportCsv() {
    setBusy('export');
    try {
      const res = await authFetch(`/api/meta-ads/leads/export${query(filters)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.message || body.error || t('loadFailed'));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'meta-leads.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(lead: LeadDto) {
    if (!window.confirm(t('leads.deleteConfirm'))) return;
    setBusy(lead.id);
    try {
      const res = await authFetch(`/api/meta-ads/leads/${lead.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.message || body.error || t('loadFailed'));
        return;
      }
      setLeads((prev) => prev.filter((l) => l.id !== lead.id));
      toast.success(t('leads.deleted'));
    } finally {
      setBusy(null);
    }
  }

  async function broadcastToLeads() {
    setBusy('broadcast');
    try {
      const form = forms.find((f) => f.id === filters.formId);
      const res = await authFetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: t('leads.segmentName', { form: form?.name || filters.formId || t('leads.allForms') }).slice(0, 100),
          filter: { conditions: [{ field: 'lead_form', op: 'submitted_any', formIds: filters.formId ? [filters.formId] : [] }] },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || t('leads.segmentFailed'));
        return;
      }
      toast.success(t('leads.segmentCreated'));
      router.push(`/broadcasts/new?segmentId=${encodeURIComponent(body.segment.id)}`);
    } catch {
      toast.error(t('leads.segmentFailed'));
    } finally {
      setBusy(null);
    }
  }

  const set = (key: keyof Filters) => (value: string) => setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('leads.form')}
          <select aria-label={t('leads.form')} className={selectClass} value={filters.formId} onChange={(e) => set('formId')(e.target.value)}>
            <option value="">{t('leads.allForms')}</option>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('leads.ad')}
          <Input aria-label={t('leads.ad')} className="h-8 w-44" inputMode="numeric" maxLength={32} placeholder={t('leads.allAds')}
            value={filters.adId} onChange={(e) => set('adId')(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('leads.from')}
          <Input aria-label={t('leads.from')} type="date" className="h-8 w-40" value={filters.from} onChange={(e) => set('from')(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('leads.to')}
          <Input aria-label={t('leads.to')} type="date" className="h-8 w-40" value={filters.to} onChange={(e) => set('to')(e.target.value)} />
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          {canSegment && (
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={broadcastToLeads}>
              {busy === 'broadcast' ? <Loader2 className="size-4 animate-spin" /> : <Megaphone className="size-4" />}
              {t('broadcastLeads')}
            </Button>
          )}
          {canManage && (
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={exportCsv}>
              {busy === 'export' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {t('exportCsv')}
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('leads.notOptedIn')}</p>

      {failed ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('loadFailed')}
          <Button type="button" variant="ghost" size="sm" onClick={() => load(filters, null)}>{t('retry')}</Button>
        </div>
      ) : !loading && leads.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="leads-empty">{t('leads.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('leads.receivedAt')}</th>
                <th className="px-3 py-2 font-medium">{t('leads.form')}</th>
                <th className="px-3 py-2 font-medium">{t('leads.ad')}</th>
                <th className="px-3 py-2 font-medium">{t('leads.contact')}</th>
                <th className="px-3 py-2 font-medium">{t('leads.answers')}</th>
                {canManage && <th className="px-3 py-2"><span className="sr-only">{t('leads.deleteLead')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-border align-top" data-testid="lead-row">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(lead.receivedAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{lead.formName || lead.formId || '-'}</td>
                  <td className="px-3 py-2">{lead.adName || lead.adId || '-'}</td>
                  <td className="px-3 py-2">{lead.contactName || <span className="text-muted-foreground">{t('leads.noContact')}</span>}</td>
                  <td className="px-3 py-2">
                    {lead.status !== 'fetched' ? (
                      <span className="text-xs text-muted-foreground">{t(`leads.status.${lead.status}`)}</span>
                    ) : (
                      <dl className="space-y-0.5 text-xs">
                        {lead.answers.map((a) => (
                          <div key={a.name} className="flex gap-1">
                            <dt className="text-muted-foreground">{a.name}:</dt>
                            <dd className="break-all">{a.values.join(', ')}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right">
                      <Button type="button" variant="ghost" size="sm" aria-label={t('leads.deleteLead')} disabled={busy !== null}
                        onClick={() => remove(lead)}>
                        {busy === lead.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
      {cursor && !loading && (
        <Button type="button" variant="outline" size="sm" onClick={() => load(filters, cursor)}>{t('leads.loadMore')}</Button>
      )}
    </div>
  );
}
