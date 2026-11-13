"use client";

/**
 * The Payments page: links, customer payments and refunds (agents and above),
 * and the exception queue and reconciliation report (admins).
 *
 * Payment links, newest first. 'Check status' settles a link with Razorpay:
 * an unknown create is looked up by its reference before anything is created
 * again, and a live link is re-read, which may show it paid. Paid is only ever
 * set by Razorpay's verified answer, and money is credited to an order only
 * after the payment itself is verified.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Ban, Banknote, Bell, Copy, CreditCard, Loader2, MessageSquare, MoreHorizontal, Plus, RefreshCw, Search, Send, ShoppingBag, User,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { getOrder } from "@/components/commerce/orders/order-api";
import { OfflinePaymentDialog } from "./offline-payment-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, minorToDecimalString } from "@/lib/commerce/money";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreatePaymentLinkDialog } from "./create-payment-link-dialog";
import { CustomerPaymentsTable } from "./customer-payments-table";
import { ExceptionsQueue } from "./exceptions-queue";
import { ReconciliationReport } from "./reconciliation-report";
import {
  createPaymentLinkWithSend, fetchLinkStats, listPaymentLinks, LIVE_LINK, PAYMENT_LINK_STATUSES, paymentLinkAction, RECONCILABLE, sendPaymentLink,
  type LinkStatsRow, type PaymentLinkItem, type PaymentLinkStatus,
} from "./payment-api";
import { PaymentStatusBadge } from "./payment-status-badge";


export function PaymentsList() {
  const t = useTranslations("Payments.list");
  const tTabs = useTranslations("Payments.tabs");
  const isAdmin = useCan("edit-settings");
  const [tab, setTab] = useState("links");
  return (
    <div>
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="mt-5">
        <TabsList className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] *:flex-none">
          <TabsTrigger value="links">{tTabs("links")}</TabsTrigger>
          <TabsTrigger value="payments">{tTabs("payments")}</TabsTrigger>
          {isAdmin && <TabsTrigger value="exceptions">{tTabs("exceptions")}</TabsTrigger>}
          {isAdmin && <TabsTrigger value="reconciliation">{tTabs("reconciliation")}</TabsTrigger>}
        </TabsList>
        <TabsContent value="links" className="mt-4"><PaymentLinksList /></TabsContent>
        <TabsContent value="payments" className="mt-4">{tab === "payments" && <CustomerPaymentsTable />}</TabsContent>
        {isAdmin && <TabsContent value="exceptions" className="mt-4">{tab === "exceptions" && <ExceptionsQueue />}</TabsContent>}
        {isAdmin && <TabsContent value="reconciliation" className="mt-4">{tab === "reconciliation" && <ReconciliationReport />}</TabsContent>}
      </Tabs>
    </div>
  );
}

/** The four summary cards over every link (one currency: the workspace's, else the most used). */
function LinkStatsCards({ stats }: { stats: LinkStatsRow[] }) {
  const t = useTranslations("Sales.payments");
  const locale = useLocale();
  const { defaultCurrency } = useAuth();
  if (stats.length === 0) return null;
  const row = stats.find((s) => s.currency === defaultCurrency) ?? stats[0];
  const money = (minor: number) => {
    try {
      return formatMoney(minor, row.currency, locale);
    } catch {
      return `${row.currency} ${minor}`;
    }
  };
  const closed = row.paid.count + row.expired.count;
  const card = "flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4 sm:py-3.5";
  const value = "truncate text-[17px] font-bold tracking-tight tabular-nums text-foreground sm:text-[22px]";
  const others = stats.filter((s) => s.currency !== row.currency).map((s) => s.currency);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <div className={card}><span className="text-xs font-medium text-muted-foreground">{t("collected")}</span>
          <p className={value}>{money(row.paid.amount_minor)}</p><span className="text-xs text-muted-foreground">{t("paidCount", { count: row.paid.count })}</span></div>
        <div className={card}><span className="text-xs font-medium text-muted-foreground">{t("waiting")}</span>
          <p className={value}>{money(row.pending.amount_minor)}</p><span className="text-xs text-muted-foreground">{t("pendingCount", { count: row.pending.count })}</span></div>
        <div className={card}><span className="text-xs font-medium text-muted-foreground">{t("expired")}</span>
          <p className={value}>{money(row.expired.amount_minor)}</p><span className="text-xs text-muted-foreground">{t("expiredCount", { count: row.expired.count })}</span></div>
        <div className={card}><span className="text-xs font-medium text-muted-foreground">{t("paidRate")}</span>
          <p className={value}>{closed ? `${Math.round((row.paid.count / closed) * 100)}%` : "–"}</p><span className="text-xs text-muted-foreground">{t("ofClosed")}</span></div>
      </div>
      {others.length > 0 && <p className="text-xs text-muted-foreground">{t("otherCurrencies", { list: others.join(", ") })}</p>}
    </div>
  );
}

