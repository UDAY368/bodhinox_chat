"use client";

/**
 * One order screen, shown as a full page (/commerce/orders/[id]) or as a sheet over the orders list.
 * Top to bottom: the reference with its status, ONE next-step button (from lib/commerce/order-state)
 * and the other actions in a "more" menu; then Payment (totals, payments and refunds), Shipment and
 * Customer; then closed sections for items and edits, returns, tax invoice, tags, history and notes.
 * Money actions (cancel, cancel and refund, record payment, refund) confirm in a dialog that shows
 * the amount and the order. The server re-checks every rule; this only offers what the state allows.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft, Banknote, Check, ExternalLink, Link2, Loader2, MessageSquare, MoreHorizontal, PackageCheck, Send, Truck, Undo2, User, X,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { OfflinePaymentDialog } from "@/components/commerce/payments/offline-payment-dialog";
import { OrderPaymentsPanel } from "@/components/commerce/payments/customer-payments-table";
import { formatMoney } from "@/lib/commerce/money";
import { ORDER_LIMITS, type OrderStatus } from "@/lib/commerce/order-format";
import {
  allowedActions, amountDue, amountRefundable, canStartReturn, COD_CONFIRM_TONE, isUnpaidCodOrder, nextStep, nextStepAction,
  orderRef, PAYMENT_TONE, paymentState, selectableStatuses, STATE_LABELS, STATUS_TONE, updateTextKey, type OrderAction,
} from "@/lib/commerce/order-state";
import { formatShipDate } from "@/lib/commerce/selling-rules";
import { cn } from "@/lib/utils";
import {
  cancelAndRefundOrder, deliverOrder, discountRows, dispatchOrder, getOrder, getOrderTimeline, listOrderReturns, tenderRows, updateOrder,
  type ApiResult, type OrderDetail, type OrderReturn, type OrderTimeline,
} from "./order-api";
import { sendOrderPaymentLink, sendOrderUpdate } from "./order-actions";
import { OrderEditPanel } from "./order-edit-panel";
import { OrderFulfilmentPanel } from "./order-fulfilment-panel";
import { OrderReturnsPanel } from "./order-returns-panel";
import { OrderRiskBadge } from "./order-risk-badge";
import { OrderTags } from "./order-tags";
import { OrderTaxInvoicePanel } from "./order-tax-invoice-panel";
import { OrderTimelinePanel } from "./order-timeline";
import { StateBadge } from "./state-badge";

/** An action picked from the list's row menu, started once the order has loaded. */
export type OrderIntent = "step" | "update" | "link" | "pay" | "cancel" | "refund";

const TRACKING_MAX = 200;
const ADDRESS_LINES = ["name", "line1", "line2", "city", "state", "postal_code", "country"] as const;
/** The panels inside a closed section bring their own card and heading: the section supplies both. */
const BARE = "[&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0 [&>div>h2:first-child]:sr-only [&>div>div:first-child>h2]:sr-only";

const STEP_ICON: Partial<Record<OrderAction, ReactNode>> = {
  confirm: <Check className="h-4 w-4" />,
  send_payment_link: <Link2 className="h-4 w-4" />,
  record_payment: <Banknote className="h-4 w-4" />,
  ship: <Truck className="h-4 w-4" />,
  deliver: <PackageCheck className="h-4 w-4" />,
};

type DialogKind = "ship" | "update" | "cancel" | "refund" | null;

