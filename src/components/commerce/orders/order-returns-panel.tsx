"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyError, parseMoney } from "@/lib/commerce/money";
import {
  createOrderReturn, moveReturn, refundReturn, type ApiResult, type OrderDetail, type OrderReturn, type ReturnAction,
} from "./order-api";

const RETURNABLE = new Set(["dispatched", "fulfilled"]);

/**
 * Staff-created returns: open one for chosen lines (within the store's return
 * window), then receive, inspect (restock or discard per line), and refund or
 * close. Stock comes back only through a processed refund or an admin closing
 * with restock. Money Razorpay does not hold (cash on delivery, a payment the
 * team recorded) is refunded outside the app and confirmed here to record it.
 */
export function OrderReturnsPanel({ order, returns, canAct, canAdmin, onChanged }: {
  order: OrderDetail;
  returns: OrderReturn[];
  canAct: boolean;
  canAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("Commerce.returns");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<Record<string, Record<string, "restock" | "discard">>>({});
  const [amount, setAmount] = useState<Record<string, string>>({});
  // Returns whose refund needs the outside-refund confirmation, and whether it is ticked.
  const [outsideNeeded, setOutsideNeeded] = useState<Record<string, boolean>>({});
  const [outsideConfirmed, setOutsideConfirmed] = useState<Record<string, boolean>>({});
  const nameOf = new Map(order.items.map((i) => [i.id, i.name || i.sku || i.retailer_id || "-"]));

  if (!RETURNABLE.has(order.status) && returns.length === 0) return null;

  async function run<T>(key: string, call: () => Promise<ApiResult<T>>, success: string): Promise<boolean> {
    setBusy(key);
    try {
      const r = await call();
      if (!r.ok) {
        toast.error(r.status === 403 ? t("forbidden")
          : r.code === "return_window_closed" ? t("windowClosed")
            : r.code === "amount_exceeds" ? t("amountExceeds")
              : r.code === "conflict" || r.code === "bad_transition" ? t("conflict") : t("error"));
        return false;
      }
      toast.success(success);
      await onChanged();
      return true;
    } catch {
      toast.error(t("error"));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const items = order.items.flatMap((i) => {
      const n = Number(qty[i.id] ?? "0");
      return Number.isInteger(n) && n > 0 ? [{ order_item_id: i.id, qty: n }] : [];
    });
    if (!items.length) return toast.error(t("chooseItems"));
    if (await run("create", () => createOrderReturn(order.id, { items, note: note.trim() || null }), t("created"))) {
      setOpen(false);
      setQty({});
      setNote("");
    }
  }

  const act = (r: OrderReturn, input: ReturnAction, success: string) => run(`${r.id}:${input.action}`, () => moveReturn(r.id, input), success);

  async function refund(r: OrderReturn) {
    let minor: number;
    try {
      minor = parseMoney(amount[r.id] ?? "", order.currency);
    } catch (error) {
      if (error instanceof MoneyError) return toast.error(t("badAmount"));
      throw error;
    }
    if (minor <= 0) return toast.error(t("badAmount"));
    const outside = outsideConfirmed[r.id] === true;
    setBusy(`${r.id}:refund`);
    try {
      const res = await refundReturn(r.id, minor, null, outside);
      if (!res.ok && res.code === "offline_payment") {
        setOutsideNeeded({ ...outsideNeeded, [r.id]: true });
        toast.error(t("refundOutsideNeeded"));
        return;
      }
      if (!res.ok) {
        toast.error(res.status === 403 ? t("forbidden") : res.code === "amount_exceeds" ? t("amountExceeds")
          : res.code === "conflict" || res.code === "bad_transition" ? t("conflict") : t("error"));
        return;
      }
      toast.success(outside ? t("refundedOutside") : t("refundRequested"));
      await onChanged();
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
        {RETURNABLE.has(order.status) && canAct && !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t("open")}</Button>
        )}
      </div>

      {open && (
        <div className="space-y-2 rounded-md border border-border p-3">
          {order.items.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-2">
              <Label htmlFor={`ret-${i.id}`} className="min-w-0 flex-1 truncate">{nameOf.get(i.id)} (× {i.quantity})</Label>
              <Input id={`ret-${i.id}`} className="w-20" inputMode="numeric" value={qty[i.id] ?? ""} placeholder="0"
                onChange={(e) => setQty({ ...qty, [i.id]: e.target.value.replace(/\D/g, "").slice(0, 6) })} />
            </div>
          ))}
          <Textarea rows={2} maxLength={500} value={note} placeholder={t("notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={create}>
              {busy === "create" && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {returns.length === 0 && !open && <p className="text-xs text-muted-foreground">{t("none")}</p>}

      <ul className="space-y-3">
        {returns.map((r) => (
          <li key={r.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">{t(`statuses.${r.status}`)}</span>
              {r.refund_id && <span className="text-xs text-muted-foreground">{t("refundLinked")}</span>}
              {r.restocked_at && <span className="text-xs text-muted-foreground">{t("restocked")}</span>}
            </div>
            <ul className="text-xs text-muted-foreground">
              {r.items.map((l) => (
                <li key={l.order_item_id}>
                  {l.qty} × {nameOf.get(l.order_item_id) ?? "-"}
                  {r.disposition?.[l.order_item_id] ? ` · ${t(`dispositions.${r.disposition[l.order_item_id]}`)}` : ""}
                </li>
              ))}
            </ul>
            {r.note && <p className="text-xs whitespace-pre-wrap break-words">{r.note}</p>}

            {canAct && r.status === "requested" && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(r, { action: "receive" }, t("received"))}>{t("receive")}</Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(r, { action: "reject" }, t("rejected"))}>{t("reject")}</Button>
              </div>
            )}
            {canAct && r.status === "received" && (
              <div className="space-y-2">
                {r.items.map((l) => (
                  <div key={l.order_item_id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{nameOf.get(l.order_item_id) ?? "-"}</span>
                    {(["restock", "discard"] as const).map((d) => (
                      <Button key={d} size="sm" variant={disposition[r.id]?.[l.order_item_id] === d ? "default" : "outline"}
                        aria-pressed={disposition[r.id]?.[l.order_item_id] === d}
                        onClick={() => setDisposition({ ...disposition, [r.id]: { ...disposition[r.id], [l.order_item_id]: d } })}>
                        {t(`dispositions.${d}`)}
                      </Button>
                    ))}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy !== null || r.items.some((l) => !disposition[r.id]?.[l.order_item_id])}
                    onClick={() => act(r, { action: "inspect", disposition: disposition[r.id] ?? {} }, t("inspected"))}>{t("inspect")}</Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(r, { action: "reject" }, t("rejected"))}>{t("reject")}</Button>
                </div>
              </div>
            )}
            {r.status === "inspected" && (
              <div className="space-y-2">
                {!r.refund_id && canAdmin && order.amount_paid_minor > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input className="w-32" inputMode="decimal" aria-label={t("refundAmount")} placeholder={t("refundAmount")}
                      value={amount[r.id] ?? ""} onChange={(e) => setAmount({ ...amount, [r.id]: e.target.value })} lang={locale} />
                    <Button size="sm" disabled={busy !== null || (outsideNeeded[r.id] && !outsideConfirmed[r.id])} onClick={() => refund(r)}>
                      {busy === `${r.id}:refund` && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t("refund")}
                    </Button>
                  </div>
                )}
                {!r.refund_id && canAdmin && outsideNeeded[r.id] && (
                  <div className="space-y-1 rounded-md bg-muted p-2 text-xs">
                    <p>{t("refundOutsideNeeded")}</p>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-0.5 size-4" checked={outsideConfirmed[r.id] === true}
                        onChange={(e) => setOutsideConfirmed({ ...outsideConfirmed, [r.id]: e.target.checked })} />
                      <span>{t("refundOutsideConfirm")}</span>
                    </label>
                  </div>
                )}
                {canAdmin && (
                  <div className="flex flex-wrap gap-2">
                    {!r.refund_id && (
                      <Button size="sm" variant="outline" disabled={busy !== null}
                        onClick={() => act(r, { action: "close", restock: true }, t("closed"))}>{t("closeRestock")}</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy !== null}
                      onClick={() => act(r, { action: "close", restock: false }, t("closed"))}>{t("close")}</Button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
