'use client';

/**
 * Analytics > Reports: the saved report library. Build a named report (pick
 * metrics, a grouping, a channel, a range and a file type), find it by name,
 * open a preview table, export it as CSV or PDF, edit, duplicate or delete it,
 * and email it on a schedule from the badge on its row (how often, any time to
 * the minute, admins and owners as recipients; "Stop sending" removes it).
 * Admins and owners only, as every report.
 */

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Download, FileText, Mail, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import {
  customRangeIssue, DURATION_METRICS, SAVED_CHANNELS, SAVED_GROUPS, SAVED_METRICS, SAVED_RANGES, SAVED_REPORT_NAME_MAX,
  type SavedGroup, type SavedMetric, type SavedReportDefinition,
} from '@/lib/analytics/saved-report-shape';
import { quietSelect } from '@/components/dashboard/segmented';
import { useDuration } from '@/components/analytics/shared';
import { saveBlob } from '@/components/analytics/insights/csv';
import { cn } from '@/lib/utils';

type Cadence = 'daily' | 'weekly' | 'monthly';
interface ScheduleView {
  id: string;
  cadence: Cadence;
  hourLocal: number;
  minuteLocal: number;
  recipients: { userId: string; name: string | null }[];
  pausedAt: string | null;
}
export interface SavedReportView extends SavedReportDefinition {
  id: string;
  createdAt: string;
  schedule: ScheduleView | null;
}
interface PreviewView {
  group: SavedGroup;
  metrics: SavedMetric[];
  rows: { key: string; name: string | null; values: Partial<Record<SavedMetric, number | null>> }[];
  range: { startDay: string; endDay: string; days: number; timezone: string };
}
interface Member { user_id: string; full_name: string; role: string; email?: string | null }

const field = 'grid gap-1.5 text-xs font-medium text-muted-foreground';
const select = `${quietSelect} w-full`;

async function json<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

