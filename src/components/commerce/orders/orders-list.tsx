"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Banknote, Download, Eye, Link2, Loader2, MoreHorizontal, Plus, Search, Send, Settings2, ShoppingBag, Truck, Undo2, X,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, minorToDecimalString } from "@/lib/commerce/money";
import { ORDER_SOURCES, ORDER_STATUSES, type OrderSource, type OrderStatus } from "@/lib/commerce/order-format";
import { listOrders, type OrderListItem } from "./order-api";
import { OrderDrawer, type OrderIntent } from "./order-drawer";
import { NewOrderDialog } from "./new-order-dialog";
import { OrderSettingsDialog } from "./order-settings-dialog";
import {
  canCancelUnpaid, canTakeLinkPayment, FULFILMENT_TONE, fulfilmentState, orderRef, PAYMENT_TONE, paymentState, toCsv,
} from "./order-state";
import { StateBadge } from "./state-badge";

const ALL = "all";
/** The export reads at most this many orders (the current filters). */
const EXPORT_MAX = 2000;

/** The step a list row can offer without the order's detail (the drawer re-checks it with the full order). */
function listStep(o: OrderListItem): "ship" | "deliver" | "confirm" | null {
  if (o.refund_state === "full" && o.status !== "dispatched" && o.status !== "fulfilled") return null;
  if (o.status === "paid") return "ship";
  if (o.status === "dispatched") return "deliver";
  if (o.status === "confirmed" && o.payment_method === "cod" && !o.paid_at) return "ship";
  if (o.status === "new") return "confirm";
  return null;
}

