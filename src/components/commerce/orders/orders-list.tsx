"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Banknote, Download, Eye, FileText, Link2, Loader2, MoreHorizontal, Plus, Printer, Search, Send, Settings2, ShoppingBag, Truck, Undo2, X,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney } from "@/lib/format/money";
import { ORDER_SOURCES, ORDER_STATUSES, type OrderSource, type OrderStatus } from "@/lib/commerce/order-format";
import type { OrderListItem } from "./order-api";
import {
  BULK_DISPATCH_MAX, DATE_PRESETS, dateRangeFor, exportOrders, listOrders, PAYMENT_FILTERS, type DatePreset, type OrderQuery, type PaymentFilter,
} from "./orders-list-api";
import { OrderSheet, type OrderIntent } from "./order-view";
import { NewOrderDialog } from "./new-order-dialog";
import { OrderRiskBadge } from "./order-risk-badge";
import { OrderSettingsDialog } from "./order-settings-dialog";
import {
  canCancelUnpaid, canTakeLinkPayment, COD_CONFIRM_TONE, FULFILMENT_TONE, fulfilmentState, orderRef, PAYMENT_TONE, paymentState,
} from "@/lib/commerce/order-state";
import { StateBadge } from "./state-badge";
import { BulkDispatchSheet, type BulkOrder } from "./bulk-dispatch-sheet";
import { RowPlaceholders } from "./list-states";
import { InlineError } from "@/components/ui/inline-error";
import { QuotesList } from "./quotes-list";
import { ReturnsQueue } from "./returns-queue";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

const ALL = "all";
const CASH_DUE = "cash_due";
const EMPTY: ReadonlySet<string> = new Set();
type Tab = "orders" | "returns" | "quotes";

/** The step a list row can offer without the order's detail (the drawer re-checks it with the full order). */
function listStep(o: OrderListItem): "ship" | "deliver" | "confirm" | null {
  if (o.refund_state === "full" && o.status !== "dispatched" && o.status !== "fulfilled") return null;
  if (o.status === "paid") return "ship";
  if (o.status === "dispatched") return "deliver";
  if (o.status === "confirmed" && o.payment_method === "cod" && !o.paid_at) return "ship";
  if (o.status === "new") return "confirm";
  return null;
}

/**
 * Sales → Orders: the order list (filters run on the server, with a count and the matching CSV export), the
 * returns queue and the quotes sent. Admins can select orders to create courier shipments or print labels in bulk.
 */
