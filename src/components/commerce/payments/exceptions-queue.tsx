"use client";

/**
 * Payments that did not settle silently, and refunds that need a person
 * (admins). A held payment closes only by refunding it in full, or, for a
 * late payment that found no stock, by restocking and accepting it; the
 * others are dismissed once handled.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/commerce/money";
import { listExceptions, resolveException, type PaymentExceptionItem, type Resolution } from "./customer-payments-api";
import { PageLoading } from "@/components/ui/page-loading";
import { EmptyState } from "@/components/ui/empty-state";

export function ExceptionsQueue() {
  const t = useTranslations("Payments.exceptions");
  const confirm = useConfirm();
  const format = useFormatter();
  const locale = useLocale();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [rows, setRows] = useState<PaymentExceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listExceptions(status, t("loadFailed")));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (row: PaymentExceptionItem, resolution: Resolution) => {
    if (!(await confirm({ title: t(`confirm.${resolution}`), confirmLabel: t(`resolutions.${resolution}`), destructive: resolution === "dismissed" }))) return;
    setWorking(row.id);
    try {
      await resolveException(row.id, resolution, t("resolveFailed"));
      toast.success(t("resolved"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("resolveFailed"));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <SegmentedControl
          aria-label={t("statusFilter")}
          value={status}
          onValueChange={setStatus}
          options={[{ value: "open", label: t("open") }, { value: "resolved", label: t("resolvedFilter") }]}
        />
      </div>
      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
        {loading ? (
          <PageLoading rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState icon={CheckCircle2} title={status === "open" ? t("emptyOpen") : t("emptyResolved")} />
        ) : (
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("colDate")}</TableHead>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead>{t("colAmount")}</TableHead>
                <TableHead>{t("colFor")}</TableHead>
                <TableHead className="text-right">{status === "open" ? t("colActions") : t("colResolution")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{format.dateTime(new Date(row.created_at), { dateStyle: "medium", timeStyle: "short" })}</TableCell>
                  <TableCell className="text-sm">
                    <span className="font-medium">{t(`kinds.${row.kind}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`help.${row.kind}`)}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.amount_minor !== null && row.currency ? formatMoney(row.amount_minor, row.currency, locale) : "—"}</TableCell>
                  <TableCell className="text-xs">
                    {row.order_id ? <Link href={`/commerce/orders/${row.order_id}`} className="text-primary hover:underline">{t("order")}</Link>
                      : row.appointment_id ? <Link href={`/appointments?id=${row.appointment_id}`} className="text-primary hover:underline">{t("appointment")}</Link> : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === "open" ? (
                      <div className="flex justify-end gap-1">
                        {row.allowed_resolutions.map((r) => (
                          <Button key={r} variant="outline" size="sm" disabled={working === row.id} onClick={() => void resolve(row, r)}>
                            {working === row.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                            {t(`resolutions.${r}`)}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.resolution ? t(`resolutions.${row.resolution}`) : "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