/** Orders from WhatsApp carts, the storefront, connected stores and manual orders, newest first, for agents and above. */
export function OrdersList() {
  const t = useTranslations("Commerce.orders");
  const ts = useTranslations("Sales.orders");
  const tSource = useTranslations("Commerce.orders.sources");
  const tStatus = useTranslations("Commerce.orders.statuses");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  const [status, setStatus] = useState<OrderStatus | "">("");
  const [source, setSource] = useState<OrderSource | "">("");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<{ id: string; intent: OrderIntent | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
     
    setLoading(true);
    listOrders({ status, source, q })
      .then((page) => {
        if (cancelled) return;
        setOrders(page.orders);
        setCursor(page.next_cursor);
      })
      .catch(() => !cancelled && toast.error(t("loadError")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [status, source, q, t, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listOrders({ status, source, q, cursor });
      setOrders((prev) => [...prev, ...page.orders.filter((o) => !prev.some((p) => p.id === o.id))]);
      setCursor(page.next_cursor);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, status, source, q, t]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  async function exportCsv() {
    setExporting(true);
    try {
      const all: OrderListItem[] = [];
      let next: string | null = null;
      do {
        const page = await listOrders({ status, source, q, cursor: next });
        all.push(...page.orders);
        next = page.next_cursor;
      } while (next && all.length < EXPORT_MAX);
      const rows = all.slice(0, EXPORT_MAX).map((o) => [
        orderRef(o), o.created_at.slice(0, 10), o.contact?.name || o.contact?.phone || "", o.item_count,
        minorToDecimalString(o.total_minor ?? o.subtotal_minor, o.currency), o.currency,
        ts(`pay.${paymentState(o)}`), ts(`ful.${fulfilmentState(o.status)}`), tSource(o.source),
      ]);
      const header = ["order", "date", "customer", "items", "total", "currency", "payment", "fulfilment", "source"].map((k) => ts(`csv.${k}`));
      const blob = new Blob([`﻿${toCsv([header, ...rows])}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(ts("exported", { count: rows.length }));
    } catch {
      toast.error(ts("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const openOrder = (id: string, intent: OrderIntent | null = null) => setOpen({ id, intent });
  const filtered = Boolean(q || status || source);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canAct && (
            <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-4 w-4" />
              {t("settings.open")}
            </Button>
          )}
          <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting || loading || orders.length === 0}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {ts("export")}
          </Button>
          {canAct && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {ts("newOrder")}
            </Button>
          )}
        </div>
      </header>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setQ(draft.trim())}
            placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} className="pl-8" maxLength={100} />
        </div>
        <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? "" : (v as OrderStatus))}>
          <SelectTrigger className="w-44 max-w-full" aria-label={t("filterStatus")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {ORDER_STATUSES.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={source || ALL} onValueChange={(v) => setSource(v === ALL ? "" : (v as OrderSource))}>
          <SelectTrigger className="w-40 max-w-full" aria-label={t("filterSource")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allSources")}</SelectItem>
            {ORDER_SOURCES.map((s) => <SelectItem key={s} value={s}>{tSource(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </form>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t("loading")} />
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <div className="flex size-[52px] items-center justify-center rounded-2xl bg-primary/10">
            <ShoppingBag className="h-6 w-6 text-primary" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">{filtered ? t("noMatches") : t("emptyTitle")}</h2>
          {!filtered && <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDesc")}</p>}
          {canAct && !filtered && (
            <Button className="mt-4" variant="outline" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {ts("newOrder")}</Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("colOrder")}</TableHead>
                <TableHead>{t("colCustomer")}</TableHead>
                <TableHead className="text-right">{t("colItems")}</TableHead>
                <TableHead className="text-right">{t("colTotal")}</TableHead>
                <TableHead>{ts("colPayment")}</TableHead>
                <TableHead>{ts("colFulfilment")}</TableHead>
                <TableHead><span className="sr-only">{ts("actions")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => {
                const ref = orderRef(order);
                const pay = paymentState(order);
                const ful = fulfilmentState(order.status);
                const step = canAct ? listStep(order) : null;
                return (
                  <TableRow key={order.id} tabIndex={0} className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                    aria-label={ts("openOrderLabel", { ref })}
                    onClick={() => openOrder(order.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openOrder(order.id); }}>
                    <TableCell className="whitespace-nowrap">
                      <span className="font-medium tabular-nums text-foreground">{ref}</span>
                      <div className="text-xs text-muted-foreground">
                        {format.dateTime(new Date(order.created_at), { dateStyle: "medium" })} · {tSource(order.source)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate">
                      {order.contact?.name || order.contact?.phone || t("unknownCustomer")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{order.item_count}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                      {money(order.total_minor ?? order.subtotal_minor, order.currency)}
                    </TableCell>
                    <TableCell><StateBadge tone={PAYMENT_TONE[pay]}>{ts(`pay.${pay}`)}</StateBadge></TableCell>
                    <TableCell><StateBadge tone={FULFILMENT_TONE[ful]}>{ts(`ful.${ful}`)}</StateBadge></TableCell>
                    <TableCell className="w-px text-right" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={ts("orderActions", { ref })}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => openOrder(order.id)}><Eye className="h-4 w-4" /> {ts("openOrder")}</DropdownMenuItem>
                          {step && <DropdownMenuItem onClick={() => openOrder(order.id, "step")}><Truck className="h-4 w-4" /> {ts(`next.${step}`)}</DropdownMenuItem>}
                          {canAct && canTakeLinkPayment(order) && (
                            <DropdownMenuItem onClick={() => openOrder(order.id, "link")}><Link2 className="h-4 w-4" /> {ts("sendPaymentLink")}</DropdownMenuItem>
                          )}
                          {canAdmin && canCancelUnpaid(order) && (
                            <DropdownMenuItem onClick={() => openOrder(order.id, "pay")}><Banknote className="h-4 w-4" /> {ts("recordPayment")}</DropdownMenuItem>
                          )}
                          {canAct && order.conversation_id && (
                            <DropdownMenuItem onClick={() => openOrder(order.id, "update")}><Send className="h-4 w-4" /> {ts("sendUpdate")}</DropdownMenuItem>
                          )}
                          {((canAdmin && order.status === "paid") || (canAct && canCancelUnpaid(order))) && <DropdownMenuSeparator />}
                          {canAdmin && order.status === "paid" && (
                            <DropdownMenuItem variant="destructive" onClick={() => openOrder(order.id, "refund")}><Undo2 className="h-4 w-4" /> {ts("refund")}</DropdownMenuItem>
                          )}
                          {canAct && canCancelUnpaid(order) && (
                            <DropdownMenuItem variant="destructive" onClick={() => openOrder(order.id, "cancel")}><X className="h-4 w-4" /> {ts("cancelOrder")}</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && orders.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {ts("shown", { count: orders.length })}{" "}
          <Link href="/commerce/payments" className="text-primary hover:underline">{ts("seePayments")}</Link>
        </p>
      )}

      {cursor && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}

      {settingsOpen && <OrderSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
      {canAct && (
        <NewOrderDialog open={creating} onOpenChange={setCreating} onCreated={(order) => { refresh(); openOrder(order.id); }} />
      )}
      <OrderDrawer orderId={open?.id ?? null} intent={open?.intent ?? null} onClose={() => setOpen(null)} onChanged={refresh} />
    </div>
  );
}
