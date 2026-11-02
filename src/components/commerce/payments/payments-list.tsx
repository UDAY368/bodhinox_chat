"use client";

/**
 * Payment links, newest first (agents and above). 'Check status' settles a
 * link with Razorpay: an unknown create is looked up by its reference before
 * anything is created again, and a live link is re-read, which may show it
 * paid. Paid is only ever set by Razorpay's verified answer.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Copy, CreditCard, Loader2, Plus, RefreshCw } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/commerce/money";
import { CreatePaymentLinkDialog } from "./create-payment-link-dialog";
import { listPaymentLinks, PAYMENT_LINK_STATUSES, paymentLinkAction, RECONCILABLE, type PaymentLinkItem } from "./payment-api";
import { PaymentStatusBadge } from "./payment-status-badge";

const ALL = "all";

export function PaymentsList() {
  const t = useTranslations("Payments.list");
  const tStatus = useTranslations("Payments.statuses");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const [status, setStatus] = useState("");
  const [links, setLinks] = useState<PaymentLinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listPaymentLinks({ status: status || undefined }, t("loadFailed"));
      setLinks(page);
      setMore(page.length === 50);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    const last = links[links.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await listPaymentLinks({ status: status || undefined, before: last.created_at }, t("loadFailed"));
      setLinks((prev) => [...prev, ...page.filter((p) => !prev.some((l) => l.id === p.id))]);
      setMore(page.length === 50);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const act = async (link: PaymentLinkItem, action: "reconcile" | "cancel") => {
    if (action === "cancel" && !window.confirm(t("cancelConfirm"))) return;
    setWorking(link.id);
    try {
      const updated = await paymentLinkAction(link.id, action, t("actionFailed"));
      setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      toast.success(action === "cancel" ? t("cancelled") : t("reconciled", { status: tStatus(updated.status) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setWorking(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canAct && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            {t("new")}
          </Button>
        )}
      </div>

      <div className="mt-6 flex items-center gap-2">
        <Select value={status || ALL} onValueChange={(v) => setStatus(!v || v === ALL ? "" : v)}>
          <SelectTrigger className="w-48" aria-label={t("statusFilter")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {PAYMENT_LINK_STATUSES.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 rounded-lg border border-border">
        {loading ? (
          <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : links.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <CreditCard className="h-6 w-6" />
            <p>{t("empty")}</p>
            <p className="text-xs">{t("emptyHelp")}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colCreated")}</TableHead>
                <TableHead>{t("colAmount")}</TableHead>
                <TableHead>{t("colDescription")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colSource")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {format.dateTime(new Date(link.created_at), { dateStyle: "medium", timeStyle: "short" })}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium">{formatMoney(link.amount_minor, link.currency, locale)}</TableCell>
                  <TableCell className="max-w-[240px] truncate text-sm">{link.description || "—"}</TableCell>
                  <TableCell><PaymentStatusBadge status={link.status} /></TableCell>
                  <TableCell className="text-xs">
                    {link.conversation_id ? (
                      <Link href={`/inbox?c=${link.conversation_id}`} className="text-primary hover:underline">{link.flow_run_id ? t("sourceFlow") : t("sourceConversation")}</Link>
                    ) : link.order_id ? (
                      <Link href={`/commerce/orders/${link.order_id}`} className="text-primary hover:underline">{t("sourceOrder")}</Link>
                    ) : (
                      <span className="text-muted-foreground">{t("sourceManual")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {link.short_url && (
                        <Button variant="ghost" size="sm" onClick={() => void copy(link.short_url!)} title={t("copy")} aria-label={t("copy")}>
                          <Copy className="h-4 w-4" />
                        </Button>
                      )}
                      {canAct && RECONCILABLE.has(link.status) && (
                        <Button variant="ghost" size="sm" disabled={working === link.id} onClick={() => void act(link, "reconcile")} title={t("reconcile")} aria-label={t("reconcile")}>
                          {working === link.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                      )}
                      {canAct && (link.status === "created" || link.status === "partially_paid") && (
                        <Button variant="ghost" size="sm" disabled={working === link.id} onClick={() => void act(link, "cancel")} title={t("cancel")} aria-label={t("cancel")}>
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {more && !loading && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}

      <CreatePaymentLinkDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(link) => setLinks((prev) => [link, ...prev.filter((l) => l.id !== link.id)])}
      />
    </div>
  );
}