export function OrderView({ orderId, onChanged, variant = "page", intent = null }: {
  orderId: string;
  /** Called after the order changed (the list refreshes its row). */
  onChanged?: () => void;
  variant?: "page" | "sheet";
  intent?: OrderIntent | null;
}) {
  const t = useTranslations("Commerce.orders.view");
  const tOrders = useTranslations("Commerce.orders");
  const tSales = useTranslations("Sales.orders");
  const tLife = useTranslations("Commerce.orders.lifecycle");
  const tStatus = useTranslations(STATE_LABELS.status);
  const tPay = useTranslations(STATE_LABELS.payment);
  const tSource = useTranslations("Commerce.orders.sources");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [timeline, setTimeline] = useState<OrderTimeline | null>(null);
  const [returns, setReturns] = useState<OrderReturn[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [paying, setPaying] = useState(false);
  const [tracking, setTracking] = useState("");
  const [updateText, setUpdateText] = useState("");
  const [refundNote, setRefundNote] = useState("");
  // Set after a 409 offline_payment: part of the money must be returned outside Razorpay first.
  const [outsideNeeded, setOutsideNeeded] = useState(false);
  const [outsideConfirmed, setOutsideConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const handledIntent = useRef<string | null>(null);
  const paymentRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const [r, tl, rs] = await Promise.all([
      getOrder(orderId), getOrderTimeline(orderId).catch(() => null), listOrderReturns(orderId).catch(() => [] as OrderReturn[]),
    ]);
    if (r.ok) {
      setOrder(r.value);
      setNote(r.value.note ?? "");
      setState("ready");
    } else setState(r.status === 404 ? "missing" : "error");
    setTimeline(tl);
    setReturns(rs);
  }, [orderId]);

  useEffect(() => {
    // Mounted per order (callers key it by id), so the first load starts from the loading state.
    let cancelled = false;
    Promise.all([
      getOrder(orderId), getOrderTimeline(orderId).catch(() => null), listOrderReturns(orderId).catch(() => [] as OrderReturn[]),
    ])
      .then(([r, tl, rs]) => {
        if (cancelled) return;
        if (r.ok) {
          setOrder(r.value);
          setNote(r.value.note ?? "");
          setState("ready");
        } else setState(r.status === 404 ? "missing" : "error");
        setTimeline(tl);
        setReturns(rs);
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const reload = useCallback(async () => {
    try {
      await load();
    } catch {
      toast.error(tOrders("loadError"));
    }
    onChanged?.();
  }, [load, onChanged, tOrders]);

  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  const errorText = (r: ApiResult<unknown>) => (r.ok ? "" : r.code === "conflict" ? tLife("conflict") : r.status === 403 ? tLife("forbidden")
    : r.code === "shipment_live" ? tLife("shipmentLive") : r.code === "order_refunded" ? tLife("refundedInFull")
      : r.code === "bad_transition" ? tLife("notAllowed") : tSales("stepFailed"));

  async function run<T>(key: string, call: () => Promise<ApiResult<T>>, success: string | ((value: T) => string)): Promise<ApiResult<T> | null> {
    setBusy(key);
    try {
      const r = await call();
      if (r.ok) toast.success(typeof success === "function" ? success(r.value) : success);
      else if (r.code === "offline_payment") {
        setOutsideNeeded(true);
        toast.error(tLife("cancelRefundOutsideNeeded"));
      } else toast.error(errorText(r));
      await reload();
      return r;
    } catch {
      toast.error(tSales("stepFailed"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function sendLink(o: OrderDetail) {
    setBusy("send_payment_link");
    try {
      const outcome = await sendOrderPaymentLink(o, tSales("linkDescription", { ref: orderRef(o) }), tSales("linkFailed"));
      if (outcome.kind === "sent") toast.success(outcome.reused ? tSales("linkExisting") : tSales("linkSent"));
      else if (outcome.kind === "copied") toast.success(tSales("linkNoChat"));
      else toast.error(tSales("linkNotSent", { reason: outcome.reason || tSales("linkFailed") }));
      await reload();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : tSales("linkFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function sendUpdate(o: OrderDetail) {
    if (!o.conversation_id || !updateText.trim()) return;
    setBusy("send_update");
    try {
      const reason = await sendOrderUpdate(o.conversation_id, updateText.trim());
      if (reason) toast.error(tSales("updateFailed", { reason }));
      else {
        toast.success(tSales("updateSent"));
        setDialog(null);
      }
    } catch {
      toast.error(tSales("updateFailed", { reason: tSales("stepFailed") }));
    } finally {
      setBusy(null);
    }
  }

  async function saveNote(o: OrderDetail) {
    const r = await run("note", () => updateOrder(o.id, { note: note.trim() || null }), tOrders("detail.noteSaved"));
    if (r && !r.ok) setNote(o.note ?? "");
  }

  function start(action: OrderAction, o: OrderDetail) {
    switch (action) {
      case "confirm": void run("confirm", () => updateOrder(o.id, { status: "confirmed" }), tSales("stepDone")); break;
      case "send_payment_link": void sendLink(o); break;
      case "record_payment": setPaying(true); break;
      case "ship": setTracking(""); setDialog("ship"); break;
      case "deliver": void run("deliver", () => deliverOrder(o.id, { from: o.status }), tLife("delivered")); break;
      case "send_update": setUpdateText(tSales(`updateText.${updateTextKey(o.status)}`, { ref: orderRef(o) })); setDialog("update"); break;
      case "cancel": setDialog("cancel"); break;
      case "cancel_and_refund": setRefundNote(""); setOutsideNeeded(false); setOutsideConfirmed(false); setDialog("refund"); break;
      case "change_status": break;
    }
  }

  // A row-menu action starts once its order has loaded (once per opening).
  useEffect(() => {
    if (!order || !intent || handledIntent.current === `${order.id}:${intent}`) return;
    handledIntent.current = `${order.id}:${intent}`;
    const allowed = allowedActions(order, { canAct, canAdmin });
    const want: OrderAction | null = intent === "step" ? nextStepAction(nextStep(order), allowed)
      : intent === "update" ? "send_update" : intent === "link" ? "send_payment_link" : intent === "pay" ? "record_payment"
        : intent === "cancel" ? "cancel" : allowed.includes("cancel_and_refund") ? "cancel_and_refund" : null;
    if (intent === "refund" && !want) paymentRef.current?.scrollIntoView({ block: "start" });
    else if (want && allowed.includes(want)) start(want, order);
    else toast.error(tLife("notAllowed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, intent]);

  const back = variant === "page" && (
    <Link href="/commerce/orders" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground sm:min-h-0">
      <ArrowLeft className="h-4 w-4" /> {tOrders("detail.back")}
    </Link>
  );

  if (state === "loading" || (state === "ready" && !order)) return (
      <>
        {variant === "sheet" && <SheetTitle className="sr-only">{tSales("loadingTitle")}</SheetTitle>}
        <OrderViewSkeleton label={tOrders("loading")} />
      </>
    );
  if (state !== "ready" || !order) {
    return (
      <div className="space-y-4">
        {back}
        {variant === "sheet" && <SheetTitle className="sr-only">{tSales("loadingTitle")}</SheetTitle>}
        <div className="flex flex-col items-start gap-3 py-6 text-sm text-muted-foreground">
          <p>{state === "missing" ? tOrders("detail.notFound") : t("loadFailed")}</p>
          {state === "error" && (
            <Button variant="outline" onClick={() => { setState("loading"); void load().catch(() => setState("error")); }}>{t("retry")}</Button>
          )}
        </div>
      </div>
    );
  }

  const ref = orderRef(order);
  const total = order.total_minor ?? order.subtotal_minor;
  const due = amountDue(order);
  const refundable = amountRefundable(order);
  const allowed = allowedActions(order, { canAct, canAdmin });
  const step = nextStep(order);
  const primary = nextStepAction(step, allowed);
  const moves = selectableStatuses(order).filter((s) => s !== "confirmed");
  const pay = paymentState(order);
  const address = order.shipping_address;
  const unpaidCod = isUnpaidCodOrder(order);
  const units = order.items.reduce((n, i) => n + i.quantity, 0);
  const meta = `${tSource(order.source)} · ${tSales("placed", { date: format.dateTime(new Date(order.created_at), { dateStyle: "medium", timeStyle: "short" }), count: units })}`;
  const breakdown: Array<[string, number]> = order.priced_at ? [
    [tLife("subtotal"), order.subtotal_minor],
    ...discountRows(order, tLife),
    ...(order.shipping_minor ? [[tLife("shipping"), order.shipping_minor] as [string, number]] : []),
    ...(order.cod_fee_minor ? [[tLife("codFee"), order.cod_fee_minor] as [string, number]] : []),
    [order.tax_inclusive ? tLife("taxIncluded") : tLife("tax"), order.tax_minor],
  ] : [];

  const actionLabel = (a: OrderAction) => a === "confirm" ? tSales("next.confirm") : a === "ship" ? tSales("next.ship")
    : a === "deliver" ? tSales("next.deliver") : a === "send_payment_link" ? tSales("sendPaymentLink") : a === "record_payment" ? tSales("recordPayment")
      : a === "send_update" ? tSales("sendUpdate") : a === "cancel" ? tSales("cancelOrder") : a === "cancel_and_refund" ? tLife("cancelRefund") : "";
  const MENU_ORDER: OrderAction[] = ["confirm", "send_payment_link", "record_payment", "ship", "deliver", "send_update"];
  const menu = MENU_ORDER.filter((a) => allowed.includes(a) && a !== primary);
  const risky = (["cancel", "cancel_and_refund"] as const).filter((a) => allowed.includes(a));
  const showRefundLink = canAdmin && refundable > 0 && !allowed.includes("cancel_and_refund");

  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      {primary && (
        <Button className="min-h-11 sm:min-h-9" disabled={busy !== null} onClick={() => start(primary, order)}>
          {busy === primary ? <Loader2 className="h-4 w-4 animate-spin" /> : STEP_ICON[primary]}
          {actionLabel(primary)}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t("more")} disabled={busy !== null}
          className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-11 sm:size-9")}>
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {menu.map((a) => (
            <DropdownMenuItem key={a} onClick={() => start(a, order)}>{STEP_ICON[a] ?? <Send className="h-4 w-4" />} {actionLabel(a)}</DropdownMenuItem>
          ))}
          {canAct && moves.map((s: OrderStatus) => (
            <DropdownMenuItem key={s} onClick={() => void run(`status:${s}`, () => updateOrder(order.id, { status: s }), tOrders("detail.statusSaved"))}>
              <Check className="h-4 w-4" /> {t("moveTo", { status: tStatus(s) })}
            </DropdownMenuItem>
          ))}
          {order.conversation_id && (
            <DropdownMenuItem onClick={() => router.push(`/inbox?c=${encodeURIComponent(order.conversation_id!)}`)}>
              <MessageSquare className="h-4 w-4" /> {tOrders("detail.openConversation")}
            </DropdownMenuItem>
          )}
          {variant === "sheet" && (
            <DropdownMenuItem onClick={() => router.push(`/commerce/orders/${order.id}`)}>
              <ExternalLink className="h-4 w-4" /> {tSales("openFullPage")}
            </DropdownMenuItem>
          )}
          {(risky.length > 0 || showRefundLink) && <DropdownMenuSeparator />}
          {showRefundLink && (
            <DropdownMenuItem onClick={() => paymentRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              <Undo2 className="h-4 w-4" /> {tSales("refund")}
            </DropdownMenuItem>
          )}
          {risky.map((a) => (
            <DropdownMenuItem key={a} variant="destructive" onClick={() => start(a, order)}>
              {a === "cancel" ? <X className="h-4 w-4" /> : <Undo2 className="h-4 w-4" />} {actionLabel(a)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const badges = (
    <div className="flex flex-wrap items-center gap-1.5">
      <StateBadge tone={STATUS_TONE[order.status]}>{tStatus(order.status)}</StateBadge>
      <StateBadge tone={PAYMENT_TONE[pay]}>{tPay(pay)}</StateBadge>
      {order.cod_confirmation && (
        <StateBadge tone={COD_CONFIRM_TONE[order.cod_confirmation]}>{tOrders(`cod.confirmation.${order.cod_confirmation}`)}</StateBadge>
      )}
      {(order.delivery_method === "pickup" || order.delivery_method === "local") && (
        <StateBadge tone="neutral">{tOrders(`delivery.${order.delivery_method}`)}</StateBadge>
      )}
      {order.preorder_ship_date && <StateBadge tone="neutral">{tOrders("preorder.badge", { date: formatShipDate(order.preorder_ship_date, locale) })}</StateBadge>}
      {order.risk && <OrderRiskBadge risk={order.risk} showReasons />}
    </div>
  );

  const stepLine = step && !primary ? tSales("nextLabel", { step: step === "collect_payment" ? t("waitingForPayment") : tSales(`next.${step}`) })
    : order.status === "fulfilled" ? tSales("complete") : null;

  return (
    <div className={cn("space-y-6", variant === "sheet" && "px-5 pb-6")}>
      {back}
      {variant === "sheet" ? (
        <SheetHeader className="-mx-5 border-b border-border/60 px-5 pt-4 pb-4 pr-12">
          <SheetDescription className="text-xs">{meta}</SheetDescription>
          <SheetTitle className="text-xl font-bold tabular-nums">{tSales("title", { ref })}</SheetTitle>
          {badges}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="min-w-0 text-xs text-muted-foreground">{stepLine}</span>
            {actions}
          </div>
        </SheetHeader>
      ) : (
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-[28px] font-bold tracking-tight text-foreground tabular-nums">{tSales("title", { ref })}</h1>
            {badges}
            <p className="text-sm text-muted-foreground">{meta}</p>
            {stepLine && <p className="text-sm text-muted-foreground">{stepLine}</p>}
          </div>
          {actions}
        </header>
      )}

      <Section title={t("payment")} sectionRef={paymentRef}>
        <dl className="space-y-1.5 text-sm">
          <Row label={tOrders("detail.total")} value={money(total, order.currency)} strong />
          {order.amount_paid_minor > 0 && <Row label={t("paid")} value={money(order.amount_paid_minor, order.currency)} />}
          {order.amount_refunded_minor > 0 && <Row label={t("refunded")} value={money(order.amount_refunded_minor, order.currency)} />}
          {due > 0 && order.status !== "cancelled" && order.status !== "expired" && <Row label={t("due")} value={money(due, order.currency)} />}
        </dl>
        {unpaidCod && order.status !== "cancelled" && order.status !== "expired" && (
          <p className="text-sm text-muted-foreground">{tOrders("cod.collect", { amount: money(due, order.currency) })}</p>
        )}
        <OrderPaymentsPanel orderId={order.id} dispatched={order.status === "dispatched" || order.status === "fulfilled"} />
      </Section>

      <Section title={t("shipment")}>
        <OrderFulfilmentPanel order={order} canAct={canAct} onChanged={reload} />
      </Section>

      <Section title={t("customer")}>
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>
            {(order.contact?.name || order.contact?.phone || "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{order.contact?.name || tOrders("unknownCustomer")}</p>
            {order.contact?.phone && <p className="truncate text-muted-foreground">{order.contact.phone}</p>}
            {address && (
              <address className="mt-1 text-xs not-italic text-muted-foreground">
                {ADDRESS_LINES.map((k) => (typeof address[k] === "string" && address[k] ? <div key={k}>{String(address[k])}</div> : null))}
              </address>
            )}
          </div>
          <div className="flex gap-2">
            {order.contact && (
              <Link href={`/contacts?contact=${encodeURIComponent(order.contact.id)}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 sm:min-h-8")}>
                <User className="h-3.5 w-3.5" /> {tSales("contact")}
              </Link>
            )}
            {order.conversation_id && (
              <Link href={`/inbox?c=${encodeURIComponent(order.conversation_id)}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 sm:min-h-8")}>
                <MessageSquare className="h-3.5 w-3.5" /> {tSales("chat")}
              </Link>
            )}
          </div>
        </div>
      </Section>

      <Accordion multiple defaultValue={["items"]} className="border-t border-border/60">
        <AccordionItem value="items" className="border-b border-border/60">
          <AccordionTrigger className="min-h-11 items-center">{t("items")}</AccordionTrigger>
          <AccordionContent className="space-y-4">
            <div className="space-y-2 text-sm">
              {order.items.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">
                    {item.name || item.retailer_id || tOrders("detail.unknownProduct")}{" "}
                    <span className="text-muted-foreground">× {item.quantity}</span>
                    {item.is_gift && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{tLife("freeGift")}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(item.line_total_minor ?? item.unit_price_minor * item.quantity, item.currency)}</span>
                </div>
              ))}
              {breakdown.length > 0 && <hr className="border-border/60" />}
              {breakdown.map(([label, minor]) => (
                <Row key={label} label={label} value={minor < 0 ? `−${money(-minor, order.currency)}` : money(minor, order.currency)} muted />
              ))}
              <Row label={tOrders("detail.total")} value={money(total, order.currency)} strong />
              {tenderRows(order, tLife).map(([label, minor]) => (
                <Row key={label} label={label} value={`−${money(-minor, order.currency)}`} muted />
              ))}
            </div>
            {order.priced_at && (
              <div className={BARE}>
                <OrderEditPanel key={`${order.id}:${order.updated_at}`} orderId={order.id} canEdit={canAct} onChanged={() => void reload()} />
              </div>
            )}
          </AccordionContent>
        </AccordionItem>

        {(canStartReturn(order.status) || returns.length > 0) && (
          <AccordionItem value="returns" className="border-b border-border/60">
            <AccordionTrigger className="min-h-11 items-center">{t("returns")}</AccordionTrigger>
            <AccordionContent className={BARE}>
              <OrderReturnsPanel order={order} returns={returns} canAct={canAct} canAdmin={canAdmin} onChanged={reload} />
            </AccordionContent>
          </AccordionItem>
        )}

        {order.priced_at && (
          <AccordionItem value="tax" className="border-b border-border/60">
            <AccordionTrigger className="min-h-11 items-center">{t("taxInvoice")}</AccordionTrigger>
            <AccordionContent className={BARE}>
              <OrderTaxInvoicePanel order={order} canAct={canAct} onChanged={reload} />
            </AccordionContent>
          </AccordionItem>
        )}

        <AccordionItem value="tags" className="border-b border-border/60">
          <AccordionTrigger className="min-h-11 items-center">{t("tags")}</AccordionTrigger>
          <AccordionContent className={BARE}>
            <OrderTags orderId={order.id} tags={order.tags ?? []} canEdit={canAct} onSaved={(tags) => setOrder((o) => (o ? { ...o, tags } : o))} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="history" className="border-b border-border/60">
          <AccordionTrigger className="min-h-11 items-center">{t("history")}</AccordionTrigger>
          <AccordionContent className={cn(BARE, "space-y-4")}>
            <OrderTimelinePanel timeline={timeline} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="notes" className="border-b border-border/60">
          <AccordionTrigger className="min-h-11 items-center">{t("notes")}</AccordionTrigger>
          <AccordionContent className="space-y-4">
            {order.customer_note && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground">{tOrders("detail.customerNote")}</h3>
                <p className="mt-1 text-sm whitespace-pre-wrap break-words">{order.customer_note}</p>
              </div>
            )}
            {order.extras && (
              <dl className="space-y-1 text-sm">
                <h3 className="text-xs font-medium text-muted-foreground">{tOrders("detail.buyerExtras.title")}</h3>
                {order.extras.delivery_date && (
                  <div><dt className="text-xs text-muted-foreground">{tOrders("detail.buyerExtras.deliveryDate")}</dt>
                    <dd>{[order.extras.delivery_date, order.extras.delivery_slot].filter(Boolean).join(", ")}</dd></div>
                )}
                {order.extras.note && <div><dt className="text-xs text-muted-foreground">{tOrders("detail.buyerExtras.note")}</dt><dd className="whitespace-pre-wrap break-words">{order.extras.note}</dd></div>}
                {order.extras.gift_message && <div><dt className="text-xs text-muted-foreground">{tOrders("detail.buyerExtras.giftMessage")}</dt><dd className="whitespace-pre-wrap break-words">{order.extras.gift_message}</dd></div>}
                {order.extras.custom.map((c, i) => <div key={i}><dt className="text-xs text-muted-foreground">{c.label}</dt><dd className="break-words">{c.value}</dd></div>)}
              </dl>
            )}
            <div className="space-y-2">
              <Label htmlFor={`order-note-${order.id}`}>{tOrders("detail.note")}</Label>
              <Textarea id={`order-note-${order.id}`} rows={3} maxLength={ORDER_LIMITS.noteMaxLength} value={note} disabled={!canAct}
                placeholder={tOrders("detail.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
              <p className="text-xs text-muted-foreground">{tOrders("detail.noteHelp")}</p>
              {canAct && (
                <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => void saveNote(order)}
                  disabled={busy !== null || (note.trim() || null) === (order.note ?? null)}>
                  {busy === "note" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {tOrders("detail.saveNote")}
                </Button>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <Dialog open={dialog === "ship"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tSales("shipTitle", { ref })}</DialogTitle>
            <DialogDescription>{tSales("trackingHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ship-tracking">{tSales("tracking")}</Label>
            <Input id="ship-tracking" maxLength={TRACKING_MAX} value={tracking} onChange={(e) => setTracking(e.target.value)}
              placeholder={tLife("trackingPlaceholder")} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{tSales("cancel")}</Button>
            <Button disabled={busy !== null} onClick={async () => {
              const r = await run("ship", () => dispatchOrder(order.id, { from: order.status, tracking_note: tracking.trim() || null }), tLife("dispatched"));
              if (r?.ok) setDialog(null);
            }}>
              {busy === "ship" && <Loader2 className="h-4 w-4 animate-spin" />} {tSales("next.ship")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "update"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tSales("updateTitle")}</DialogTitle>
            <DialogDescription>{tSales("updateHelp")}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="order-update-text" className="sr-only">{tSales("updateTitle")}</Label>
          <Textarea id="order-update-text" rows={3} maxLength={1000} value={updateText} onChange={(e) => setUpdateText(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{tSales("cancel")}</Button>
            <Button disabled={busy !== null || !updateText.trim() || !order.conversation_id} onClick={() => void sendUpdate(order)}>
              {busy === "send_update" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {tSales("updateSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cancel"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tSales("cancelTitle", { ref })}</DialogTitle>
            <DialogDescription>{tSales("cancelBody")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{t("cancelAmount", { amount: money(total, order.currency) })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{tSales("keep")}</Button>
            <Button variant="destructive" disabled={busy !== null} onClick={async () => {
              const r = await run("cancel", () => updateOrder(order.id, { status: "cancelled" }), tSales("cancelled"));
              if (r?.ok) setDialog(null);
            }}>
              {busy === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />} {tSales("cancelOrder")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "refund"} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("refundTitle", { ref })}</DialogTitle>
            <DialogDescription>{t("refundAmount", { amount: money(refundable, order.currency) })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="refund-note">{tLife("refundNotePlaceholder")}</Label>
            <Textarea id="refund-note" rows={2} maxLength={500} value={refundNote} onChange={(e) => setRefundNote(e.target.value)} />
          </div>
          {outsideNeeded && (
            <div className="space-y-2 rounded-lg bg-muted p-3">
              <p className="text-xs text-muted-foreground">{tLife("cancelRefundOutsideNeeded")}</p>
              <label className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0">
                <Checkbox checked={outsideConfirmed} onCheckedChange={(v) => setOutsideConfirmed(v === true)} />
                <span>{tLife("cancelRefundOutsideConfirm")}</span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{tSales("keep")}</Button>
            <Button variant="destructive" disabled={busy !== null || (outsideNeeded && !outsideConfirmed)} onClick={async () => {
              const r = await run("cancel_and_refund", () => cancelAndRefundOrder(order.id, refundNote.trim() || null, outsideNeeded && outsideConfirmed),
                (v) => (v.refundIds.length === 0 && v.refundedOutside ? tLife("cancelRefundDoneOutside") : tLife("cancelRefundDone")));
              if (r?.ok) setDialog(null);
            }}>
              {busy === "cancel_and_refund" && <Loader2 className="h-4 w-4 animate-spin" />} {tLife("cancelRefundGo")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OfflinePaymentDialog orderId={order.id} currency={order.currency} dueMinor={due}
        open={paying} onOpenChange={setPaying} onRecorded={() => void reload()} />
    </div>
  );
}

/** The order over the list, in a sheet from the right. */
export function OrderSheet({ orderId, open, onOpenChange, onChanged, intent = null }: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  /** An action picked from the list's row menu. */
  intent?: OrderIntent | null;
}) {
  return (
    <Sheet open={open && orderId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="lg" className="w-full gap-0 overflow-y-auto p-0">
        {orderId && <OrderView key={orderId} orderId={orderId} onChanged={onChanged} variant="sheet" intent={intent} />}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children, sectionRef }: { title: string; children: ReactNode; sectionRef?: RefObject<HTMLElement | null> }) {
  return (
    <section ref={sectionRef} className="scroll-mt-4 space-y-3">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "font-semibold", muted && "text-muted-foreground")}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** Placeholders shaped like the order while it loads. */
function OrderViewSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6 p-5" aria-busy="true" aria-label={label}>
      <div className="space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
        <div className="flex gap-2"><div className="h-5 w-20 animate-pulse rounded-full bg-muted" /><div className="h-5 w-24 animate-pulse rounded-full bg-muted" /></div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