const SEGMENTS = ["", "paid", "created", "expired"] as const;
const MORE_STATUSES = PAYMENT_LINK_STATUSES.filter((s) => !(SEGMENTS as readonly string[]).includes(s));

/** Payment links, newest first (agents and above). */
export function PaymentLinksList() {
  const t = useTranslations("Payments.list");
  const ts = useTranslations("Sales.payments");
  const tStatus = useTranslations("Payments.statuses");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [links, setLinks] = useState<PaymentLinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [stats, setStats] = useState<{ stats: LinkStatsRow[]; by_status: Partial<Record<PaymentLinkStatus, number>> } | null>(null);
  const [paying, setPaying] = useState<{ orderId: string; currency: string; due: number } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  const loadStats = useCallback(async () => {
    setStats(await fetchLinkStats().catch(() => null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listPaymentLinks({ status: status || undefined, q: q || undefined }, t("loadFailed"));
      setLinks(page);
      setMore(page.length === 50);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [status, q, t]);

   
  useEffect(() => { void load(); }, [load]);
   
  useEffect(() => { void loadStats(); }, [loadStats]);

  const loadMore = async () => {
    const last = links[links.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await listPaymentLinks({ status: status || undefined, q: q || undefined, before: last.created_at }, t("loadFailed"));
      setLinks((prev) => [...prev, ...page.filter((p) => !prev.some((l) => l.id === p.id))]);
      setMore(page.length === 50);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const replace = (updated: PaymentLinkItem) => setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));

  const act = async (link: PaymentLinkItem, action: "reconcile" | "cancel") => {
    if (action === "cancel" && !window.confirm(t("cancelConfirm"))) return;
    setWorking(link.id);
    try {
      const updated = await paymentLinkAction(link.id, action, t("actionFailed"));
      replace(updated);
      toast.success(action === "cancel" ? t("cancelled") : t("reconciled", { status: tStatus(updated.status) }));
      void loadStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setWorking(null);
    }
  };

  const remind = async (link: PaymentLinkItem) => {
    setWorking(link.id);
    try {
      const send = await sendPaymentLink(link.id, crypto.randomUUID(), t("actionFailed"));
      if (send.status === "sent") toast.success(ts("reminderSent"));
      else toast.error(ts("reminderFailed", { reason: "error" in send ? send.error : "" }));
    } finally {
      setWorking(null);
    }
  };

  /** A closed link cannot come back: a new one for the same amount, customer and order is made (and sent into its chat). */
  const sendAgain = async (link: PaymentLinkItem) => {
    setWorking(link.id);
    try {
      const { link: fresh, send } = await createPaymentLinkWithSend({
        amount: minorToDecimalString(link.amount_minor, link.currency), currency: link.currency,
        description: link.description ?? undefined,
        ...(link.order_id ? { order_id: link.order_id } : {}),
        ...(link.conversation_id ? { conversation_id: link.conversation_id, send: true }
          : link.contact_id && !link.order_id ? { contact_id: link.contact_id } : {}),
        client_request_id: crypto.randomUUID(),
      }, t("actionFailed"));
      setLinks((prev) => [fresh, ...prev.filter((l) => l.id !== fresh.id)]);
      if (send?.status === "sent") toast.success(ts("sentAgain"));
      else if (send) toast.error(ts("reminderFailed", { reason: "error" in send ? send.error : "" }));
      else toast.success(ts("madeAgain"));
      void loadStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setWorking(null);
    }
  };

  const recordPayment = async (link: PaymentLinkItem) => {
    if (!link.order_id) return;
    const r = await getOrder(link.order_id);
    if (!r.ok) { toast.error(t("actionFailed")); return; }
    const o = r.value;
    setPaying({ orderId: o.id, currency: o.currency, due: (o.total_minor ?? o.subtotal_minor) - o.amount_paid_minor });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const count = (s: string) => (s === "" ? Object.values(stats?.by_status ?? {}).reduce((a, b) => a + (b ?? 0), 0) : stats?.by_status[s as PaymentLinkStatus] ?? 0);
  const segLabel = (s: string) => (s === "" ? ts("all") : s === "created" ? ts("pending") : tStatus(s));

  return (
    <div className="space-y-4">
      {stats && <LinkStatsCards stats={stats.stats} />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex max-w-full overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]" role="group" aria-label={t("statusFilter")}>
          {SEGMENTS.map((s) => (
            <button key={s || "all"} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}
              className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-primary ${
                status === s ? "bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-input" : "text-muted-foreground hover:text-foreground"}`}>
              {segLabel(s)}{stats && <b className="text-xs font-semibold tabular-nums opacity-70">{count(s)}</b>}
            </button>
          ))}
        </div>
        <Select value={(MORE_STATUSES as readonly string[]).includes(status) ? status : ""} onValueChange={(v) => setStatus(v ? String(v) : "")}>
          <SelectTrigger className="w-44 max-w-full" aria-label={ts("moreStatuses")}><SelectValue placeholder={ts("moreStatuses")} /></SelectTrigger>
          <SelectContent>
            {MORE_STATUSES.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}{stats ? ` (${count(s)})` : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="hidden flex-1 sm:block" />
        <div className="relative w-full min-w-0 sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={ts("search")} aria-label={ts("search")}
            maxLength={100} className="pl-8" />
        </div>
        {canAct && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("new")}
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : links.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
            <span className="mb-1 flex size-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary"><CreditCard className="size-6" /></span>
            <p>{status || q ? ts("noMatches") : t("empty")}</p>
            {status || q ? (
              <Button variant="outline" size="sm" onClick={() => { setStatus(""); setDraft(""); }}>{ts("clearFilters")}</Button>
            ) : <p className="text-xs">{t("emptyHelp")}</p>}
          </div>
        ) : (
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
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
              {links.map((link) => {
                const live = LIVE_LINK.has(link.status);
                const closedUnpaid = link.status === "expired" || link.status === "cancelled" || link.status === "failed";
                return (
                  <TableRow key={link.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {format.dateTime(new Date(link.created_at), { dateStyle: "medium", timeStyle: "short" })}
                      {live && link.expires_at && (
                        <span className="block">{ts("expires", { date: format.dateTime(new Date(link.expires_at), { dateStyle: "medium" }) })}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums">{formatMoney(link.amount_minor, link.currency, locale)}</TableCell>
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
                        {link.short_url && !closedUnpaid && (
                          <Button variant="ghost" size="icon-sm" onClick={() => void copy(link.short_url!)} title={t("copy")} aria-label={t("copy")}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger aria-label={ts("linkActions")} disabled={working === link.id}
                            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
                            {working === link.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {link.short_url && live && <DropdownMenuItem onClick={() => void copy(link.short_url!)}><Copy className="h-4 w-4" /> {t("copy")}</DropdownMenuItem>}
                            {canAct && live && link.conversation_id && (
                              <DropdownMenuItem onClick={() => void remind(link)}><Bell className="h-4 w-4" /> {ts("sendReminder")}</DropdownMenuItem>
                            )}
                            {canAdmin && live && link.order_id && (
                              <DropdownMenuItem onClick={() => void recordPayment(link)}><Banknote className="h-4 w-4" /> {ts("recordPayment")}</DropdownMenuItem>
                            )}
                            {canAct && RECONCILABLE.has(link.status) && (
                              <DropdownMenuItem onClick={() => void act(link, "reconcile")}><RefreshCw className="h-4 w-4" /> {t("reconcile")}</DropdownMenuItem>
                            )}
                            {canAct && closedUnpaid && (
                              <DropdownMenuItem onClick={() => void sendAgain(link)}><Send className="h-4 w-4" /> {ts("sendAgain")}</DropdownMenuItem>
                            )}
                            {link.order_id && (
                              <DropdownMenuItem render={<Link href={`/commerce/orders/${link.order_id}`} />}><ShoppingBag className="h-4 w-4" /> {ts("openOrder")}</DropdownMenuItem>
                            )}
                            {link.conversation_id && (
                              <DropdownMenuItem render={<Link href={`/inbox?c=${link.conversation_id}`} />}><MessageSquare className="h-4 w-4" /> {ts("openChat")}</DropdownMenuItem>
                            )}
                            {link.contact_id && (
                              <DropdownMenuItem render={<Link href={`/contacts?contact=${link.contact_id}`} />}><User className="h-4 w-4" /> {ts("openContact")}</DropdownMenuItem>
                            )}
                            {canAct && live && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => void act(link, "cancel")}><Ban className="h-4 w-4" /> {ts("expireNow")}</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {more && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}

      <CreatePaymentLinkDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(link) => { setLinks((prev) => [link, ...prev.filter((l) => l.id !== link.id)]); void loadStats(); }}
      />
      {paying && (
        <OfflinePaymentDialog orderId={paying.orderId} currency={paying.currency} dueMinor={paying.due} open
          onOpenChange={(open) => { if (!open) setPaying(null); }}
          onRecorded={() => { setPaying(null); void load(); void loadStats(); }} />
      )}
    </div>
  );
}
