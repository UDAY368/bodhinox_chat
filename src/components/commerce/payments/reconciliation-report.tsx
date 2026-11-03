"use client";

/**
 * Per day, in the workspace timezone: money captured (gateway and
 * staff-recorded), refunds processed (including ones made in the Razorpay
 * dashboard) and net, so the totals can be checked against Razorpay's
 * settlement report. Admins.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/commerce/money";
import { fetchReconciliation, type ReconciliationReport as Report } from "./customer-payments-api";

export function ReconciliationReport() {
  const t = useTranslations("Payments.reconciliation");
  const locale = useLocale();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range: { from?: string; to?: string }) => {
    setLoading(true);
    try {
      const next = await fetchReconciliation(range, t("loadFailed"));
      setReport(next);
      setFrom(next.from);
      setTo(next.to);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load({}); }, [load]);

  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  return (
    <div>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="recon-from" className="mb-1 block text-xs text-muted-foreground">{t("from")}</Label>
          <Input id="recon-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div>
          <Label htmlFor="recon-to" className="mb-1 block text-xs text-muted-foreground">{t("to")}</Label>
          <Input id="recon-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button variant="outline" onClick={() => void load({ from, to })} disabled={loading || !from || !to}>{t("apply")}</Button>
      </div>

      {loading || !report ? (
        <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="mt-4 space-y-4">
          {(report.open_exceptions > 0 || report.unresolved_refunds > 0) && (
            <p className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t("attention", { exceptions: report.open_exceptions, refunds: report.unresolved_refunds })}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            {report.totals.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : report.totals.map((total) => (
              <div key={total.currency} className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">{t("net", { currency: total.currency })}</p>
                <p className="text-xl font-semibold">{money(total.net_minor, total.currency)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("totals", { captured: money(total.captured_minor, total.currency), refunds: money(total.refunds_minor, total.currency) })}
                </p>
              </div>
            ))}
          </div>
          {report.days.length > 0 && (
            <div className="rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colDay")}</TableHead>
                    <TableHead>{t("colCaptured")}</TableHead>
                    <TableHead>{t("colRefunds")}</TableHead>
                    <TableHead>{t("colExternal")}</TableHead>
                    <TableHead>{t("colNet")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.days.map((d) => (
                    <TableRow key={`${d.day}:${d.currency}`}>
                      <TableCell className="whitespace-nowrap text-xs">{d.day}</TableCell>
                      <TableCell>{money(d.captured_minor, d.currency)} <span className="text-xs text-muted-foreground">({d.captured_count})</span></TableCell>
                      <TableCell>{money(d.refunds_minor, d.currency)} <span className="text-xs text-muted-foreground">({d.refunds_count})</span></TableCell>
                      <TableCell>{money(d.external_refunds_minor, d.currency)}</TableCell>
                      <TableCell className="font-medium">{money(d.net_minor, d.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("timezone", { timezone: report.timezone })}</p>
        </div>
      )}
    </div>
  );
}
