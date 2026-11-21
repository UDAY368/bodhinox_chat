"use client";

/**
 * Order detail: edit an order before it is dispatched (Store Phase 5).
 *
 * The panel shows a balance left due by an edit (with the payment link to copy,
 * or why no link exists and a button to ask again) and the edits so far. The
 * dialog lets a team member change quantities, add catalogue items and remove
 * lines; only ids and quantities are sent. The server reprices and answers the
 * new totals and the payment difference BEFORE anything is saved; saving needs
 * a reason and that preview. A line cannot go below what has already shipped.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Loader2, Minus, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/format/money";
import {
  createEditBalanceLink, getOrderEditState, listSellableVariants, previewOrderEdit, saveOrderEdit,
  type OrderEditBody, type OrderEditPreview, type OrderEditState, type SellableVariant,
} from "./order-api";

const MAX_QTY = 99;
const REASON_MAX = 500;
/** Refusal codes with their own message; anything else shows the general one. */
const KNOWN_ERRORS = new Set([
  "conflict", "not_editable", "no_change", "cart_empty", "below_shipped", "out_of_stock", "payment_link_open", "refund_in_flight",
  "invoice_issued", "offline_payment", "amount_exceeds", "cod_shipment_live", "store_not_configured", "store_changed",
  "variant_unavailable", "price_not_configured", "tax_not_configured", "shipping_unavailable", "cod_unavailable", "coupon_min_subtotal",
  "forbidden",
]);

interface Line { variantId: string; name: string; qty: number; shipped: number; unitMinor: number; existing: boolean }

