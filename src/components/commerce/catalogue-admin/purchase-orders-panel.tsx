"use client";

/**
 * Purchase orders (store plan Phase 8): the list, a form for a new draft, and one order's lines with
 * its next steps (mark ordered, receive into a location, close, cancel). Admins with the
 * commerce.inventory permission manage; the server enforces it. A receive carries a key made once per
 * filled-in form, so a double click or a retry never adds the stock twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, parseMoney } from "@/lib/commerce/money";
import { poReceivable, poTransition } from "@/lib/commerce/stock-rules";
import {
  changePurchaseOrderStatus, createPurchaseOrder, fetchLocations, fetchPurchaseOrder, fetchPurchaseOrders, fetchShopProducts, receivePurchaseOrder,
  type InventoryRow, type PoAction, type PurchaseOrder, type PurchaseOrderSummary, type StockLocation,
} from "./catalogue-api";
import { selectClass, useCatalogueError } from "./catalogue-admin";
import { variantLabel, VariantPicker } from "./locations-panel";

type DraftLine = { variant: InventoryRow; qty: string; cost: string };

export function PurchaseOrdersPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.purchaseOrders");
  const locale = useLocale();
  const [orders, setOrders] = useState<PurchaseOrderSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await fetchPurchaseOrders();
    setOrders(r.ok ? r.data : []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
    void reload();
    fetchShopProducts({ limit: 1 }).then((r) => { if (r.ok) setCurrency(r.data.currency); });
  }, [reload]);

  if (orders === null) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
        {canManage && !creating && currency && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />{t("new")}</Button>}
      </div>
      {canManage && !currency && <p className="text-sm text-muted-foreground">{t("needsCurrency")}</p>}
      {creating && currency && (
        <NewOrderForm currency={currency} onCancel={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); setOpen(id); await reload(); }} />
      )}
      {orders.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("colSupplier")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead className="text-right">{t("colReceived")}</TableHead>
                <TableHead className="text-right">{t("colCost")}</TableHead>
                <TableHead>{t("colCreated")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="max-w-[16rem] truncate">{o.supplier_name}{o.reference && <span className="ml-2 font-mono text-xs text-muted-foreground">{o.reference}</span>}</TableCell>
                  <TableCell><Badge variant={o.status === "cancelled" ? "outline" : o.status === "received" || o.status === "closed" ? "default" : "secondary"}>{t(`statuses.${o.status}`)}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{o.units_received} / {o.units_ordered}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(o.total_cost_minor, o.currency, locale)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(o.created_at).toLocaleDateString(locale, { dateStyle: "medium" })}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? t("hide") : t("view")}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <OrderDetail key={open} id={open} canManage={canManage} onChanged={reload} />}
    </section>
  );
}

function NewOrderForm({ currency, onCancel, onCreated }: { currency: string; onCancel: () => void; onCreated: (id: string) => Promise<void> }) {
  const t = useTranslations("Commerce.purchaseOrders");
  const errorText = useCatalogueError();
  const [supplier, setSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, change: Partial<DraftLine>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...change } : l)));
  const parsed = lines.map((l) => {
    let cost: number | null = 0;
    try { cost = l.cost.trim() ? parseMoney(l.cost, currency) : 0; } catch { cost = null; }
    return { variant_id: l.variant.variant_id, qty_ordered: /^\d{1,7}$/.test(l.qty.trim()) ? Number(l.qty) : 0, unit_cost_minor: cost };
  });
  const valid = supplier.trim().length > 0 && parsed.length > 0 && parsed.every((l) => l.qty_ordered > 0 && l.unit_cost_minor !== null);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const r = await createPurchaseOrder({
      supplier_name: supplier.trim(), reference: reference.trim() || null, note: null,
      lines: parsed.map((l) => ({ ...l, unit_cost_minor: l.unit_cost_minor ?? 0 })),
    });
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(r));
    toast.success(t("created"));
    await onCreated(r.data.id);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight text-foreground">{t("new")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="po-supplier">{t("supplier")}</Label><Input id="po-supplier" maxLength={120} value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="po-reference">{t("reference")}</Label><Input id="po-reference" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      </div>
      {lines.map((l, i) => (
        <div key={l.variant.variant_id} className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_9rem_auto]">
          <span className="truncate text-sm">{variantLabel(l.variant)}</span>
          <div className="space-y-1"><Label htmlFor={`po-qty-${i}`}>{t("quantity")}</Label><Input id={`po-qty-${i}`} inputMode="numeric" value={l.qty} onChange={(e) => patch(i, { qty: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={`po-cost-${i}`}>{t("unitCost", { currency })}</Label><Input id={`po-cost-${i}`} inputMode="decimal" placeholder="0" value={l.cost} onChange={(e) => patch(i, { cost: e.target.value })} /></div>
          <Button size="icon" variant="ghost" aria-label={t("removeLine")} onClick={() => setLines(lines.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      <VariantPicker label={t("addVariant")} onPick={(row) => {
        if (!lines.some((l) => l.variant.variant_id === row.variant_id)) setLines([...lines, { variant: row, qty: "1", cost: "" }]);
      }} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !valid} onClick={() => void submit()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("saveDraft")}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
      </div>
    </div>
  );
}

function OrderDetail({ id, canManage, onChanged }: { id: string; canManage: boolean; onChanged: () => Promise<void> }) {
  const t = useTranslations("Commerce.purchaseOrders");
  const locale = useLocale();
  const errorText = useCatalogueError();
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // One key per filled-in receive form: a retry of the same receipt is a no-op on the server.
  const key = useRef<string>(crypto.randomUUID());

  const show = useCallback((o: PurchaseOrder) => {
    setOrder(o);
    setQty(Object.fromEntries(o.lines.map((l) => [l.id, String(Math.max(l.qty_ordered - l.qty_received, 0))])));
    key.current = crypto.randomUUID();
  }, []);
  useEffect(() => {
    fetchPurchaseOrder(id).then((r) => { if (r.ok) show(r.data); });
    fetchLocations().then((r) => {
      if (!r.ok) return;
      const active = r.data.filter((l) => l.active);
      setLocations(active);
      setLocation(active.find((l) => l.is_default)?.id ?? active[0]?.id ?? "");
    });
  }, [id, show]);

  if (!order) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const act = async (action: PoAction) => {
    setBusy(true);
    const r = await changePurchaseOrderStatus(id, action);
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(r));
    show(r.data);
    await onChanged();
  };
  const receiving = order.lines.map((l) => ({ line_id: l.id, quantity: /^\d{1,7}$/.test((qty[l.id] ?? "").trim()) ? Number(qty[l.id]) : 0 })).filter((l) => l.quantity > 0);
  const receive = async () => {
    if (!receiving.length) return;
    setBusy(true);
    const r = await receivePurchaseOrder(id, { request_key: key.current, location_id: location || null, lines: receiving });
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(r));
    toast.success(t("receivedToast"));
    show(r.data);
    await onChanged();
  };
  const canReceive = canManage && poReceivable(order.status);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{order.supplier_name}{order.reference ? ` · ${order.reference}` : ""}</h2>
        <Badge variant="secondary">{t(`statuses.${order.status}`)}</Badge>
      </div>
      <div className="overflow-x-auto">
        <Table className="[&_td]:px-3 [&_td]:py-2">
          <TableHeader className="[&_th]:h-9 [&_th]:px-3 [&_th]:text-xs [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>{t("colItem")}</TableHead>
              <TableHead className="text-right">{t("colOrdered")}</TableHead>
              <TableHead className="text-right">{t("colReceived")}</TableHead>
              <TableHead className="text-right">{t("colUnitCost")}</TableHead>
              {canReceive && <TableHead className="text-right">{t("colReceiveNow")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="max-w-[16rem] truncate">{l.product_name} <span className="font-mono text-xs text-muted-foreground">{l.sku}</span></TableCell>
                <TableCell className="text-right tabular-nums">{l.qty_ordered}</TableCell>
                <TableCell className="text-right tabular-nums">{l.qty_received}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(l.unit_cost_minor, order.currency, locale)}</TableCell>
                {canReceive && (
                  <TableCell className="text-right">
                    <Input className="ml-auto h-8 w-20 text-right" inputMode="numeric" aria-label={t("colReceiveNow")} disabled={l.qty_received >= l.qty_ordered}
                      value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          {canReceive && (
            <>
              <div className="space-y-1">
                <Label htmlFor="po-location">{t("receiveAt")}</Label>
                <select id="po-location" className={selectClass} value={location} onChange={(e) => setLocation(e.target.value)}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <Button size="sm" disabled={busy || !receiving.length} onClick={() => void receive()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("receive")}</Button>
            </>
          )}
          {(["order", "close", "cancel"] as const).filter((a) => poTransition(order.status, a)).map((a) => (
            <Button key={a} size="sm" variant={a === "order" ? "default" : "outline"} disabled={busy} onClick={() => void act(a)}>{t(`actions.${a}`)}</Button>
          ))}
        </div>
      )}
    </div>
  );
}
