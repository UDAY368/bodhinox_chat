"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Undo2 } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { listReturnQueue, RETURN_QUEUE_PAGE, type ReturnQueueFilter, type ReturnQueueItem } from "./orders-list-api";
import { RowPlaceholders } from "./list-states";
import { InlineError } from "@/components/ui/inline-error";
import { StateBadge } from "./state-badge";
import type { Tone } from "@/lib/commerce/order-state";
import { EmptyState } from "@/components/ui/empty-state";

const FILTERS: ReturnQueueFilter[] = ["open", "requested", "received", "inspected", "closed", "rejected"];
const ALL = "all";
const TONE: Record<ReturnQueueItem["status"], Tone> = { requested: "warn", received: "accent", inspected: "accent", closed: "ok", rejected: "neutral" };

/** Every return of the workspace, newest first; a row opens its order, where the return is handled. */
export function ReturnsQueue({ onOpenOrder, reloadKey }: { onOpenOrder: (orderId: string) => void; reloadKey: number }) {
  const t = useTranslations("Commerce.orders.listing");
  const tr = useTranslations("Commerce.returns");
  const format = useFormatter();
  const [status, setStatus] = useState<ReturnQueueFilter | "">("open");
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // The answer is kept with the request it belongs to: anything older reads as still loading.
  const key = `${status}|${page}|${attempt}|${reloadKey}`;
  const [result, setResult] = useState<{ key: string; data: { returns: ReturnQueueItem[]; total: number } | null } | null>(null);
  const data = result?.key === key ? result.data : null;
  const failed = result?.key === key && result.data === null;

  useEffect(() => {
    let cancelled = false;
    listReturnQueue(status, page)
      .then((next) => !cancelled && setResult({ key, data: next }))
      .catch(() => !cancelled && setResult({ key, data: null }));
    return () => { cancelled = true; };
  }, [status, page, key]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / RETURN_QUEUE_PAGE)) : 1;

  return (
    <div className="space-y-4">
      <Select value={status || ALL} onValueChange={(v) => { setStatus(v === ALL ? "" : (v as ReturnQueueFilter)); setPage(0); }}>
        <SelectTrigger className="min-h-11 w-48 max-w-full sm:min-h-9" aria-label={t("returns.filter")}>
          <SelectValue>{(v: string) => (v === ALL ? t("returns.all") : v === "open" ? t("returns.open") : tr(`statuses.${v as Exclude<ReturnQueueFilter, "open">}`))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("returns.all")}</SelectItem>
          {FILTERS.map((f) => <SelectItem key={f} value={f}>{f === "open" ? t("returns.open") : tr(`statuses.${f}`)}</SelectItem>)}
        </SelectContent>
      </Select>

      {failed ? (
        <InlineError message={t("returns.loadError")} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !data ? (
        <RowPlaceholders label={t("loading")} />
      ) : data.returns.length === 0 ? (
        <EmptyState icon={Undo2} title={t("returns.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("returns.colOrder")}</TableHead>
                <TableHead>{t("returns.colCustomer")}</TableHead>
                <TableHead className="text-right">{t("returns.colUnits")}</TableHead>
                <TableHead>{t("returns.colStatus")}</TableHead>
                <TableHead>{t("returns.colOpened")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.returns.map((r) => (
                <TableRow key={r.id} tabIndex={0} className="min-h-11 cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                  aria-label={t("returns.openOrder", { ref: r.order_ref })}
                  onClick={() => onOpenOrder(r.order_id)}
                  onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpenOrder(r.order_id); }}>
                  <TableCell className="whitespace-nowrap font-medium tabular-nums">{r.order_ref}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">{r.contact_name || t("unknownCustomer")}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.units}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StateBadge tone={r.pending_approval ? "warn" : TONE[r.status]}>
                        {r.pending_approval ? t("returns.waitingApproval") : tr(`statuses.${r.status}`)}
                      </StateBadge>
                      {r.is_exchange && <StateBadge tone="neutral">{t("returns.exchange")}</StateBadge>}
                      {r.source === "buyer" && !r.pending_approval && <span className="text-xs text-muted-foreground">{t("returns.buyer")}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(new Date(r.created_at), { dateStyle: "medium" })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.total > RETURN_QUEUE_PAGE && (
            <TablePagination className="border-t border-border" page={page} totalPages={totalPages} onPageChange={setPage}
              summary={t("pageSummary", { start: page * RETURN_QUEUE_PAGE + 1, end: Math.min((page + 1) * RETURN_QUEUE_PAGE, data.total), total: data.total })}
              labels={{ nav: t("pageNav"), previous: t("pagePrevious"), next: t("pageNext"), page: (n) => t("pageNumber", { n }) }} />
          )}
        </div>
      )}
    </div>
  );
}