export function OrderEditPanel({ orderId, canEdit, onChanged }: {
  orderId: string;
  /** Agents and above (the server checks the permission again). */
  canEdit: boolean;
  /** Called after an edit is saved so the order reloads. */
  onChanged: () => void;
}) {
  const t = useTranslations("Commerce.orders.edit");
  const format = useFormatter();
  const locale = useLocale();
  const [state, setState] = useState<OrderEditState | null>(null);
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    const r = await getOrderEditState(orderId).catch(() => null);
    setState(r && r.ok ? r.value : null);
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);

  if (!state) return null;
  const money = (minor: number) => {
    return formatMoney(minor, state.currency, { locale });
  };
  const latest = state.edits[0];
  const showButton = canEdit && state.blocked !== "not_editable";
  if (!showButton && !state.edits.length) return null;

  const askLink = async () => {
    if (!latest) return;
    setLinking(true);
    try {
      const r = await createEditBalanceLink(orderId, latest.id);
      if (!r.ok || r.value === "link_failed") toast.error(t("balance.linkFailed"));
      else if (r.value === "link_unknown") toast.message(t("balance.linkUnknown"));
      else toast.success(t("balance.linkReady"));
      await load();
    } catch {
      toast.error(t("balance.linkFailed"));
    } finally {
      setLinking(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("balance.copied"));
    } catch {
      toast.error(t("balance.copyFailed"));
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{t("title")}</h2>
        {showButton && (
          <Button size="sm" variant="outline" disabled={state.blocked !== null} onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5" /> {t("open")}
          </Button>
        )}
      </div>
      {showButton && state.blocked && <p className="text-xs text-muted-foreground">{t(`blocked.${state.blocked}`)}</p>}

      {state.balance_due_minor > 0 && latest && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" role="status">
          <p className="font-medium text-foreground">{t("balance.due", { amount: money(state.balance_due_minor) })}</p>
          {latest.payment_link_url ? (
            <>
              <p className="text-xs text-muted-foreground">{t("balance.linkHelp")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{latest.payment_link_url}</code>
                <Button size="sm" variant="outline" onClick={() => void copy(latest.payment_link_url!)}>
                  <Copy className="h-3.5 w-3.5" /> {t("balance.copy")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {latest.payment_state === "link_unknown" ? t("balance.linkUnknown")
                  : latest.failure_code === "not_connected" ? t("balance.notConnected") : t("balance.noLink")}
              </p>
              {canEdit && (
                <Button size="sm" variant="outline" disabled={linking} onClick={() => void askLink()}>
                  {linking && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {t("balance.createLink")}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {state.edits.length > 0 && (
        <ul className="space-y-2">
          {state.edits.map((e) => (
            <li key={e.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
              <p className="text-foreground">
                {t("history.line", { before: money(e.total_before_minor), after: money(e.total_after_minor) })}
                {e.payment_action !== "none" && <span className="text-muted-foreground"> · {t(`history.payment.${e.payment_state}`, { amount: money(e.difference_minor) })}</span>}
              </p>
              <p className="text-xs break-words text-muted-foreground">
                {e.actor_name ?? t("history.someone")} · {format.dateTime(new Date(e.created_at), { dateStyle: "medium", timeStyle: "short" })} · {e.reason}
              </p>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <OrderEditDialog orderId={orderId} state={state} money={money} onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); void load(); onChanged(); }} onStale={() => { void load(); onChanged(); }} />
      )}
    </div>
  );
}

function OrderEditDialog({ orderId, state, money, onClose, onSaved, onStale }: {
  orderId: string;
  state: OrderEditState;
  money: (minor: number) => string;
  onClose: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const t = useTranslations("Commerce.orders.edit");
  const [lines, setLines] = useState<Line[]>(() => state.lines.filter((l) => l.variant_id).map((l) => ({
    variantId: l.variant_id!, name: l.name ?? l.sku ?? "", qty: l.quantity, shipped: l.shipped, unitMinor: l.unit_price_minor, existing: true,
  })));
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<SellableVariant[] | null>(null);
  const [preview, setPreview] = useState<OrderEditPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [outside, setOutside] = useState(false);
  const [busy, setBusy] = useState(false);
  // One id per dialog: a retried save of the same edit can never apply twice.
  const [requestId] = useState(() => crypto.randomUUID());
  const run = useRef(0);

  const changed = lines.length !== state.lines.length
    || lines.some((l) => state.lines.find((o) => o.variant_id === l.variantId)?.quantity !== l.qty);
  const body = useCallback((): OrderEditBody => ({
    expected_version: state.version, lines: lines.map((l) => ({ variant_id: l.variantId, qty: l.qty })),
    reason: reason.trim() || "-", client_request_id: requestId,
  }), [state.version, lines, reason, requestId]);
  const message = useCallback((code: string | undefined) => (code && KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.generic")), [t]);

  // The catalogue picker: published, priced variants by name or SKU.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void listSellableVariants(search).then((r) => { if (live) setOptions(r?.variants ?? []); }).catch(() => { if (live) setOptions([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search]);

  // The server's own preview of the new totals and the payment difference, a moment after the lines change.
  const linesKey = lines.map((l) => `${l.variantId}:${l.qty}`).join(",");
  useEffect(() => {
    const mine = ++run.current;
    setPreview(null);
    setError(null);
    setOutside(false);
    if (!changed || !lines.length) return;
    setChecking(true);
    const timer = setTimeout(() => {
      void previewOrderEdit(orderId, body()).then((r) => {
        if (mine !== run.current) return;
        if (r.ok) setPreview(r.value);
        else setError(message(r.code));
      }).catch(() => { if (mine === run.current) setError(message(undefined)); })
        .finally(() => { if (mine === run.current) setChecking(false); });
    }, 400);
    return () => clearTimeout(timer);
    // The reason is not part of the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, changed, orderId]);

  const setQty = (variantId: string, qty: number) => setLines((prev) => prev.map((l) => (l.variantId === variantId
    ? { ...l, qty: Math.min(MAX_QTY, Math.max(Math.max(1, l.shipped), qty)) } : l)));
  const add = (v: SellableVariant) => setLines((prev) => (prev.some((l) => l.variantId === v.id) ? prev
    : [...prev, { variantId: v.id, name: v.name, qty: 1, shipped: 0, unitMinor: v.price_minor, existing: false }]));
  const addable = (options ?? []).filter((v) => !lines.some((l) => l.variantId === v.id)).slice(0, 8);

  const needsOutside = preview?.payment.needs_outside_confirmation === true;
  const canSave = !!preview && !checking && !busy && reason.trim().length > 0 && (!needsOutside || outside);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const r = await saveOrderEdit(orderId, { ...body(), reason: reason.trim(), ...(needsOutside ? { refunded_outside: true } : {}) });
      if (!r.ok) {
        setError(message(r.code));
        // Someone else changed the order: reload it so the next edit starts from what is true now.
        if (r.code === "conflict") { toast.error(t("errors.conflict")); onStale(); onClose(); }
        return;
      }
      toast.success(r.value === "collect" ? t("savedCollect") : r.value === "refund" ? t("savedRefund") : t("saved"));
      onSaved();
    } catch {
      setError(message(undefined));
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<[string, number, number]> = preview ? ([
    [t("totals.subtotal"), preview.before.subtotal_minor, preview.after.subtotal_minor],
    [t("totals.discount"), -preview.before.discount_minor, -preview.after.discount_minor],
    [t("totals.shipping"), preview.before.shipping_minor, preview.after.shipping_minor],
    [t("totals.codFee"), preview.before.cod_fee_minor, preview.after.cod_fee_minor],
    [t("totals.tax"), preview.before.tax_minor, preview.after.tax_minor],
  ] as Array<[string, number, number]>).filter(([, a, b]) => a !== 0 || b !== 0) : [];
  const signed = (minor: number) => (minor < 0 ? `−${money(-minor)}` : money(minor));

  return (
    <Sheet open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <SheetContent size="md" className="w-full gap-0">
        <SheetHeader>
          <SheetTitle>{t("dialogTitle")}</SheetTitle>
          <SheetDescription>{t("dialogHelp")}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div className="space-y-4 text-sm">
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium">{t("items")}</legend>
            {lines.map((l) => (
              <div key={l.variantId} className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate font-medium text-foreground">{l.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {money(l.unitMinor)}{l.shipped > 0 ? ` · ${t("shipped", { count: l.shipped })}` : ""}{!l.existing ? ` · ${t("added")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="outline" size="icon-sm" aria-label={t("less", { name: l.name })}
                    disabled={l.qty <= Math.max(1, l.shipped)} onClick={() => setQty(l.variantId, l.qty - 1)}>
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Input aria-label={t("qty", { name: l.name })} type="number" inputMode="numeric" min={Math.max(1, l.shipped)} max={MAX_QTY} step={1}
                    className="h-8 w-16 text-center" value={l.qty}
                    onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n)) setQty(l.variantId, n); }} />
                  <Button type="button" variant="outline" size="icon-sm" aria-label={t("more", { name: l.name })}
                    disabled={l.qty >= MAX_QTY} onClick={() => setQty(l.variantId, l.qty + 1)}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove", { name: l.name })}
                    disabled={l.shipped > 0 || lines.length === 1} onClick={() => setLines((prev) => prev.filter((x) => x.variantId !== l.variantId))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="order-edit-add">{t("addItem")}</Label>
            <Input id="order-edit-add" placeholder={t("searchProducts")} value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
            {options === null && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {options !== null && addable.length === 0 && <p className="text-xs text-muted-foreground">{t("noProducts")}</p>}
            {addable.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {addable.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{v.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {money(v.price_minor)} · {v.available === null ? t("madeToOrder") : t("stock", { count: v.available })}
                      </span>
                    </span>
                    <Button type="button" size="sm" variant="outline" disabled={v.available !== null && v.available < 1} onClick={() => add(v)}>
                      <Plus className="h-3.5 w-3.5" /> {t("add")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 rounded-lg bg-muted px-3 py-2.5" aria-live="polite">
            {!changed && <p className="text-muted-foreground">{t("preview.none")}</p>}
            {changed && checking && !preview && !error && (
              <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t("preview.checking")}</p>
            )}
            {error && <p className="font-medium text-destructive" role="alert">{error}</p>}
            {preview && (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="text-left font-normal" scope="col"><span className="sr-only">{t("preview.row")}</span></th>
                      <th className="text-right font-normal" scope="col">{t("preview.before")}</th>
                      <th className="text-right font-normal" scope="col">{t("preview.after")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(([label, before, after]) => (
                      <tr key={label}>
                        <th className="text-left font-normal text-muted-foreground" scope="row">{label}</th>
                        <td className="text-right tabular-nums text-muted-foreground">{signed(before)}</td>
                        <td className="text-right tabular-nums">{signed(after)}</td>
                      </tr>
                    ))}
                    <tr>
                      <th className="text-left font-medium" scope="row">{t("totals.total")}</th>
                      <td className="text-right tabular-nums text-muted-foreground">{money(preview.before.total_minor)}</td>
                      <td className="text-right font-semibold tabular-nums">{money(preview.after.total_minor)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="font-medium text-foreground">
                  {preview.payment.action === "collect" ? t("preview.collect", { amount: money(preview.payment.difference_minor) })
                    : preview.payment.action === "refund" ? t("preview.refund", { amount: money(preview.payment.difference_minor) })
                    : t("preview.noPayment", { amount: money(preview.after.total_minor) })}
                </p>
              </>
            )}
          </div>

          {needsOutside && (
            <label className="flex items-start gap-2">
              <Checkbox className="mt-0.5" checked={outside} onCheckedChange={(v) => setOutside(v === true)} />
              <span>{t("refundedOutside", { amount: money(preview!.payment.difference_minor) })}</span>
            </label>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="order-edit-reason">{t("reason")}</Label>
            <Textarea id="order-edit-reason" rows={2} maxLength={REASON_MAX} required aria-required="true" value={reason}
              placeholder={t("reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        </div>
        <SheetFooter className="border-t border-border sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("confirm")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