export function OrdersList() {
  const t = useTranslations("Commerce.orders");
  const tl = useTranslations("Commerce.orders.listing");
  const ts = useTranslations("Sales.orders");
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  const [tab, setTab] = useState<Tab>("orders");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState<"order" | "quote" | null>(null);
  const [open, setOpen] = useState<{ id: string; intent: OrderIntent | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [exportQuery, setExportQuery] = useState<OrderQuery>({});
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const openOrder = useCallback((id: string, intent: OrderIntent | null = null) => setOpen({ id, intent }), []);

  // Admins download the server-built CSV (formula-safe, masking-aware) for exactly the list's filters.
  const runExport = async () => {
    setExporting(true);
    const res = await exportOrders(exportQuery).catch(() => null);
    setExporting(false);
    if (!res || !res.ok) toast.error(res?.status === 429 ? tl("exportThrottled") : ts("exportFailed"));
    else if (res.truncated) toast.warning(tl("exportTruncated", { rows: res.rows }));
    else toast.success(tl("exportDone", { rows: res.rows }));
  };

  return (
    <div className="space-y-5">
      <PageHeader
        className="mb-0"
        title={t("title")}
        subtitle={t("description")}
        moreActions={[
          ...(canAct ? [{ label: t("quote.open"), icon: FileText, onSelect: () => setCreating("quote") }] : []),
          ...(canAdmin ? [
            { label: t("counter.open"), icon: ShoppingBag, href: "/commerce/orders/counter" },
            { label: t("exportCsv"), icon: exporting ? Loader2 : Download, disabled: exporting, onSelect: () => void runExport() },
          ] : []),
          ...(canAct ? [{ label: t("settings.open"), icon: Settings2, onSelect: () => setSettingsOpen(true) }] : []),
        ]}
        primaryAction={canAct ? (
          <Button className="min-h-11 sm:min-h-9" onClick={() => setCreating("order")}>
            <Plus className="h-4 w-4" />
            {ts("newOrder")}
          </Button>
        ) : undefined}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="h-11 sm:h-9">
          <TabsTrigger value="orders" className="px-4">{tl("tabs.orders")}</TabsTrigger>
          <TabsTrigger value="returns" className="px-4">{tl("tabs.returns")}</TabsTrigger>
          <TabsTrigger value="quotes" className="px-4">{tl("tabs.quotes")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "orders" && (
        <OrdersTab reloadKey={reloadKey} onOpenOrder={openOrder} onNewOrder={() => setCreating("order")} onQueryChange={setExportQuery} />
      )}
      {tab === "returns" && <ReturnsQueue reloadKey={reloadKey} onOpenOrder={(id) => openOrder(id)} />}
      {tab === "quotes" && <QuotesList reloadKey={reloadKey} onNewQuote={() => setCreating("quote")} />}

      {settingsOpen && <OrderSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
      {canAct && (
        <NewOrderDialog open={creating !== null} mode={creating ?? "order"} onOpenChange={(v) => !v && setCreating(null)}
          onCreated={(order) => { refresh(); openOrder(order.id); }} />
      )}
      <OrderSheet orderId={open?.id ?? null} open={open !== null} intent={open?.intent ?? null} onOpenChange={(v) => { if (!v) setOpen(null); }} onChanged={refresh} />
    </div>
  );
}

/** The filtered order list, paged by "Load more", with row selection for bulk dispatch (admins). */
function OrdersTab({ reloadKey, onOpenOrder, onNewOrder, onQueryChange }: {
  reloadKey: number;
  onOpenOrder: (id: string, intent?: OrderIntent | null) => void;
  onNewOrder: () => void;
  onQueryChange: (query: OrderQuery) => void;
}) {
  const t = useTranslations("Commerce.orders");
  const tl = useTranslations("Commerce.orders.listing");
  const ts = useTranslations("Sales.orders");
  const tSource = useTranslations("Commerce.orders.sources");
  const tStatus = useTranslations("Commerce.orders.statuses");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  const [status, setStatus] = useState<OrderStatus | "">("");
  const [source, setSource] = useState<OrderSource | "">("");
  const [payment, setPayment] = useState<PaymentFilter | typeof CASH_DUE | "">("");
  const [datePreset, setDatePreset] = useState<DatePreset>("any");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [codConfirmation, setCodConfirmation] = useState<"pending" | "declined" | "">("");
  const [tag, setTag] = useState("");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Which request the shown rows (or the failure) answer: an older answer reads as still loading.
  const [answered, setAnswered] = useState<{ key: string; failed: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // The selection belongs to one list: a new filter or reload starts empty.
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null);
  const [bulk, setBulk] = useState<{ action: "create" | "labels"; orders: BulkOrder[] } | null>(null);

  const range = useMemo(() => dateRangeFor(datePreset, { from: customFrom, to: customTo }), [datePreset, customFrom, customTo]);
  const query = useMemo<OrderQuery>(() => ({
    status, source, q, tag, codConfirmation,
    payment: payment === CASH_DUE ? "" : payment, cashDue: payment === CASH_DUE, from: range.from, to: range.to,
  }), [status, source, q, tag, codConfirmation, payment, range]);

  useEffect(() => { onQueryChange(query); }, [query, onQueryChange]);

  const key = `${JSON.stringify(query)}|${reloadKey}|${attempt}`;
  const loading = answered?.key !== key;
  const failed = !loading && answered?.failed === true;
  const selected = selection?.key === key ? selection.ids : EMPTY;
  const setSelected = (ids: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>)) =>
    setSelection((prev) => ({ key, ids: typeof ids === "function" ? ids(prev?.key === key ? prev.ids : EMPTY) : ids }));

  useEffect(() => {
    let cancelled = false;
    listOrders(query)
      .then((page) => {
        if (cancelled) return;
        setOrders(page.orders);
        setTotal(page.total);
        setCursor(page.next_cursor);
        setAnswered({ key, failed: false });
      })
      .catch(() => !cancelled && setAnswered({ key, failed: true }));
    return () => {
      cancelled = true;
    };
  }, [query, key]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await listOrders({ ...query, cursor });
      setOrders((prev) => [...prev, ...page.orders.filter((o) => !prev.some((p) => p.id === o.id))]);
      setCursor(page.next_cursor);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, query, t]);

  const money = (minor: number, currency: string) => {
    return formatMoney(minor, currency, { locale });
  };

  const filtered = Boolean(q || status || source || tag || codConfirmation || payment || range.from || range.to);
  const selectable = canAdmin;
  const allSelected = orders.length > 0 && orders.every((o) => selected.has(o.id));
  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const tooMany = selected.size > BULK_DISPATCH_MAX;
  // The sheet keeps its own copy: the list reloads (and clears the selection) once shipments were requested.
  const startBulk = (action: "create" | "labels") =>
    setBulk({ action, orders: orders.filter((o) => selected.has(o.id)).map((o) => ({ id: o.id, ref: orderRef(o) })) });

  return (
    <div className="space-y-4">
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
            placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} className="min-h-11 pl-8 sm:min-h-9" maxLength={100} />
        </div>
        <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? "" : (v as OrderStatus))}>
          <SelectTrigger className="min-h-11 w-44 max-w-full sm:min-h-9" aria-label={t("filterStatus")}>
            <SelectValue>{(v: string) => (v === ALL ? t("allStatuses") : tStatus(v as OrderStatus))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {ORDER_STATUSES.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={payment || ALL} onValueChange={(v) => setPayment(v === ALL ? "" : (v as PaymentFilter | typeof CASH_DUE))}>
          <SelectTrigger className="min-h-11 w-48 max-w-full sm:min-h-9" aria-label={tl("filterPayment")}>
            <SelectValue>{(v: string) => (v === ALL ? tl("allPayments") : tl(`payment.${v as PaymentFilter | typeof CASH_DUE}`))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{tl("allPayments")}</SelectItem>
            {PAYMENT_FILTERS.map((p) => <SelectItem key={p} value={p}>{tl(`payment.${p}`)}</SelectItem>)}
            <SelectSeparator />
            <SelectItem value={CASH_DUE}>{tl("payment.cash_due")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
          <SelectTrigger className="min-h-11 w-40 max-w-full sm:min-h-9" aria-label={tl("filterDate")}>
            <SelectValue>{(v: string) => tl(`date.${v as DatePreset}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => <SelectItem key={p} value={p}>{tl(`date.${p}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        {datePreset === "custom" && (
          <>
            <Input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={tl("dateFrom")} className="min-h-11 w-40 sm:min-h-9" />
            <Input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)}
              aria-label={tl("dateTo")} className="min-h-11 w-40 sm:min-h-9" />
          </>
        )}
        <Select value={source || ALL} onValueChange={(v) => setSource(v === ALL ? "" : (v as OrderSource))}>
          <SelectTrigger className="min-h-11 w-40 max-w-full sm:min-h-9" aria-label={t("filterSource")}>
            <SelectValue>{(v: string) => (v === ALL ? t("allSources") : tSource(v as OrderSource))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allSources")}</SelectItem>
            {ORDER_SOURCES.map((s) => <SelectItem key={s} value={s}>{tSource(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={codConfirmation || ALL} onValueChange={(v) => setCodConfirmation(v === ALL ? "" : (v as "pending" | "declined"))}>
          <SelectTrigger className="min-h-11 w-48 max-w-full sm:min-h-9" aria-label={t("filterCodConfirmation")}>
            <SelectValue>{(v: string) => (v === ALL ? t("allCodConfirmations") : t(`cod.confirmation.${v as "pending" | "declined"}`))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allCodConfirmations")}</SelectItem>
            <SelectItem value="pending">{t("cod.confirmation.pending")}</SelectItem>
            <SelectItem value="declined">{t("cod.confirmation.declined")}</SelectItem>
          </SelectContent>
        </Select>
        <Input value={tag} onChange={(e) => setTag(e.target.value.slice(0, 24))} placeholder={t("tags.filter")} aria-label={t("tags.filter")}
          className="min-h-11 w-36 sm:min-h-9" maxLength={24} />
      </form>
      {payment === CASH_DUE && <p className="text-xs text-muted-foreground">{tl("cashDueHelp")}</p>}

      {selectable && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted px-3 py-2" role="region" aria-label={tl("selected", { count: selected.size })}>
          <span className="text-sm font-medium">{tl("selected", { count: selected.size })}</span>
          {tooMany && <span className="text-xs text-destructive">{tl("tooMany", { max: BULK_DISPATCH_MAX })}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" className="min-h-11 sm:min-h-8" size="sm" disabled={tooMany} onClick={() => startBulk("create")}>
              <Truck className="h-4 w-4" /> {tl("bulk.create")}
            </Button>
            <Button variant="outline" className="min-h-11 sm:min-h-8" size="sm" disabled={tooMany} onClick={() => startBulk("labels")}>
              <Printer className="h-4 w-4" /> {tl("bulk.labels")}
            </Button>
            <Button variant="ghost" className="min-h-11 sm:min-h-8" size="sm" onClick={() => setSelected(new Set())}>{tl("clear")}</Button>
          </div>
        </div>
      )}

      {failed ? (
        <InlineError message={t("loadError")} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading ? (
        <RowPlaceholders label={t("loading")} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title={filtered ? t("noMatches") : t("emptyTitle")}
          body={filtered ? undefined : t("emptyDesc")}
          action={canAct && !filtered ? <Button className="min-h-11 sm:min-h-9" variant="outline" onClick={onNewOrder}><Plus className="h-4 w-4" /> {ts("newOrder")}</Button> : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                {selectable && (
                  <TableHead className="w-px">
                    <Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} aria-label={tl("selectAll")}
                      onCheckedChange={(on) => setSelected(on ? new Set(orders.map((o) => o.id)) : new Set())} />
                  </TableHead>
                )}
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
                    data-state={selected.has(order.id) ? "selected" : undefined}
                    aria-label={ts("openOrderLabel", { ref })}
                    onClick={() => onOpenOrder(order.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpenOrder(order.id); }}>
                    {selectable && (
                      <TableCell className="w-px" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <label className="-m-3 flex size-11 items-center justify-center sm:-m-2 sm:size-8">
                          <Checkbox checked={selected.has(order.id)} aria-label={tl("select", { ref })} onCheckedChange={(on) => toggle(order.id, on)} />
                        </label>
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap">
                      <span className="font-medium tabular-nums text-foreground">{ref}</span>
                      <div className="text-xs text-muted-foreground">
                        {format.dateTime(new Date(order.created_at), { dateStyle: "medium" })} · {tSource(order.source)}
                      </div>
                      {order.tags && order.tags.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">{order.tags.map((x) => `#${x}`).join(" ")}</div>}
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate">
                      {order.contact?.name || order.contact?.phone || t("unknownCustomer")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{order.item_count}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                      {money(order.total_minor ?? order.subtotal_minor, order.currency)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <StateBadge tone={PAYMENT_TONE[pay]}>{ts(`pay.${pay}`)}</StateBadge>
                        <OrderRiskBadge risk={order.risk} />
                        {order.cod_confirmation && (
                          <StateBadge tone={COD_CONFIRM_TONE[order.cod_confirmation]}>{t(`cod.confirmation.${order.cod_confirmation}`)}</StateBadge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell><StateBadge tone={FULFILMENT_TONE[ful]}>{ts(`ful.${ful}`)}</StateBadge></TableCell>
                    <TableCell className="w-px text-right" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={ts("orderActions", { ref })}
                          className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary sm:size-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => onOpenOrder(order.id)}><Eye className="h-4 w-4" /> {ts("openOrder")}</DropdownMenuItem>
                          {step && <DropdownMenuItem onClick={() => onOpenOrder(order.id, "step")}><Truck className="h-4 w-4" /> {ts(`next.${step}`)}</DropdownMenuItem>}
                          {canAct && canTakeLinkPayment(order) && (
                            <DropdownMenuItem onClick={() => onOpenOrder(order.id, "link")}><Link2 className="h-4 w-4" /> {ts("sendPaymentLink")}</DropdownMenuItem>
                          )}
                          {canAdmin && canCancelUnpaid(order) && (
                            <DropdownMenuItem onClick={() => onOpenOrder(order.id, "pay")}><Banknote className="h-4 w-4" /> {ts("recordPayment")}</DropdownMenuItem>
                          )}
                          {canAct && order.conversation_id && (
                            <DropdownMenuItem onClick={() => onOpenOrder(order.id, "update")}><Send className="h-4 w-4" /> {ts("sendUpdate")}</DropdownMenuItem>
                          )}
                          {((canAdmin && order.status === "paid") || (canAct && canCancelUnpaid(order))) && <DropdownMenuSeparator />}
                          {canAdmin && order.status === "paid" && (
                            <DropdownMenuItem variant="destructive" onClick={() => onOpenOrder(order.id, "refund")}><Undo2 className="h-4 w-4" /> {ts("refund")}</DropdownMenuItem>
                          )}
                          {canAct && canCancelUnpaid(order) && (
                            <DropdownMenuItem variant="destructive" onClick={() => onOpenOrder(order.id, "cancel")}><X className="h-4 w-4" /> {ts("cancelOrder")}</DropdownMenuItem>
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

      {!loading && !failed && orders.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {total !== null ? tl("shownOf", { shown: orders.length, total }) : ts("shown", { count: orders.length })}{" "}
          <Link href="/commerce/payments" className="text-primary hover:underline">{ts("seePayments")}</Link>
        </p>
      )}

      {cursor && !loading && !failed && (
        <div className="flex justify-center">
          <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}

      {selectable && (
        <BulkDispatchSheet action={bulk?.action ?? null} orders={bulk?.orders ?? []} onOpenChange={(v) => !v && setBulk(null)}
          onDone={() => setAttempt((n) => n + 1)} />
      )}
    </div>
  );
}
