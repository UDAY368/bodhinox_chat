"use client";

/**
 * Money customers paid (gateway payments verified with Razorpay, and
 * staff-recorded offline payments), newest first, with their refunds.
 * Admins refund from here. With `orderId` it is the order detail's
 * payments panel (OrderPaymentsPanel).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, RefreshCw, Undo2, Wallet } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/commerce/money";
import { listCustomerPayments, listRefunds, refundAction, type CustomerPaymentItem, type CustomerRefundItem } from "./customer-payments-api";
import { RefundDialog } from "./refund-dialog";

const SETTLEMENT_VARIANT = { settled: "default", pending: "outline", exception: "destructive", unattached: "secondary" } as const;
const REFUND_VARIANT = { processed: "default", pending: "outline", requested: "outline", sending: "outline", unknown: "destructive", failed: "destructive" } as const;

export function CustomerPaymentsTable({ orderId, restockByDefault = false }: { orderId?: string; restockByDefault?: boolean }) {
  const t = useTranslations("Payments.customer");
  const tr = useTranslations("Payments.refunds");
  const format = useFormatter();
  const locale = useLocale();
  const isAdmin = useCan("edit-settings");
  const [payments, setPayments] = useState<CustomerPaymentItem[]>([]);
  const [refunds, setRefunds] = useState<CustomerRefundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<CustomerPaymentItem | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([listCustomerPayments({ orderId }, t("loadFailed")), listRefunds({ orderId }, t("loadFailed"))]);
      setPayments(p);
      setRefunds(r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [orderId, t]);

  useEffect(() => { void load(); }, [load]);

  const act = async (refund: CustomerRefundItem, action: "reconcile" | "retry") => {
    if (action === "retry" && !window.confirm(tr("retryConfirm"))) return;
    setWorking(refund.id);
    try {
      await refundAction(refund.id, action, tr("actionFailed"));
      toast.success(action === "retry" ? tr("retried") : tr("reconciled"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tr("actionFailed"));
    } finally {
      setWorking(null);
    }
  };

  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—");

  if (loading) return <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border">
        {payments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Wallet className="h-6 w-6" />
            <p>{t("empty")}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colDate")}</TableHead>
                <TableHead>{t("colAmount")}</TableHead>
                <TableHead>{t("colSource")}</TableHead>
                <TableHead>{t("colSettlement")}</TableHead>
                {!orderId && <TableHead>{t("colFor")}</TableHead>}
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{date(p.captured_at ?? p.created_at)}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {formatMoney(p.amount_minor, p.currency, locale)}
                    {p.refunded_minor > 0 && (
                      <span className="block text-xs text-muted-foreground">{t("refunded", { amount: formatMoney(p.refunded_minor, p.currency, locale) })}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.source === "offline"
                      ? <span>{t("offline", { method: t(`methods.${p.method ?? "other"}`) })}{p.offline_reference ? ` · ${p.offline_reference}` : ""}</span>
                      : <span className="font-mono">{p.provider_payment_id}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.status === "captured" ? SETTLEMENT_VARIANT[p.settlement] : "outline"}>
                      {p.status === "captured" ? t(`settlements.${p.settlement}`) : t(`statuses.${p.status}`)}
                    </Badge>
                  </TableCell>
                  {!orderId && (
                    <TableCell className="text-xs">
                      {p.order_id ? <Link href={`/commerce/orders/${p.order_id}`} className="text-primary hover:underline">{t("order")}</Link>
                        : p.appointment_id ? <span>{t("appointment")}</span> : <span className="text-muted-foreground">{t("link")}</span>}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    {isAdmin && p.refundable_minor > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setRefunding(p)} title={tr("refund")} aria-label={tr("refund")}>
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {refunds.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{tr("heading")}</h3>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colDate")}</TableHead>
                  <TableHead>{t("colAmount")}</TableHead>
                  <TableHead>{tr("colReason")}</TableHead>
                  <TableHead>{tr("colStatus")}</TableHead>
                  <TableHead className="text-right">{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refunds.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{date(r.processed_at ?? r.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{formatMoney(r.amount_minor, r.currency, locale)}</TableCell>
                    <TableCell className="text-xs">
                      {r.source === "external" ? tr("external") : tr(`reasons.${r.reason_code}`)}
                      {r.restock && <span className="block text-muted-foreground">{tr("restocks")}</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={REFUND_VARIANT[r.status]}>{tr(`statuses.${r.status}`)}</Badge>
                      {r.status === "failed" && r.failure_code === "absent" && <span className="block text-xs text-muted-foreground">{tr("absent")}</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {isAdmin && (r.status === "unknown" || r.status === "pending" || r.status === "sending") && (
                          <Button variant="ghost" size="sm" disabled={working === r.id} onClick={() => void act(r, "reconcile")} title={tr("reconcile")} aria-label={tr("reconcile")}>
                            {working === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          </Button>
                        )}
                        {isAdmin && r.status === "failed" && r.source === "bodhinox" && (
                          <Button variant="outline" size="sm" disabled={working === r.id} onClick={() => void act(r, "retry")}>{tr("retry")}</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <RefundDialog payment={refunding} open={refunding !== null} onOpenChange={(open) => !open && setRefunding(null)}
        defaultRestock={restockByDefault} onRequested={() => void load()} />
    </div>
  );
}

/** The order detail's payments and refunds panel (mounted by the order page). */
export function OrderPaymentsPanel({ orderId, dispatched }: { orderId: string; dispatched: boolean }) {
  return <CustomerPaymentsTable orderId={orderId} restockByDefault={!dispatched} />;
}
