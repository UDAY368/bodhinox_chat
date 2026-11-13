'use client';

// CSV import in three steps: choose a file, match each column to a contact
// field, a custom field or nothing (with a sample value and checks for a
// missing phone column or a field chosen twice), then a summary. The matched
// rows go to POST /api/contacts/import in batches; the server checks custom
// values against their field's type.
import { useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { parseImportPhone } from '@/lib/whatsapp/phone-utils';
import {
  importConsentAt,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import {
  guessImportTargets,
  mappingProblem,
  readCsvTable,
  rowsFromMapping,
  IMPORT_TARGETS,
  type CsvTable,
  type ImportTarget,
} from '@/lib/contacts/import-mapping';
import { csvCell } from '@/lib/audience/csv-cell';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Tag,
  Download,
  Check,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCustomFields } from './contacts-client';
import { FIELD_SELECT } from './custom-field-input';

const DEFAULT_TAG_COLOR = '#3b82f6';
const PREVIEW_LIMIT = 5;
/** Rows per POST /api/contacts/import request (IMPORT_BATCH_SIZE in lib/contacts/import.ts). */
const BATCH_SIZE = 200;

/** Save the rows the import refused, with the reason, as a CSV the user can fix and re-import. */
function downloadRejectedRows(rows: { phone: string; name?: string; reason: string }[]) {
  const lines = [['phone', 'name', 'reason'], ...rows.map((r) => [r.phone, r.name ?? '', r.reason])]
    .map((cells) => cells.map(csvCell).join(','));
  const BOM = String.fromCharCode(0xfeff);
  const url = URL.createObjectURL(new Blob([`${BOM}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rejected-contacts.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate',
        maxWidth,
        mono && 'font-mono text-[11px]'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  const t = useTranslations('Contacts.importModal');

  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color =
          tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : t('willBeCreated', { name })}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  invalidPhone: number;
  failed: number;
  failedDetails: { phone: string; name?: string; reason: string }[];
  tagsAssigned: number;
  fieldsRejected: number;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const tm = useTranslations('Contacts.redesign.importMap');
  const tr = useTranslations('Contacts.redesign');
  const db = createClient();
  const { accountId, canEditSettings } = useAuth();
  const { fields: customFields } = useCustomFields();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [targets, setTargets] = useState<ImportTarget[]>([]);
  const [tags, setTags] = useState<{ id: string; name: string; color: string }[]>([]);
  const [everyoneTagId, setEveryoneTagId] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const step: 1 | 2 | 3 = result ? 3 : table ? 2 : 1;
  const parsedRows: ParsedContactRow[] = useMemo(() => (table ? rowsFromMapping(table, targets) : []), [table, targets]);
  const problem = table ? mappingProblem(targets) : null;
  const tagColorByKey = useMemo(() => {
    const colors = new Map<string, string>();
    for (const tag of tags) {
      const key = tag.name.trim().toLowerCase();
      if (!colors.has(key)) colors.set(key, tag.color);
    }
    return colors;
  }, [tags]);

  function reset() {
    setFile(null);
    setTable(null);
    setTargets([]);
    setEveryoneTagId('');
    setResult(null);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function loadFile(selected: File) {
    if (!/\.csv$/i.test(selected.name) && selected.type !== 'text/csv') {
      toast.error(tm('notCsv'));
      return;
    }
    const parsed = readCsvTable(await selected.text());
    if (!parsed) {
      toast.error(t('toastNoValidRows'));
      return;
    }
    setFile(selected);
    setResult(null);
    setTable(parsed);
    setTargets(guessImportTargets(parsed.headers, customFields));
    if (accountId) {
      const { data } = await db.from('tags').select('id, name, color').order('name');
      setTags((data ?? []) as { id: string; name: string; color: string }[]);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) await loadFile(selected);
  }

  async function handleImport() {
    if (parsedRows.length === 0 || problem) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await db.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error(t('notAuthenticated'));
      if (!accountId)
        throw new Error(t('notLinkedToAccount'));

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      let tagsAssigned = 0;
      let fieldsRejected = 0;
      const failedDetails: { phone: string; name?: string; reason: string }[] = [];

      // 1) Normalise numbers (with the chosen default country) and keep the
      //    first row per number. Rows with no usable number are listed with
      //    a reason instead of only counted.
      const seen = new Set<string>();
      const unique: (ParsedContactRow & { digits: string })[] = [];
      let invalidPhone = 0;
      for (const row of parsedRows) {
        const digits = parseImportPhone(row.phone, countryCode);
        if (!digits) {
          invalidPhone++;
          failedDetails.push({ phone: row.phone || '—', name: row.name, reason: t('invalidPhoneReason') });
        } else if (seen.has(digits)) {
          skipped++;
        } else {
          seen.add(digits);
          unique.push({ ...row, digits });
        }
      }

      // 2) Resolve tag names → ids (admin+ may auto-create missing tags).
      const allTagNames = unique.flatMap((row) => row.tagNames);
      let tagIdByKey = new Map<string, string>();
      let skippedNames: string[] = [];
      if (allTagNames.length > 0) {
        try {
          ({ tagIdByKey, skippedNames } = await resolveImportTagIds(db, {
            accountId,
            userId: user.id,
            tagNames: allTagNames,
            canCreateTags: canEditSettings,
          }));
        } catch {
          toast.warning(t('toastTagsWarning'));
        }
      }
      const tagIdsOf = (row: ParsedContactRow) => [
        ...new Set([
          ...row.tagNames
            .map((name) => tagIdByKey.get(name.trim().toLowerCase()))
            .filter((id): id is string => !!id),
          // The label chosen for everyone imported.
          ...(everyoneTagId ? [everyoneTagId] : []),
        ]),
      ].slice(0, 50);

      // 3) Send batches to the server, which inserts with ON CONFLICT on
      //    the workspace's number index (a duplicate never fails a batch)
      //    and, when chosen, updates contacts that already exist.
      setProgress({ done: 0, total: unique.length });
      for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        const chunk = unique.slice(i, i + BATCH_SIZE);
        const res = await authFetch('/api/contacts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updateExisting,
            rows: chunk.map((row) => ({
              phone: row.digits,
              name: row.name?.slice(0, 200),
              email: row.email?.slice(0, 320),
              company: row.company?.slice(0, 200),
              city: row.city?.slice(0, 200),
              tagIds: tagIdsOf(row),
              customValues: Object.fromEntries(Object.entries(row.customValues ?? {}).map(([id, v]) => [id, v.slice(0, 1000)])),
              optedOutAt: importConsentAt(row.optedOut),
              blockedAt: importConsentAt(row.blocked),
            })),
          }),
        }).catch(() => null);
        const payload = (await res?.json().catch(() => null)) as {
          imported?: number;
          updated?: number;
          skipped?: number;
          tagsAssigned?: number;
          fieldsRejected?: number;
          error?: string;
        } | null;
        if (res?.ok && payload) {
          imported += payload.imported ?? 0;
          updated += payload.updated ?? 0;
          skipped += payload.skipped ?? 0;
          tagsAssigned += payload.tagsAssigned ?? 0;
          fieldsRejected += payload.fieldsRejected ?? 0;
        } else {
          // The plan's contact limit refuses every later batch too, so stop there.
          const rest = res?.status === 402 ? unique.slice(i) : chunk;
          const reason = payload?.error || t('unknownReason');
          failed += rest.length;
          for (const row of rest) failedDetails.push({ phone: row.phone, name: row.name, reason });
          if (res?.status === 402) break;
        }
        setProgress({ done: Math.min(i + BATCH_SIZE, unique.length), total: unique.length });
      }

      setResult({ imported, updated, skipped, invalidPhone, failed, failedDetails, tagsAssigned, fieldsRejected });
      if (imported > 0 || updated > 0) onImported();
      if (imported > 0) toast.success(t('toastImported', { count: imported }));
      if (tagsAssigned > 0) toast.success(t('toastTagsAssigned', { count: tagsAssigned }));
      if (skippedNames.length > 0) {
        const sample = skippedNames.slice(0, 3).join(', ');
        const more = skippedNames.length > 3 ? t('toastTagsSkippedMore', { count: skippedNames.length - 3 }) : '';
        toast.info(t('toastTagsSkipped', { sample, more }));
      }
      if (invalidPhone > 0) toast.warning(t('toastInvalidPhone', { count: invalidPhone }));
      if (failed > 0) toast.error(t('toastFailed', { count: failed }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
      setProgress(null);
    }
  }

  const targetLabel = (target: ImportFieldTarget) => tm(`targets.${target}`);
  const preview = parsedRows.slice(0, PREVIEW_LIMIT);
  const previewHasTags = targets.includes('tags');
  const previewHasCompany = targets.includes('company');
  const sampleOf = (i: number) => table?.rows.find((r) => r[i]?.trim())?.[i]?.trim() ?? '';
  const steps = [tm('steps.file'), tm('steps.match'), tm('steps.done')];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,760px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-4 pt-6 pb-4 sm:px-6">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              {tm('desc')}
            </DialogDescription>
          </DialogHeader>
          <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label={tm('steps.label')}>
            {steps.map((label, i) => {
              const n = i + 1;
              return (
                <li key={label} aria-current={step === n ? 'step' : undefined}
                  className={cn('flex items-center gap-1.5', step === n ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                  <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums',
                    step > n ? 'bg-primary text-primary-foreground' : step === n ? 'bg-primary/15 text-primary' : 'bg-muted')}>
                    {step > n ? <Check className="size-3" /> : n}
                  </span>
                  {label}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {step === 1 && (
            <div className="space-y-3">
              <div
                role="button"
                tabIndex={0}
                aria-label={tm('chooseFile')}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) void loadFile(dropped);
                }}
                className={cn(
                  'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center transition-all focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  dragging ? 'border-primary/50 bg-primary/[0.06]' : 'border-border/80 bg-background/40 hover:border-primary/40 hover:bg-background/70'
                )}
              >
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{tm('dropHere')}</p>
                <p className="text-[11px] text-muted-foreground">{tm('orChoose')}</p>
              </div>
              <p className="text-xs text-muted-foreground">{tm('recognised')}</p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />

          {step === 2 && table && (
            <div className="space-y-4">
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <FileText className="size-4 shrink-0 text-primary" />
                <strong className="min-w-0 truncate" title={file?.name}>{truncateFilename(file?.name ?? '')}</strong>
                <span className="text-xs text-muted-foreground">{tm('fileSummary', { rows: table.rows.length, columns: table.headers.length })}</span>
              </p>

              <div className="overflow-hidden rounded-xl border border-border">
                <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
                  <span>{tm('columnInFile')}</span>
                  <span>{tm('sample')}</span>
                  <span>{tm('saveTo')}</span>
                </div>
                <div className="divide-y divide-border">
                  {table.headers.map((header, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                      <strong className="min-w-0 truncate text-[13px]" title={header}>{header || tm('unnamedColumn', { n: i + 1 })}</strong>
                      <span className="order-3 col-span-2 min-w-0 truncate text-xs text-muted-foreground sm:order-none sm:col-span-1" title={sampleOf(i)}>{sampleOf(i) || '—'}</span>
                      <select
                        aria-label={tm('saveColumnTo', { column: header || tm('unnamedColumn', { n: i + 1 }) })}
                        value={targets[i] ?? ''}
                        onChange={(e) => setTargets((prev) => prev.map((v, j) => (j === i ? (e.target.value as ImportTarget) : v)))}
                        className={cn(FIELD_SELECT, 'h-8')}
                      >
                        <option value="">{tm('skip')}</option>
                        {IMPORT_TARGETS.map((target) => (
                          <option key={target} value={target}>{targetLabel(target)}</option>
                        ))}
                        {customFields.length > 0 && (
                          <optgroup label={tr('profile.customFields')}>
                            {customFields.map((f) => (
                              <option key={f.id} value={`cf:${f.id}`}>{f.field_name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              {problem && (
                <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {tm(`problems.${problem}`)}
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="import-everyone-tag" className="text-xs text-popover-foreground">{tm('everyoneTag')}</Label>
                  <select id="import-everyone-tag" value={everyoneTagId} onChange={(e) => setEveryoneTagId(e.target.value)} className={cn(FIELD_SELECT, 'h-8')}>
                    <option value="">{tm('noTag')}</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>{tag.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="import-country-code" className="text-xs text-popover-foreground">
                    {t('countryCodeLabel')}
                  </Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">+</span>
                    <Input
                      id="import-country-code"
                      inputMode="numeric"
                      maxLength={3}
                      placeholder="91"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                      disabled={importing}
                      className="h-8 w-20"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('countryCodeHint')}</p>
                </div>
                <label className="flex items-start gap-2 text-xs text-popover-foreground sm:col-span-2">
                  <Checkbox
                    checked={updateExisting}
                    onCheckedChange={(checked) => setUpdateExisting(checked === true)}
                    disabled={importing}
                    className="mt-0.5"
                  />
                  <span>{t('updateExisting')}</span>
                </label>
              </div>

              {preview.length > 0 && !problem && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground">{t('preview', { count: preview.length })}</p>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[28rem] text-xs">
                        <thead>
                          <tr className="border-b border-border bg-background/60">
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{t('columns.phone')}</th>
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{t('columns.name')}</th>
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{t('columns.email')}</th>
                            {previewHasCompany && <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{t('columns.company')}</th>}
                            {previewHasTags && <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{t('columns.tags')}</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/70">
                          {preview.map((row, i) => (
                            <tr key={i} className="bg-popover/40">
                              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground"><PreviewCell value={row.phone} mono maxWidth="max-w-[7.5rem]" /></td>
                              <td className="px-3 py-2 text-popover-foreground"><PreviewCell value={row.name || '—'} maxWidth="max-w-[8.5rem]" /></td>
                              <td className="px-3 py-2 text-muted-foreground"><PreviewCell value={row.email || '—'} maxWidth="max-w-[10rem]" /></td>
                              {previewHasCompany && <td className="px-3 py-2 text-muted-foreground"><PreviewCell value={row.company || '—'} maxWidth="max-w-[7rem]" /></td>}
                              {previewHasTags && <td className="px-3 py-2 align-top"><ImportPreviewTags tagNames={row.tagNames} tagColorByKey={tagColorByKey} /></td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {parsedRows.length > PREVIEW_LIMIT && (
                    <p className="text-center text-[11px] text-muted-foreground">{t('moreRows', { count: parsedRows.length - PREVIEW_LIMIT })}</p>
                  )}
                </div>
              )}
              {previewHasTags && parsedRows.some((r) => r.tagNames.length) && (
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Tag className="size-3 text-primary/80" />
                  {t('previewTags', {
                    tags: new Set(parsedRows.flatMap((r) => r.tagNames.map((n) => n.toLowerCase()))).size,
                    contacts: parsedRows.filter((r) => r.tagNames.length).length,
                  })}
                </p>
              )}
            </div>
          )}

          {step === 3 && result && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><CheckCircle className="size-5" /></span>
                <h3 className="text-base font-semibold text-foreground">{t('importComplete')}</h3>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { n: result.imported, label: tm('stats.added') },
                  { n: result.updated, label: tm('stats.updated') },
                  { n: result.skipped, label: tm('stats.skipped') },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-border bg-background/50 p-3 text-center">
                    <strong className="block text-xl font-bold tabular-nums text-foreground">{s.n}</strong>
                    <small className="text-xs text-muted-foreground">{s.label}</small>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultTags', { count: result.tagsAssigned })}
                  </div>
                )}
                {result.fieldsRejected > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="size-4 shrink-0" />
                    {tm('fieldsRejected', { count: result.fieldsRejected })}
                  </div>
                )}
                {result.invalidPhone > 0 && (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="size-4 shrink-0" />
                      {t('resultInvalidPhone', { count: result.invalidPhone })}
                    </div>
                    <p className="pl-[1.375rem] text-xs text-muted-foreground">{t('invalidPhoneHint')}</p>
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-destructive">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
              </div>

              {result.failedDetails.length > 0 && (
                <div className="space-y-1 border-t border-border/80 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-muted-foreground">{t('failedRowsHeading')}</p>
                    <Button type="button" variant="ghost" size="sm" onClick={() => downloadRejectedRows(result.failedDetails)} className="h-7 text-xs">
                      <Download className="size-3.5" />
                      {t('downloadRejected')}
                    </Button>
                  </div>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                    {result.failedDetails.map((row, i) => (
                      <li key={i} className="flex items-baseline gap-2 text-muted-foreground">
                        <span className="shrink-0 font-mono text-popover-foreground">{row.name ? `${row.name} (${row.phone})` : row.phone}</span>
                        <span className="truncate">{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-4 py-4 sm:justify-end sm:px-6">
          {step === 1 && (
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>{t('cancel')}</Button>
          )}
          {step === 2 && (
            <>
              <Button type="button" variant="outline" disabled={importing} onClick={reset}>{tm('back')}</Button>
              <Button type="button" disabled={parsedRows.length === 0 || importing || !!problem} onClick={handleImport}>
                {importing && <Loader2 className="size-4 animate-spin" />}
                {progress
                  ? t('importProgress', { done: progress.done, total: progress.total })
                  : t('importBtn', { count: parsedRows.length })}
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button type="button" variant="outline" onClick={reset}>{tm('again')}</Button>
              <Button type="button" onClick={() => handleOpenChange(false)}>{tm('done')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ImportFieldTarget = (typeof IMPORT_TARGETS)[number];
