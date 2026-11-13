"use client";

/**
 * Inventory: tracked variants with on hand, reserved for open orders and
 * available, lowest first; the stock ledger; and the adjust dialog (admins
 * with the commerce.inventory permission; the server enforces it). The dialog
 * sends the on-hand count it showed, so a retry or a sale in between is
 * refused (stock_changed) instead of applied twice.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  adjustInventory, fetchInventory, fetchMovements,
  type AdjustKind, type InventoryFilter, type InventoryRow, type MovementRow,
} from "./catalogue-api";
import { selectClass, useCatalogueError } from "./catalogue-admin";

export interface AdjustTarget {
  variantId: string;
  label: string;
  onHand: number;
  reserved: number;
}

const optionsText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(", ");

export function InventoryPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.inventory");
  const errorText = useCatalogueError();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<InventoryFilter | "">("");
  const [data, setData] = useState<{ items: InventoryRow[]; total: number } | null>(null);
  const [adjusting, setAdjusting] = useState<AdjustTarget | null>(null);
  const [history, setHistory] = useState<{ variantId?: string; label?: string }>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchInventory({ q, filter: filter || undefined, limit: 100 }).then((r) => {
        if (cancelled) return;
        setData(r.ok ? r.data : { items: [], total: 0 });
        if (!r.ok) toast.error(errorText(r));
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, filter, reload, errorText]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="pl-8" />
        </div>
        <select aria-label={t("filterLabel")} className={selectClass} value={filter} onChange={(e) => setFilter(e.target.value as InventoryFilter | "")}>
          <option value="">{t("filter.all")}</option>
          <option value="low">{t("filter.low")}</option>
          <option value="out">{t("filter.out")}</option>
        </select>
      </div>
      {data === null ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("colProduct")}</TableHead>
                <TableHead>{t("colSku")}</TableHead>
                <TableHead className="text-right">{t("colOnHand")}</TableHead>
                <TableHead className="text-right">{t("colReserved")}</TableHead>
                <TableHead className="text-right">{t("colAvailable")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((row) => {
                const label = [row.product_name, optionsText(row.option_values)].filter(Boolean).join(" · ");
                return (
                  <TableRow key={row.variant_id}>
                    <TableCell className="max-w-[18rem] truncate">{label}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.sku}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.on_hand}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.reserved}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.available}
                      {row.low && <Badge variant="destructive" className="ml-2">{row.available === 0 ? t("out") : t("low")}</Badge>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setHistory({ variantId: row.variant_id, label })}>{t("history")}</Button>
                      {canManage && (
                        <Button size="sm" variant="outline" onClick={() =>
                          setAdjusting({ variantId: row.variant_id, label, onHand: row.on_hand, reserved: row.reserved })}>
                          {t("adjust")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <MovementsList variantId={history.variantId} label={history.label} reload={reload} onClear={() => setHistory({})} />
      <AdjustStockDialog target={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); setReload((n) => n + 1); }} />
    </section>
  );
}

export function MovementsList({ variantId, label, reload = 0, onClear }: { variantId?: string; label?: string; reload?: number; onClear?: () => void }) {
  const t = useTranslations("Commerce.inventory.movements");
  const locale = useLocale();
  const [rows, setRows] = useState<MovementRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);

  const load = useCallback(async (before: string | null) => {
    const r = await fetchMovements({ variantId, before });
    if (!r.ok) { setRows((prev) => prev ?? []); return; }
    setRows((prev) => (before ? [...(prev ?? []), ...r.data.movements] : r.data.movements));
    setNext(r.data.next);
  }, [variantId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and on reload
    void load(null);
  }, [load, reload]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{label ? t("titleFor", { label }) : t("title")}</h2>
        {label && onClear && <Button size="sm" variant="ghost" onClick={onClear}>{t("showAll")}</Button>}
      </div>
      {rows === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
            <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>{t("colWhen")}</TableHead>
                <TableHead>{t("colItem")}</TableHead>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead className="text-right">{t("colQty")}</TableHead>
                <TableHead className="text-right">{t("colAfter")}</TableHead>
                <TableHead>{t("colBy")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(m.created_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate text-xs">{m.product_name} <span className="font-mono">{m.sku}</span></TableCell>
                  <TableCell className="text-xs">
                    {t(`kinds.${m.kind}`)}
                    {m.reason && <span className="block max-w-[14rem] truncate text-muted-foreground">{m.reason}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs text-muted-foreground">{t("after", { onHand: m.on_hand_after, reserved: m.reserved_after })}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.actor_user_id ? m.actor_name ?? t("staff") : t("system")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {next && <Button size="sm" variant="ghost" onClick={() => void load(next)}>{t("more")}</Button>}
    </div>
  );
}

export function AdjustStockDialog({ target, onClose, onDone }: { target: AdjustTarget | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("Commerce.inventory.adjustDialog");
  const errorText = useCatalogueError();
  const [kind, setKind] = useState<AdjustKind>("receipt");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new target starts an empty form
    setKind("receipt"); setAmount(""); setReason("");
  }, [target]);

  const quantity = Number(amount);
  const valid = /^-?\d{1,7}$/.test(amount.trim()) && quantity !== 0 && (kind === "adjustment" || quantity > 0) && (kind !== "write_off" || reason.trim().length > 0);
  // Receipts add and write-offs remove the typed count; an adjustment is signed.
  const delta = kind === "write_off" ? -Math.abs(quantity) : kind === "receipt" ? Math.abs(quantity) : quantity;

  const submit = async () => {
    if (!target || !valid) return;
    setBusy(true);
    const r = await adjustInventory(target.variantId, { kind, delta, expected_on_hand: target.onHand, reason: reason.trim() || null });
    setBusy(false);
    if (!r.ok) {
      toast.error(errorText(r));
      if (r.code === "stock_changed") onDone();
      return;
    }
    toast.success(t("done", { onHand: r.data.onHand }));
    onDone();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{target ? `${target.label} — ${t("current", { onHand: target.onHand, reserved: target.reserved })}` : ""}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="space-y-1">
            <Label htmlFor="adjust-kind">{t("kind")}</Label>
            <select id="adjust-kind" className={`${selectClass} w-full`} value={kind} onChange={(e) => setKind(e.target.value as AdjustKind)}>
              <option value="receipt">{t("kinds.receipt")}</option>
              <option value="write_off">{t("kinds.write_off")}</option>
              <option value="adjustment">{t("kinds.adjustment")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-qty">{t("quantity")}</Label>
            <Input id="adjust-qty" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t(`hints.${kind}`)}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-reason">{kind === "write_off" ? t("reasonRequired") : t("reason")}</Label>
            <Input id="adjust-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
            <Button type="submit" disabled={busy || !valid}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
