"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Loader2, MessageSquare } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/commerce/money";
import { nextStatuses, ORDER_LIMITS, type OrderStatus } from "@/lib/commerce/order-format";
import {
  getOrder, getOrderTimeline, listOrderReturns, updateOrder, type OrderDetail, type OrderReturn, type OrderTimeline,
} from "./order-api";
import { OrderFulfilmentPanel } from "./order-fulfilment-panel";
import { OrderReturnsPanel } from "./order-returns-panel";
import { OrderStatusBadge } from "./order-status-badge";
import { OrderTimelinePanel } from "./order-timeline";

/** Dispatch and delivery have their own actions; a paid order is cancelled only with Cancel and refund. */
export function selectableStatuses(order: Pick<OrderDetail, "status" | "priced_at">): OrderStatus[] {
  return nextStatuses(order.status, { priced: order.priced_at !== null })
    .filter((s) => s !== "dispatched" && s !== "fulfilled" && !(order.status === "paid" && s === "cancelled"));
}

const ADDRESS_LINES = ["name", "line1", "line2", "city", "state", "postal_code", "country"] as const;

export function OrderDetailView({ id }: { id: string }) {
  const t = useTranslations("Commerce.orders");
  const tStatus = useTranslations("Commerce.orders.statuses");
  const tSource = useTranslations("Commerce.orders.sources");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");
  const tLife = useTranslations("Commerce.orders.lifecycle");

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"status" | "note" | null>(null);
  const [timeline, setTimeline] = useState<OrderTimeline | null>(null);
  const [returns, setReturns] = useState<OrderReturn[]>([]);

  const loadExtras = useCallback(async () => {
    const [tl, rs] = await Promise.all([getOrderTimeline(id).catch(() => null), listOrderReturns(id).catch(() => [])]);
    setTimeline(tl);
    setReturns(rs);
  }, [id]);

  const reload = useCallback(async () => {
    const fresh = await getOrder(id);
    if (fresh.ok) {
      setOrder(fresh.value);
      setNote(fresh.value.note ?? "");
    }
    await loadExtras();
  }, [id, loadExtras]);

  useEffect(() => {
    let cancelled = false;
    getOrder(id)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setOrder(r.value);
          setNote(r.value.note ?? "");
          setState("ready");
        } else setState(r.status === 404 ? "missing" : "error");
      })
      .catch(() => !cancelled && setState("error"));
    void loadExtras();
    return () => {
      cancelled = true;
    };
  }, [id, loadExtras]);

  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  async function save(patch: { status?: OrderStatus; note?: string | null }, kind: "status" | "note") {
    setBusy(kind);
    try {
      const r = await updateOrder(id, patch);
      if (!r.ok) {
        toast.error(r.code === "conflict" ? t("detail.conflict") : r.code === "bad_transition" ? t("detail.badTransition") : t("detail.saveError"));
        if (r.code === "conflict") {
          const fresh = await getOrder(id);
          if (fresh.ok) setOrder(fresh.value);
        }
        return;
      }
      setOrder(r.value);
      setNote(r.value.note ?? "");
      toast.success(kind === "status" ? t("detail.statusSaved") : t("detail.noteSaved"));
      if (kind === "status") void loadExtras();
    } catch {
      toast.error(t("detail.saveError"));
    } finally {
      setBusy(null);
    }
  }

  if (state === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t("loading")} />
      </div>
    );
  }
  if (state !== "ready" || !order) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Link href="/commerce/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {t("detail.back")}
        </Link>
        <p className="text-sm text-muted-foreground">{state === "missing" ? t("detail.notFound") : t("loadError")}</p>
      </div>
    );
  }

  const next = selectableStatuses(order);
  const total = order.total_minor ?? order.subtotal_minor;
  const priced = order.priced_at !== null;
  const address = order.shipping_address;
  const breakdown: Array<[string, number]> = priced ? [
    [tLife("subtotal"), order.subtotal_minor],
    ...(order.discount_minor ? [[order.coupon_code ? tLife("discountCode", { code: order.coupon_code }) : tLife("discount"), -order.discount_minor] as [string, number]] : []),
    ...(order.shipping_minor ? [[tLife("shipping"), order.shipping_minor] as [string, number]] : []),
    [order.tax_inclusive ? tLife("taxIncluded") : tLife("tax"), order.tax_minor],
  ] : [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <Link href="/commerce/orders" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t("detail.back")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t("detail.title", { ref: order.external_id ? `#${order.external_id}` : order.id.slice(0, 8).toUpperCase() })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tSource(order.source)} · {format.dateTime(new Date(order.created_at), { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        <OrderStatusBadge status={order.status} />
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("detail.colProduct")}</TableHead>
                  <TableHead className="text-right">{t("detail.colQuantity")}</TableHead>
                  <TableHead className="text-right">{t("detail.colPrice")}</TableHead>
                  <TableHead className="text-right">{t("detail.colAmount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{item.name || item.retailer_id || t("detail.unknownProduct")}</div>
                      {item.name && item.retailer_id && <div className="font-mono text-xs text-muted-foreground">{item.retailer_id}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(item.unit_price_minor, item.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(item.line_total_minor ?? item.unit_price_minor * item.quantity, item.currency)}</TableCell>
                  </TableRow>
                ))}
                {breakdown.map(([label, minor]) => (
                  <TableRow key={label}>
                    <TableCell colSpan={3} className="text-right text-muted-foreground">{label}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {minor < 0 ? `−${money(-minor, order.currency)}` : money(minor, order.currency)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={3} className="text-right font-medium">{t("detail.total")}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{money(total, order.currency)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {(order.amount_paid_minor > 0 || order.amount_refunded_minor > 0) && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-border bg-card p-4 text-sm">
              <span>{tLife("paid", { amount: money(order.amount_paid_minor, order.currency) })}</span>
              {order.amount_refunded_minor > 0 && (
                <span>{tLife("refunded", { amount: money(order.amount_refunded_minor, order.currency) })}</span>
              )}
            </div>
          )}
          {order.customer_note && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-medium text-foreground">{t("detail.customerNote")}</h2>
              <p className="mt-1 text-sm whitespace-pre-wrap break-words text-muted-foreground">{order.customer_note}</p>
            </div>
          )}
          <OrderTimelinePanel timeline={timeline} />
        </section>

        <aside className="space-y-4">
          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-foreground">{t("detail.customer")}</h2>
            <p className="text-sm">{order.contact?.name || t("unknownCustomer")}</p>
            {order.contact?.phone && <p className="text-xs text-muted-foreground">{order.contact.phone}</p>}
            {address && (
              <address className="text-xs not-italic text-muted-foreground">
                {ADDRESS_LINES.map((k) => (typeof address[k] === "string" && address[k] ? <div key={k}>{String(address[k])}</div> : null))}
              </address>
            )}
            {order.conversation_id && (
              <Link href={`/inbox?c=${encodeURIComponent(order.conversation_id)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <MessageSquare className="h-4 w-4" /> {t("detail.openConversation")}
              </Link>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            <Label htmlFor="order-status">{t("detail.changeStatus")}</Label>
            {next.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("detail.finalStatus")}</p>
            ) : (
              <Select value="" disabled={!canAct || busy !== null} onValueChange={(v) => save({ status: v as OrderStatus }, "status")}>
                <SelectTrigger id="order-status"><SelectValue placeholder={t("detail.moveTo")} /></SelectTrigger>
                <SelectContent>
                  {next.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>

          <OrderFulfilmentPanel order={order} canAct={canAct} canRefund={canAdmin} onChanged={reload} />
          <OrderReturnsPanel order={order} returns={returns} canAct={canAct} canAdmin={canAdmin} onChanged={reload} />

          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            <Label htmlFor="order-note">{t("detail.note")}</Label>
            <Textarea id="order-note" rows={4} maxLength={ORDER_LIMITS.noteMaxLength} value={note} disabled={!canAct}
              placeholder={t("detail.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("detail.noteHelp")}</p>
            {canAct && (
              <Button size="sm" onClick={() => save({ note: note.trim() || null }, "note")}
                disabled={busy !== null || (note.trim() || null) === (order.note ?? null)}>
                {busy === "note" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("detail.saveNote")}
              </Button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
