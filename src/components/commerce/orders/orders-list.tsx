"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Search, Settings2, ShoppingBag } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/commerce/money";
import { ORDER_SOURCES, ORDER_STATUSES, type OrderSource, type OrderStatus } from "@/lib/commerce/order-format";
import { listOrders, type OrderListItem } from "./order-api";
import { OrderSettingsDialog } from "./order-settings-dialog";
import { OrderStatusBadge } from "./order-status-badge";

const ALL = "all";

/** Orders from WhatsApp carts and connected stores, newest first, for agents and above. */
export function OrdersList() {
  const t = useTranslations("Commerce.orders");
  const tSource = useTranslations("Commerce.orders.sources");
  const tStatus = useTranslations("Commerce.orders.statuses");
  const format = useFormatter();
  const locale = useLocale();
  const canAct = useCan("send-messages");

  const [status, setStatus] = useState<OrderStatus | "">("");
  const [source, setSource] = useState<OrderSource | "">("");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
  }, [status, source, q, t]);

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

  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canAct && (
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            {t("settings.open")}
          </Button>
        )}
      </header>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setQ(draft.trim())}
            placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")} className="pl-8" maxLength={100} />
        </div>
        <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? "" : (v as OrderStatus))}>
          <SelectTrigger className="w-44" aria-label={t("filterStatus")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {ORDER_STATUSES.map((s) => <SelectItem key={s} value={s}>{tStatus(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={source || ALL} onValueChange={(v) => setSource(v === ALL ? "" : (v as OrderSource))}>
          <SelectTrigger className="w-40" aria-label={t("filterSource")}><SelectValue /></SelectTrigger>
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
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <ShoppingBag className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">{q || status || source ? t("noMatches") : t("emptyTitle")}</h2>
          {!(q || status || source) && <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDesc")}</p>}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colOrder")}</TableHead>
                <TableHead>{t("colCustomer")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead className="text-right">{t("colItems")}</TableHead>
                <TableHead className="text-right">{t("colTotal")}</TableHead>
                <TableHead>{t("colPlaced")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/commerce/orders/${order.id}`} className="font-medium text-foreground hover:underline">
                      {order.external_id ? `#${order.external_id}` : order.id.slice(0, 8).toUpperCase()}
                    </Link>
                    <div className="text-xs text-muted-foreground">{tSource(order.source)}</div>
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate">
                    {order.contact?.name || order.contact?.phone || t("unknownCustomer")}
                  </TableCell>
                  <TableCell><OrderStatusBadge status={order.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{order.item_count}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(order.total_minor ?? order.subtotal_minor, order.currency)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {format.dateTime(new Date(order.created_at), { dateStyle: "medium", timeStyle: "short" })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
    </div>
  );
}
