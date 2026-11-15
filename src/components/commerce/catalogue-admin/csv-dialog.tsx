"use client";

/**
 * Product CSV import. Pick a file, see a dry run (what would be added, updated and refused, row by
 * row), then confirm. A small file applies at once; a big one is queued and its progress shows here.
 * The server reads the file again on confirm: nothing here is trusted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchImportJobs, importProductCsv, previewProductCsv, type ImportJobView, type ImportPreview, type RowError,
} from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";

const MAX_BYTES = 5 * 1024 * 1024;

export function CsvImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const t = useTranslations("Commerce.catalogue.csv");
  const errorText = useCatalogueError();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ created: number; updated: number; errors: number } | null>(null);
  const [jobs, setJobs] = useState<ImportJobView[]>([]);

  const loadJobs = useCallback(() => {
    fetchImportJobs().then((r) => { if (r.ok) setJobs(r.data); });
  }, []);
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => { if (open) loadJobs(); }, [open, loadJobs]);
  useEffect(() => {
    if (!open || !active) return;
    const timer = setInterval(loadJobs, 3000);
    return () => clearInterval(timer);
  }, [open, active, loadJobs]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) onDone();
    wasActive.current = active;
  }, [active, onDone]);

  const reset = () => { setText(null); setPreview(null); setError(null); setOutcome(null); if (input.current) input.current.value = ""; };
  const close = (next: boolean) => { if (!next) reset(); onOpenChange(next); };

  async function pick(file: File | undefined) {
    reset();
    if (!file) return;
    if (file.size > MAX_BYTES) { setError(t("tooLarge")); return; }
    setBusy(true);
    const content = await file.text();
    const r = await previewProductCsv(content);
    setBusy(false);
    if (!r.ok) { setError(errorText(r)); return; }
    setText(content);
    setPreview(r.data);
  }

  async function confirm() {
    if (text === null) return;
    setBusy(true); setError(null);
    const r = await importProductCsv(text);
    setBusy(false);
    if (!r.ok) { setError(errorText(r)); return; }
    if (r.data.mode === "queued") { toast.success(t("queued")); setPreview(null); setText(null); loadJobs(); return; }
    setOutcome({ created: r.data.created, updated: r.data.updated, errors: r.data.error_count });
    setPreview(null); setText(null);
    onDone();
  }

  const fieldName = (f: string) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : f);
  const codeName = (c: string) => (t.has(`codes.${c}`) ? t(`codes.${c}`) : t("codes.invalid"));
  const importable = preview ? preview.create + preview.update : 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="csv-file">{t("file")}</Label>
            <Input id="csv-file" ref={input} type="file" accept=".csv,text/csv" disabled={busy || active}
              onChange={(e) => void pick(e.target.files?.[0])} />
            <p className="text-xs text-muted-foreground">{t("rules")}</p>
          </div>
          {busy && <div className="flex justify-center p-2"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("working")} /></div>}
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}

          {preview && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{t("previewTitle")}</h3>
              <ul className="grid grid-cols-2 gap-2 text-sm @container sm:grid-cols-4">
                <li className="rounded-lg border border-border p-2"><b className="block text-lg tabular-nums">{preview.create}</b>{t("willCreate")}</li>
                <li className="rounded-lg border border-border p-2"><b className="block text-lg tabular-nums">{preview.update}</b>{t("willUpdate")}</li>
                <li className="rounded-lg border border-border p-2"><b className="block text-lg tabular-nums">{preview.new_products}</b>{t("newProducts")}</li>
                <li className="rounded-lg border border-border p-2"><b className="block text-lg tabular-nums">{preview.error_count}</b>{t("willSkip")}</li>
              </ul>
              <p className="text-xs text-muted-foreground">{preview.mode === "queued" ? t("modeQueued", { count: preview.total_rows }) : t("modeInline")}</p>
              {preview.ignored_columns > 0 && <p className="text-xs text-muted-foreground">{t("ignoredColumns", { count: preview.ignored_columns })}</p>}
              <ErrorTable errors={preview.errors} capped={preview.errors_capped} fieldName={fieldName} codeName={codeName} />
            </div>
          )}

          {outcome && (
            <div role="status" className="rounded-lg border border-border p-3 text-sm">
              {t("done", { created: outcome.created, updated: outcome.updated, errors: outcome.errors })}
            </div>
          )}

          {jobs.slice(0, 3).map((j) => <JobCard key={j.id} job={j} fieldName={fieldName} codeName={codeName} />)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>{t("close")}</Button>
          {preview && (
            <Button disabled={busy || importable === 0} onClick={() => void confirm()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("confirm", { count: importable })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorTable({ errors, capped, fieldName, codeName }: {
  errors: RowError[]; capped: boolean; fieldName: (f: string) => string; codeName: (c: string) => string;
}) {
  const t = useTranslations("Commerce.catalogue.csv");
  if (!errors.length) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{t("errorsTitle")}</h4>
      <div className="max-h-56 overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t("colRow")}</TableHead><TableHead>{t("colColumn")}</TableHead><TableHead>{t("colProblem")}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {errors.map((e, i) => (
              <TableRow key={`${e.row}-${e.field}-${i}`}>
                <TableCell className="tabular-nums">{e.row}</TableCell>
                <TableCell>{fieldName(e.field)}</TableCell>
                <TableCell>{codeName(e.code)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {capped && <p className="text-xs text-muted-foreground">{t("errorsCapped", { count: errors.length })}</p>}
    </div>
  );
}

function JobCard({ job, fieldName, codeName }: { job: ImportJobView; fieldName: (f: string) => string; codeName: (c: string) => string }) {
  const t = useTranslations("Commerce.catalogue.csv");
  const running = job.status === "queued" || job.status === "running";
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t(`job.${job.status}`)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{t("progress", { done: job.processed_rows, total: job.total_rows })}</span>
      </div>
      {running && <progress className="h-2 w-full" max={job.total_rows} value={job.processed_rows} aria-label={t("job.running")} />}
      <p className="text-xs text-muted-foreground">{t("done", { created: job.created_count, updated: job.updated_count, errors: job.error_count })}</p>
      {job.error_code && <p role="alert" className="text-xs text-destructive">{t.has(`jobErrors.${job.error_code}`) ? t(`jobErrors.${job.error_code}`) : t("jobErrors.import_failed")}</p>}
      {!running && <ErrorTable errors={job.errors} capped={job.error_count > job.errors.length} fieldName={fieldName} codeName={codeName} />}
    </div>
  );
}
