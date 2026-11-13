"use client";

/**
 * Sales → Orders: an order in a right-side drawer. Separate Payment and
 * Fulfilment states, the customer card, item lines with the totals, quick
 * actions (send an update, the payment link, record a payment, cancel), the
 * fulfilment panel (courier shipment, feedback, cancel and refund) and the
 * history; the footer moves the order to its next step (shipping asks for a
 * tracking note). The full page (/commerce/orders/[id]) keeps returns and the
 * internal note. The server re-checks every rule; this only offers what the
 * order's state allows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Banknote, Check, ExternalLink, Link2, Loader2, MessageSquare, PackageCheck, Send, Truck, User, X } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { OfflinePaymentDialog } from "@/components/commerce/payments/offline-payment-dialog";
import { formatMoney } from "@/lib/commerce/money";
import { canRecordPayment } from "./order-detail";
import {
  deliverOrder, dispatchOrder, getOrder, getOrderTimeline, updateOrder, type ApiResult, type OrderDetail, type OrderTimeline,
} from "./order-api";
import { sendOrderPaymentLink, sendOrderUpdate } from "./order-actions";
import { OrderFulfilmentPanel } from "./order-fulfilment-panel";
import {
  canCancelUnpaid, canTakeLinkPayment, FULFILMENT_TONE, fulfilmentState, nextStep, orderRef, PAYMENT_TONE, paymentState, updateTextKey,
  type NextStep,
} from "./order-state";
import { OrderTimelinePanel } from "./order-timeline";
import { StateBadge } from "./state-badge";

export type OrderIntent = "step" | "update" | "link" | "pay" | "cancel" | "refund";

const TRACKING_MAX = 200;

export function OrderDrawer({ orderId, intent, onClose, onChanged }: {
  orderId: string | null;
  /** An action picked from the row menu, started once the order has loaded. */
  intent?: OrderIntent | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("Sales.orders");
  const tLife = useTranslations("Commerce.orders.lifecycle");
  const tOrders = useTranslations("Commerce.orders");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [timeline, setTimeline] = useState<OrderTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"ship" | "update" | "cancel" | null>(null);
  const [paying, setPaying] = useState(false);
  const [tracking, setTracking] = useState("");
  const [updateText, setUpdateText] = useState("");
  const handledIntent = useRef<string | null>(null);

  const load = useCallback(async (id: string) => {
    const [r, tl] = await Promise.all([getOrder(id), getOrderTimeline(id).catch(() => null)]);
    if (r.ok) {
      setOrder(r.value);
      setFailed(false);
    } else setFailed(true);
    setTimeline(tl);
    return r.ok ? r.value : null;
  }, []);

  useEffect(() => {
    if (!orderId) {
      setOrder(null);
      setTimeline(null);
      handledIntent.current = null;
      return;
    }
    setOrder(null);
    setFailed(false);
    void load(orderId);
  }, [orderId, load]);

  const reload = useCallback(async () => {
    if (!orderId) return;
    await load(orderId);
    onChanged();
  }, [orderId, load, onChanged]);

  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  const ref = order ? orderRef(order) : "";
  const step = order ? nextStep(order) : null;

  const errorText = (r: ApiResult<unknown>) => (r.ok ? "" : r.code === "conflict" ? tLife("conflict") : r.status === 403 ? tLife("forbidden")
    : r.code === "shipment_live" ? tLife("shipmentLive") : r.code === "order_refunded" ? tLife("refundedInFull")
      : r.code === "bad_transition" ? tLife("notAllowed") : t("stepFailed"));

  async function run(key: string, call: () => Promise<ApiResult<unknown>>, success: string) {
    setBusy(key);
    try {
      const r = await call();
      if (r.ok) toast.success(success);
      else toast.error(errorText(r));
      await reload();
      return r.ok;
    } catch {
      toast.error(t("stepFailed"));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function doStep(o: OrderDetail, kind: NextStep, trackingNote?: string) {
    if (kind === "ship") {
      const ok = await run("step", () => dispatchOrder(o.id, { from: o.status, tracking_note: trackingNote?.trim() || null }), tLife("dispatched"));
      if (ok) setDialog(null);
    } else if (kind === "deliver") await run("step", () => deliverOrder(o.id, { from: o.status }), tLife("delivered"));
    else await run("step", () => updateOrder(o.id, { status: "confirmed" }), t("stepDone"));
  }

  function startStep(o: OrderDetail) {
    const kind = nextStep(o);
    if (kind === "ship") {
      setTracking("");
      setDialog("ship");
    } else if (kind) void doStep(o, kind);
  }

  function openUpdate(o: OrderDetail) {
    setUpdateText(t(`updateText.${updateTextKey(o.status)}`, { ref: orderRef(o) }));
    setDialog("update");
  }

  async function sendLink(o: OrderDetail) {
    setBusy("link");
    try {
      const outcome = await sendOrderPaymentLink(o, t("linkDescription", { ref: orderRef(o) }), t("linkFailed"));
      if (outcome.kind === "sent") toast.success(outcome.reused ? t("linkExisting") : t("linkSent"));
      else if (outcome.kind === "copied") toast.success(t("linkNoChat"));
      else toast.error(t("linkNotSent", { reason: outcome.reason || t("linkFailed") }));
      await reload();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("linkFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function sendUpdate() {
    if (!order?.conversation_id || !updateText.trim()) return;
    setBusy("update");
    try {
      const reason = await sendOrderUpdate(order.conversation_id, updateText.trim());
      if (reason) toast.error(t("updateFailed", { reason }));
      else {
        toast.success(t("updateSent"));
        setDialog(null);
      }
    } catch {
      toast.error(t("updateFailed", { reason: t("stepFailed") }));
    } finally {
      setBusy(null);
    }
  }

  // A row-menu action starts once its order has loaded (once per open).
  useEffect(() => {
    if (!order || !intent || !orderId || handledIntent.current === `${orderId}:${intent}`) return;
    handledIntent.current = `${orderId}:${intent}`;
    if (intent === "step") startStep(order);
    else if (intent === "update") openUpdate(order);
    else if (intent === "link") void sendLink(order);
    else if (intent === "pay") {
      // The list row cannot see whether the order is priced; only open the dialog when the payment can be recorded.
      if (canAdmin && order.priced_at && canRecordPayment(order)) setPaying(true);
      else toast.error(tLife("notAllowed"));
    }
    else if (intent === "cancel") setDialog("cancel");
    else if (intent === "refund") setTimeout(() => document.getElementById("order-drawer-fulfilment")?.scrollIntoView({ block: "start" }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, intent, orderId]);

  const total = order ? order.total_minor ?? order.subtotal_minor : 0;
  const pay = order ? paymentState(order) : "pending";
  const ful = order ? fulfilmentState(order.status) : "new";
  const units = order ? order.items.reduce((n, i) => n + i.quantity, 0) : 0;
  const lines: Array<[string, number]> = order && order.priced_at ? [
    [tLife("subtotal"), order.subtotal_minor],
    ...(order.discount_minor ? [[order.coupon_code ? tLife("discountCode", { code: order.coupon_code }) : tLife("discount"), -order.discount_minor] as [string, number]] : []),
    [tLife("shipping"), order.shipping_minor],
    ...(order.cod_fee_minor ? [[tLife("codFee"), order.cod_fee_minor] as [string, number]] : []),
    [order.tax_inclusive ? tLife("taxIncluded") : tLife("tax"), order.tax_minor],
  ] : [];

  return (
    <>
      <Sheet open={orderId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[440px]">
          <SheetHeader className="border-b border-border/60 px-5 pt-4 pb-3 pr-12">
            <SheetDescription className="text-xs">
              {order ? t("placed", { date: format.dateTime(new Date(order.created_at), { dateStyle: "medium" }), count: units }) : " "}
            </SheetDescription>
            <SheetTitle className="text-lg tabular-nums">{order ? t("title", { ref }) : t("loadingTitle")}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {!order && !failed && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={tOrders("loading")} />}
            {failed && <p className="text-sm text-muted-foreground">{tOrders("loadError")}</p>}
            {order && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t("colPayment")}</span>
                  <StateBadge tone={PAYMENT_TONE[pay]}>{t(`pay.${pay}`)}</StateBadge>
                  <span className="ml-2 text-xs text-muted-foreground">{t("colFulfilment")}</span>
                  <StateBadge tone={FULFILMENT_TONE[ful]}>{t(`ful.${ful}`)}</StateBadge>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>
                    {(order.contact?.name || order.contact?.phone || "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{order.contact?.name || tOrders("unknownCustomer")}</p>
                    {order.contact?.phone && <p className="truncate text-xs text-muted-foreground">{order.contact.phone}</p>}
                  </div>
                  <div className="flex gap-1.5">
                    {order.contact && (
                      <Link href={`/contacts?contact=${encodeURIComponent(order.contact.id)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        <User className="h-3.5 w-3.5" /> {t("contact")}
                      </Link>
                    )}
                    {order.conversation_id && (
                      <Link href={`/inbox?c=${encodeURIComponent(order.conversation_id)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        <MessageSquare className="h-3.5 w-3.5" /> {t("chat")}
                      </Link>
                    )}
                  </div>
                </div>

                <section className="space-y-2">
                  <h3 className="text-[13px] font-semibold text-muted-foreground">{t("items")}</h3>
                  <div className="space-y-2 rounded-xl border border-border p-3 text-[13px]">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-start justify-between gap-3">
                        <span className="min-w-0 break-words">
                          {item.name || item.retailer_id || tOrders("detail.unknownProduct")}{" "}
                          <span className="text-muted-foreground">× {item.quantity}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">{money(item.line_total_minor ?? item.unit_price_minor * item.quantity, item.currency)}</span>
                      </div>
                    ))}
                    {lines.length > 0 && <hr className="border-border/60" />}
                    {lines.map(([label, minor]) => (
                      <div key={label} className="flex justify-between gap-3 text-muted-foreground">
                        <span>{label}</span>
                        <span className="tabular-nums">{minor < 0 ? `−${money(-minor, order.currency)}` : money(minor, order.currency)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between gap-3 font-semibold">
                      <span>{tOrders("detail.total")}</span>
                      <span className="tabular-nums">{money(total, order.currency)}</span>
                    </div>
                    {order.amount_paid_minor > 0 && (
                      <p className="text-xs text-muted-foreground">{tLife("paid", { amount: money(order.amount_paid_minor, order.currency) })}</p>
                    )}
                  </div>
                </section>

                {canAct && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busy !== null || !order.conversation_id} onClick={() => openUpdate(order)}
                      title={order.conversation_id ? undefined : t("noChat")}>
                      <Send className="h-3.5 w-3.5" /> {t("sendUpdate")}
                    </Button>
                    {canTakeLinkPayment(order) && (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sendLink(order)}>
                        {busy === "link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} {t("sendPaymentLink")}
                      </Button>
                    )}
                    {canAdmin && order.priced_at && canRecordPayment(order) && (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPaying(true)}>
                        <Banknote className="h-3.5 w-3.5" /> {t("recordPayment")}
                      </Button>
                    )}
                    {canCancelUnpaid(order) && (
                      <Button size="sm" variant="outline" className="text-destructive" disabled={busy !== null} onClick={() => setDialog("cancel")}>
                        <X className="h-3.5 w-3.5" /> {t("cancelOrder")}
                      </Button>
                    )}
                  </div>
                )}

                <div id="order-drawer-fulfilment" className="scroll-mt-4">
                  <OrderFulfilmentPanel order={order} canAct={canAct} canRefund={canAdmin} onChanged={reload} hideSteps />
                </div>
                <OrderTimelinePanel timeline={timeline} />
              </>
            )}
          </div>

          {order && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {step ? t("nextLabel", { step: t(`next.${step}`) }) : order.status === "fulfilled" ? t("complete") : t("noStep")}
              </span>
              <Link href={`/commerce/orders/${order.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <ExternalLink className="h-3.5 w-3.5" /> {t("openFullPage")}
              </Link>
              {step && canAct && (
                <Button size="sm" disabled={busy !== null} onClick={() => startStep(order)}>
                  {busy === "step" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : step === "ship" ? <Truck className="h-3.5 w-3.5" /> : step === "deliver" ? <PackageCheck className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  {t(`next.${step}`)}
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={dialog === "ship"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("shipTitle", { ref })}</DialogTitle>
            <DialogDescription>{t("trackingHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ship-tracking">{t("tracking")}</Label>
            <Input id="ship-tracking" maxLength={TRACKING_MAX} value={tracking} onChange={(e) => setTracking(e.target.value)}
              placeholder={tLife("trackingPlaceholder")} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{t("cancel")}</Button>
            <Button disabled={busy !== null || !order} onClick={() => order && void doStep(order, "ship", tracking)}>
              {busy === "step" && <Loader2 className="h-4 w-4 animate-spin" />} {t("next.ship")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "update"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("updateTitle")}</DialogTitle>
            <DialogDescription>{t("updateHelp")}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="order-update-text" className="sr-only">{t("updateTitle")}</Label>
          <Textarea id="order-update-text" rows={3} maxLength={1000} value={updateText} onChange={(e) => setUpdateText(e.target.value)} />
          <DialogFooter>
            {order?.conversation_id && (
              <Link href={`/inbox?c=${encodeURIComponent(order.conversation_id)}`} className={buttonVariants({ variant: "ghost" })}>
                <MessageSquare className="h-4 w-4" /> {t("chat")}
              </Link>
            )}
            <Button disabled={busy !== null || !updateText.trim() || !order?.conversation_id} onClick={() => void sendUpdate()}>
              {busy === "update" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("updateSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cancel"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("cancelTitle", { ref })}</DialogTitle>
            <DialogDescription>{t("cancelBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{t("keep")}</Button>
            <Button variant="destructive" disabled={busy !== null || !order} onClick={async () => {
              if (!order) return;
              const ok = await run("cancel", () => updateOrder(order.id, { status: "cancelled" }), t("cancelled"));
              if (ok) setDialog(null);
            }}>
              {busy === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />} {t("cancelOrder")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {order && (
        <OfflinePaymentDialog orderId={order.id} currency={order.currency} dueMinor={total - order.amount_paid_minor}
          open={paying} onOpenChange={setPaying} onRecorded={() => void reload()} />
      )}
    </>
  );
}
