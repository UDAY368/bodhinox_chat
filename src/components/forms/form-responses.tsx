"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, Inbox, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/broadcasts/campaign-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FormDefinition } from "@/lib/whatsapp/forms/types";
import { exportResponses, listResponses, type FormResponseRow } from "./form-api";
import { formatAnswer, optionTitles, responseColumns } from "./form-editing";

const PAGE_SIZE = 50;

/** Submitted answers, newest first, one column per question. */
export function FormResponses({
  formId,
  definition,
  canExport,
}: {
  formId: string;
  definition: FormDefinition;
  canExport: boolean;
}) {
  const t = useTranslations("Forms.responses");
  const tc = useTranslations("Campaigns");
  const format = useFormatter();
  const [rows, setRows] = useState<FormResponseRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(
    async (after: string | null) => {
      const page = await listResponses(formId, after, PAGE_SIZE);
      setRows((prev) => (after ? [...prev, ...page.responses] : page.responses));
      setCursor(page.next_cursor);
    },
    [formId],
  );

  useEffect(() => {
    let cancelled = false;
    load(null)
      .catch(() => !cancelled && toast.error(t("loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  const columns = useMemo(() => responseColumns(definition, rows), [definition, rows]);
  const titles = useMemo(() => optionTitles(definition), [definition]);
  // Search over the loaded responses: contact name or number, or any answer.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      (row.contact?.name ?? "").toLowerCase().includes(q) ||
      (row.contact?.phone ?? "").toLowerCase().includes(q) ||
      Object.values(row.answers ?? {}).some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, query]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      if (!(await exportResponses(formId))) toast.error(t("exportError"));
    } catch {
      toast.error(t("exportError"));
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("summary", { count: rows.length, more: cursor ? "yes" : "no" })}</p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {rows.length > 0 && (
            <SearchField ariaLabel={tc("forms.searchResponses")} placeholder={tc("forms.searchResponses")} value={query} onChange={setQuery} className="sm:w-56" />
          )}
          {canExport && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || rows.length === 0}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              {t("export")}
            </Button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-border bg-card px-6 py-12 text-center">
          <span className="inline-flex size-13 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden><Inbox className="h-6 w-6" /></span>
          <p className="mt-3 text-[15px] font-semibold text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{t("emptyDesc")}</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">{tc("forms.noResponseMatches")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="whitespace-nowrap">{t("colDate")}</TableHead>
                <TableHead>{t("colContact")}</TableHead>
                {columns.map((c) => (
                  <TableHead key={c.key} className="whitespace-nowrap">{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {format.dateTime(new Date(row.created_at), { dateStyle: "medium", timeStyle: "short" })}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.contact ? (
                      <span className="flex flex-col">
                        <span className="text-foreground">{row.contact.name || row.contact.phone || t("unnamed")}</span>
                        {row.contact.name && row.contact.phone && (
                          <span className="text-xs text-muted-foreground">{row.contact.phone}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("noContact")}</span>
                    )}
                  </TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="max-w-[18rem] whitespace-normal break-words">
                      {formatAnswer(row.answers[c.key], t("yes"), t("no"), titles.get(c.key))}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