export function SavedReports() {
  const t = useTranslations('Analytics.insights.saved');
  const format = useFormatter();
  const [reports, setReports] = useState<SavedReportView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SavedReportView | 'new' | null>(null);
  const [previewing, setPreviewing] = useState<SavedReportView | null>(null);
  const [scheduling, setScheduling] = useState<SavedReportView | null>(null);
  const [deleting, setDeleting] = useState<SavedReportView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/analytics/saved-reports', { cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      setReports((await json<{ reports: SavedReportView[] }>(res)).reports);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const replace = (report: SavedReportView) => setReports((list) => {
    const rest = (list ?? []).filter((r) => r.id !== report.id);
    return list?.some((r) => r.id === report.id) ? (list ?? []).map((r) => (r.id === report.id ? report : r)) : [report, ...rest];
  });

  const duplicate = async (report: SavedReportView) => {
    const res = await authFetch(`/api/analytics/saved-reports/${report.id}/duplicate`, { method: 'POST' });
    const body = await json<{ report?: SavedReportView }>(res);
    if (!res.ok || !body.report) return toast.error(body.error || t('failed'));
    setReports((list) => {
      const at = (list ?? []).findIndex((r) => r.id === report.id);
      const next = [...(list ?? [])];
      next.splice(at + 1, 0, body.report!);
      return next;
    });
    toast.success(t('duplicated'));
  };

  const q = search.trim().toLowerCase();
  const list = (reports ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
  const scheduled = (reports ?? []).filter((r) => r.schedule).length;

  return (
    <section aria-labelledby="saved-reports-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="saved-reports-title" className="text-[15px] font-semibold tracking-tight text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setEditing('new')}><Plus aria-hidden />{t('build')}</Button>
      </div>
      <div className="flex flex-col gap-2 min-[761px]:flex-row min-[761px]:items-center">
        <label className="relative min-w-0 min-[761px]:w-72">
          <span className="sr-only">{t('search')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} className="h-9 pl-8" />
        </label>
        {reports && <span className="text-[13px] text-muted-foreground">{t('count', { shown: list.length, total: reports.length, scheduled })}</span>}
      </div>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {t('loadFailed')}<Button size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      ) : !reports ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      ) : list.length ? (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {list.map((r) => (
            <ReportRow key={r.id} report={r} created={format.dateTime(new Date(r.createdAt), { dateStyle: 'medium' })}
              onOpen={() => setPreviewing(r)} onSchedule={() => setScheduling(r)} onEdit={() => setEditing(r)}
              onDuplicate={() => void duplicate(r)} onDelete={() => setDeleting(r)} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <strong className="text-sm font-semibold">{reports.length ? t('noMatch') : t('empty')}</strong>
          <p className="text-xs text-muted-foreground">{reports.length ? t('noMatchHint') : t('emptyHint')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => (reports.length ? setSearch('') : setEditing('new'))}>
            {reports.length ? t('clearSearch') : t('build')}
          </Button>
        </div>
      )}
      {editing && (
        <BuilderDialog report={editing === 'new' ? null : editing} taken={(reports ?? []).map((r) => ({ id: r.id, name: r.name }))}
          onClose={() => setEditing(null)} onSaved={(report, created) => { replace(report); setSearch(''); toast.success(created ? t('saved', { name: report.name }) : t('updated')); }} />
      )}
      {previewing && <PreviewDialog report={previewing} onClose={() => setPreviewing(null)} />}
      {scheduling && <ScheduleDialog report={scheduling} onClose={() => setScheduling(null)} onSaved={replace} />}
      {deleting && (
        <Dialog open onOpenChange={(o) => { if (!o) setDeleting(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('deleteTitle')}</DialogTitle>
              <DialogDescription>{deleting.schedule ? t('deleteScheduled', { name: deleting.name }) : t('deleteText', { name: deleting.name })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>{t('cancel')}</Button>
              <Button variant="destructive" onClick={async () => {
                const target = deleting;
                const res = await authFetch(`/api/analytics/saved-reports/${target.id}`, { method: 'DELETE' });
                if (!res.ok) return toast.error((await json(res)).error || t('failed'));
                setReports((l) => (l ?? []).filter((r) => r.id !== target.id));
                setDeleting(null);
                toast.success(t('deleted'));
              }}>{t('delete')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

/** "Every Monday, 9:00 · 2 people", in the reader's locale. */
function useScheduleText() {
  const t = useTranslations('Analytics.insights.saved');
  const format = useFormatter();
  return (s: ScheduleView) => t('scheduleBadge', {
    freq: t(`freq.${s.cadence}`),
    time: format.dateTime(new Date(Date.UTC(2026, 0, 1, s.hourLocal, s.minuteLocal)), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }),
    count: s.recipients.length,
  });
}

function useSummary() {
  const t = useTranslations('Analytics.insights.saved');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  return (r: SavedReportDefinition) => {
    const range = r.range.preset === 'custom' && r.range.from && r.range.to
      ? `${format.dateTime(new Date(`${r.range.from}T00:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' })} – ${format.dateTime(new Date(`${r.range.to}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
      : t(`ranges.${r.range.preset}`);
    return t('summary', { count: r.metrics.length, group: t(`groups.${r.group}`).toLowerCase(), range, channel: r.channel === 'all' ? tc('all') : tc(r.channel) });
  };
}

function ReportRow({ report: r, created, onOpen, onSchedule, onEdit, onDuplicate, onDelete }: {
  report: SavedReportView; created: string; onOpen: () => void; onSchedule: () => void; onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const t = useTranslations('Analytics.insights.saved');
  const summary = useSummary();
  const scheduleText = useScheduleText();
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2 border-t border-border px-4 py-3 transition-colors duration-150 first:border-t-0 hover:bg-muted/50 min-[1000px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1.3fr)_96px_auto]">
      <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={t('openReport', { name: r.name })}>
        <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary"><FileText className="size-4" aria-hidden /></span>
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-sm font-semibold">{r.name}</strong>
          <small className="truncate text-xs text-muted-foreground">{summary(r)}</small>
        </span>
      </button>
      <span className="col-span-2 row-start-2 min-w-0 min-[1000px]:col-span-1 min-[1000px]:row-start-1">
        <button type="button" onClick={onSchedule} title={r.schedule ? t('changeSchedule') : t('scheduleEmail')}
          className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50',
            r.schedule ? 'bg-primary-soft text-primary hover:bg-primary-soft-2' : 'bg-muted text-muted-foreground hover:text-foreground')}>
          <Mail className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{r.schedule ? `${scheduleText(r.schedule)}${r.schedule.pausedAt ? ` · ${t('paused')}` : ''}` : t('notScheduled')}</span>
        </button>
      </span>
      <span className="hidden text-[13px] whitespace-nowrap text-muted-foreground min-[1000px]:block">{created}</span>
      <span className="col-start-2 row-start-1 flex items-center justify-end gap-1 min-[1000px]:col-start-4">
        <ExportMenu report={r} />
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={t('more', { name: r.name })} title={t('moreShort')}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>{t('open')}</DropdownMenuItem>
            <DropdownMenuItem onClick={onSchedule}>{r.schedule ? t('changeSchedule') : t('scheduleEmail')}</DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>{t('edit')}</DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>{t('duplicate')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>{t('delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </li>
  );
}

async function exportReport(id: string, format: 'csv' | 'pdf', failed: string) {
  const res = await authFetch(`/api/analytics/saved-reports/${id}/export?format=${format}`, { cache: 'no-store' });
  if (!res.ok) {
    toast.error((await json(res)).error || failed);
    return;
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const file = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `report.${format}`;
  saveBlob(await res.blob(), file);
  toast.success(file);
}

function ExportMenu({ report }: { report: SavedReportView }) {
  const t = useTranslations('Analytics.insights.saved');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t('exportReport', { name: report.name })}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
        <Download className="size-3.5" aria-hidden /><span className="hidden min-[480px]:inline">{t('export')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void exportReport(report.id, 'csv', t('failed'))}>{t('exportCsv')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportReport(report.id, 'pdf', t('failed'))}>{t('exportPdf')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BuilderDialog({ report, taken, onClose, onSaved }: {
  report: SavedReportView | null;
  taken: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (report: SavedReportView, created: boolean) => void;
}) {
  const t = useTranslations('Analytics.insights.saved');
  const tr = useTranslations('Analytics.range');
  const tc = useTranslations('Analytics.channel');
  const [name, setName] = useState(report?.name ?? '');
  const [metrics, setMetrics] = useState<SavedMetric[]>(report?.metrics ?? ['new', 'resolved']);
  const [group, setGroup] = useState<SavedGroup>(report?.group ?? 'day');
  const [channel, setChannel] = useState(report?.channel ?? 'all');
  const [preset, setPreset] = useState(report?.range.preset ?? '7d');
  const [from, setFrom] = useState(report?.range.from ?? '');
  const [to, setTo] = useState(report?.range.to ?? '');
  const [fileFormat, setFileFormat] = useState(report?.format ?? 'csv');
  const [errors, setErrors] = useState<Partial<Record<'name' | 'metrics' | 'dates' | 'form', string>>>({});
  const [busy, setBusy] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.replace(/\s+/g, ' ').trim();
    const issue = preset === 'custom' ? customRangeIssue(from, to) : null;
    const next = {
      name: !trimmed ? t('errors.name') : taken.some((x) => x.id !== report?.id && x.name.toLowerCase() === trimmed.toLowerCase()) ? t('errors.nameTaken') : undefined,
      metrics: metrics.length ? undefined : t('errors.metrics'),
      dates: issue ? t(`errors.${issue}`) : undefined,
    };
    setErrors(next);
    if (next.name || next.metrics || next.dates) return;
    setBusy(true);
    try {
      const res = await authFetch(report ? `/api/analytics/saved-reports/${report.id}` : '/api/analytics/saved-reports', {
        method: report ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, metrics, group, channel, preset, ...(preset === 'custom' ? { from, to } : {}), format: fileFormat }),
      });
      const body = await json<{ report?: SavedReportView; field?: string }>(res);
      if (!res.ok || !body.report) {
        setErrors({ form: body.error || t('failed') });
        return;
      }
      onSaved(body.report, !report);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} noValidate className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>{report ? t('editTitle') : t('buildTitle')}</DialogTitle>
            <DialogDescription>{t('builderHint')}</DialogDescription>
          </DialogHeader>
          <label className={field}>
            {t('name')}
            <Input value={name} maxLength={SAVED_REPORT_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} aria-invalid={Boolean(errors.name)} autoFocus />
            {errors.name && <span role="alert" className="text-xs font-medium text-destructive">{errors.name}</span>}
          </label>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t('metrics')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {SAVED_METRICS.map((m) => {
                const on = metrics.includes(m);
                return (
                  <label key={m} className="relative cursor-pointer">
                    <input type="checkbox" className="peer sr-only" checked={on}
                      onChange={() => setMetrics((list) => (on ? list.filter((x) => x !== m) : SAVED_METRICS.filter((x) => x === m || list.includes(x))))} />
                    <span className={cn('inline-flex h-[30px] items-center rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50',
                      on ? 'border-transparent bg-primary-soft font-semibold text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
                      {t(`metric.${m}`)}
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.metrics && <span role="alert" className="text-xs font-medium text-destructive">{errors.metrics}</span>}
          </fieldset>
          <div className="grid gap-3 min-[480px]:grid-cols-2">
            <label className={field}>{t('groupBy')}
              <select className={select} value={group} onChange={(e) => setGroup(e.target.value as SavedGroup)}>
                {SAVED_GROUPS.map((g) => <option key={g} value={g}>{t(`groups.${g}`)}</option>)}
              </select>
            </label>
            <label className={field}>{tc('label')}
              <select className={select} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                {SAVED_CHANNELS.map((c) => <option key={c} value={c}>{c === 'all' ? tc('all') : tc(c)}</option>)}
              </select>
            </label>
            <label className={field}>{t('range')}
              <select className={select} value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                {SAVED_RANGES.map((p) => <option key={p} value={p}>{t(`ranges.${p}`)}</option>)}
              </select>
            </label>
            <label className={field}>{t('fileType')}
              <select className={select} value={fileFormat} onChange={(e) => setFileFormat(e.target.value as 'csv' | 'pdf')}>
                <option value="csv">CSV</option>
                <option value="pdf">PDF</option>
              </select>
            </label>
          </div>
          {preset === 'custom' && (
            <div className="grid gap-3 min-[480px]:grid-cols-2">
              <label className={field}>{tr('from')}<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={Boolean(errors.dates)} /></label>
              <label className={field}>{tr('to')}<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={Boolean(errors.dates)} /></label>
              {errors.dates && <span role="alert" className="text-xs font-medium text-destructive min-[480px]:col-span-2">{errors.dates}</span>}
            </div>
          )}
          {errors.form && <p role="alert" className="text-xs font-medium text-destructive">{errors.form}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy}>{report ? t('saveChanges') : t('saveReport')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({ report, onClose }: { report: SavedReportView; onClose: () => void }) {
  const t = useTranslations('Analytics.insights.saved');
  const tc = useTranslations('Analytics.channel');
  const format = useFormatter();
  const duration = useDuration();
  const scheduleText = useScheduleText();
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    authFetch(`/api/analytics/saved-reports/${report.id}/preview`, { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('preview');
        const body = await json<{ preview: PreviewView }>(res);
        if (!controller.signal.aborted) setPreview(body.preview);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [report.id, attempt]);

  const day = (d: string, weekday = false) =>
    format.dateTime(new Date(`${d}T00:00:00Z`), { ...(weekday ? { weekday: 'short' as const } : {}), day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const rowName = (p: PreviewView, row: PreviewView['rows'][number]) => {
    if (p.group === 'day') return day(row.key, true);
    if (p.group === 'week') return t('weekOf', { date: day(row.key) });
    if (p.group === 'channel') return tc(row.key as 'whatsapp' | 'instagram');
    if (p.group === 'label') return row.key === 'none' ? t('noLabel') : row.name ?? row.key;
    return row.name || t('formerMember');
  };
  const value = (m: SavedMetric, v: number | null | undefined) => (DURATION_METRICS.includes(m) ? duration(v ?? null) : format.number(v ?? 0));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{report.name}</DialogTitle>
          <DialogDescription>
            {preview ? t('previewMeta', {
              from: day(preview.range.startDay), to: day(preview.range.endDay),
              channel: report.channel === 'all' ? tc('all') : tc(report.channel), count: preview.rows.length,
            }) : t('loading')}
            {report.schedule ? ` · ${scheduleText(report.schedule)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {t('previewFailed')}<Button size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>{t('retry')}</Button>
          </div>
        ) : !preview ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted" />
        ) : (
          <div className="max-h-[52vh] overflow-auto rounded-lg border border-border">
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">{report.name}</caption>
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3.5 py-2 font-semibold">{t(`groups.${preview.group}`)}</th>
                  {preview.metrics.map((m) => <th key={m} scope="col" className="px-3.5 py-2 text-right font-semibold whitespace-nowrap">{t(`metric.${m}`)}</th>)}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <th scope="row" className="px-3.5 py-2 text-left font-normal">{rowName(preview, row)}</th>
                    {preview.metrics.map((m) => <td key={m} className="px-3.5 py-2 text-right whitespace-nowrap tabular-nums">{value(m, row.values[m])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => void exportReport(report.id, 'pdf', t('failed'))}><Download aria-hidden />{t('exportPdf')}</Button>
          <Button variant="outline" onClick={() => void exportReport(report.id, 'csv', t('failed'))}><Download aria-hidden />{t('exportCsv')}</Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({ report, onClose, onSaved }: { report: SavedReportView; onClose: () => void; onSaved: (report: SavedReportView) => void }) {
  const t = useTranslations('Analytics.insights.saved');
  const s = report.schedule;
  const [cadence, setCadence] = useState<Cadence>(s?.cadence ?? 'weekly');
  const [time, setTime] = useState(s ? `${String(s.hourLocal).padStart(2, '0')}:${String(s.minuteLocal).padStart(2, '0')}` : '09:00');
  const [recipients, setRecipients] = useState<string[]>(s?.recipients.map((r) => r.userId) ?? []);
  const [admins, setAdmins] = useState<Member[] | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'time' | 'to' | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/account/members', { cache: 'no-store' });
        const members = res.ok ? (await json<{ members: Member[] }>(res)).members ?? [] : [];
        if (!cancelled) setAdmins(members.filter((m) => m.role === 'owner' || m.role === 'admin'));
      } catch {
        if (!cancelled) setAdmins([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const toggle = (id: string) => setRecipients((list) => (list.includes(id) ? list.filter((x) => x !== id) : list.length >= 10 ? list : [...list, id]));

  const send = async (method: 'PUT' | 'DELETE') => {
    if (method === 'PUT') {
      const next = { time: /^\d{2}:\d{2}$/.test(time) ? undefined : t('errors.time'), to: recipients.length ? undefined : t('errors.recipients') };
      setErrors(next);
      if (next.time || next.to) return;
    }
    setBusy(true);
    try {
      const [hour, minute] = time.split(':').map(Number);
      const res = await authFetch(`/api/analytics/saved-reports/${report.id}/schedule`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ cadence, hour_local: hour, minute_local: minute, recipients }) : undefined,
      });
      const body = await json<{ report?: SavedReportView }>(res);
      if (!res.ok || !body.report) {
        setErrors({ form: body.error || t('failed') });
        return;
      }
      onSaved(body.report);
      toast.success(method === 'DELETE' ? t('scheduleRemoved') : t('scheduleSaved', { name: report.name }));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); void send('PUT'); }} noValidate className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>{s ? t('changeSchedule') : t('scheduleTitle')}</DialogTitle>
            <DialogDescription>{t('scheduleHint', { name: report.name, format: report.format.toUpperCase() })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 min-[480px]:grid-cols-2">
            <label className={field}>{t('howOften')}
              <select className={select} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {(['daily', 'weekly', 'monthly'] as const).map((c) => <option key={c} value={c}>{t(`freq.${c}`)}</option>)}
              </select>
            </label>
            <label className={field}>{t('time')}
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={Boolean(errors.time)} required />
              {errors.time && <span role="alert" className="text-xs font-medium text-destructive">{errors.time}</span>}
            </label>
          </div>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('sendTo')}</legend>
            {admins === null ? <div className="h-16 animate-pulse rounded-lg bg-muted" /> : admins.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noAdmins')}</p>
            ) : admins.map((m) => (
              <label key={m.user_id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={recipients.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate text-sm font-medium">{m.full_name || t('unnamed')}</strong>
                  {m.email && <small className="truncate text-xs text-muted-foreground">{m.email}</small>}
                </span>
              </label>
            ))}
            <small className="text-xs text-muted-foreground">{t('adminsOnly')}</small>
            {errors.to && <span role="alert" className="text-xs font-medium text-destructive">{errors.to}</span>}
          </fieldset>
          {errors.form && <p role="alert" className="text-xs font-medium text-destructive">{errors.form}</p>}
          <DialogFooter>
            {s ? (
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void send('DELETE')}><CalendarClock aria-hidden />{t('stopSending')}</Button>
            ) : (
              <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            )}
            <Button type="submit" disabled={busy}>{t('saveSchedule')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
