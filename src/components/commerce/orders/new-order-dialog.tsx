"use client";

/**
 * Sales → Orders → New order: pick a customer and catalogue products with
 * quantities and see a running total. Only ids and quantities are sent; the
 * server prices every line from the catalogue (tax included), holds the stock
 * and answers with the stored order. With "Send a payment link" ticked, the
 * order's link is then made and sent into the customer's chat through the
 * payment links API (its durable send path and the 24-hour window rule).
 */

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/data/client";
import { formatMoney } from "@/lib/commerce/money";
import { createManualOrder, listSellableVariants, type OrderDetail, type SellableVariant } from "./order-api";
import { sendOrderPaymentLink } from "./order-actions";
import { orderRef } from "./order-state";

const selectClass = "h-9 w-full min-w-0 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:ring-3 focus:ring-ring/30 disabled:opacity-60";
const MAX_QTY = 99;

interface Line { key: number; variantId: string; qty: string }
interface ContactOption { id: string; name: string | null; phone: string | null }

export function NewOrderDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (order: OrderDetail) => void;
}) {
  const t = useTranslations("Sales.orders.new");
  const tOrders = useTranslations("Sales.orders");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactId, setContactId] = useState("");
  const [catalogue, setCatalogue] = useState<{ variants: SellableVariant[]; currency: string | null } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState("");
  const [sendLink, setSendLink] = useState(true);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ contact?: string; lines?: string }>({});
  const [productSearch, setProductSearch] = useState("");
  /** Every variant seen in this dialog (the picker lists at most 100 per search), so a chosen line keeps its price. */
  const [known, setKnown] = useState<Map<string, SellableVariant>>(new Map());

  useEffect(() => {
    if (!open) return;
     
    setRequestId(crypto.randomUUID());
    setContactId("");
    setSearch("");
    setNote("");
    setSendLink(true);
    setErrors({});
    setCatalogue(null);
    setProductSearch("");
    setKnown(new Map());
     
    let live = true;
    void listSellableVariants().then((r) => {
      if (!live) return;
      const value = r ?? { variants: [], currency: null };
      setCatalogue(value);
      setKnown(new Map(value.variants.map((v) => [v.id, v])));
      setLines(value.variants[0] ? [{ key: 1, variantId: value.variants[0].id, qty: "1" }] : []);
    });
    return () => { live = false; };
  }, [open]);

  // Product search: narrows the picker on the server (name or SKU); lines already chosen keep their product.
  useEffect(() => {
    if (!open || catalogue === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void listSellableVariants(productSearch).then((r) => {
        if (!live || !r) return;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const v of r.variants) next.set(v.id, v);
          return next;
        });
        setCatalogue((prev) => (prev ? { variants: r.variants, currency: r.currency ?? prev.currency } : prev));
      });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the search text only
  }, [open, productSearch]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const term = search.trim().replace(/[%_,()]/g, "");
    const timer = setTimeout(() => {
      let q = createClient().from("contacts").select("id,name,phone").order("name").limit(25);
      if (term) q = q.ilike("name", `%${term}%`);
      void q.then(({ data }) => { if (live) setContacts((data ?? []) as ContactOption[]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [open, search]);

  const byId = known;
  const currency = catalogue?.currency ?? null;
  const qtyOf = (l: Line) => Math.min(Math.max(Math.floor(Number(l.qty) || 0), 0), MAX_QTY);
  const total = lines.reduce((sum, l) => sum + (byId.get(l.variantId)?.price_minor ?? 0) * qtyOf(l), 0);
  const money = (minor: number) => {
    if (!currency) return String(minor);
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };

  const update = (key: number, patch: Partial<Line>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, { key: Math.max(0, ...prev.map((l) => l.key)) + 1, variantId: catalogue?.variants[0]?.id ?? "", qty: "1" }]);

  async function submit() {
    const merged = new Map<string, number>();
    for (const l of lines) if (l.variantId && qtyOf(l) > 0) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + qtyOf(l));
    const short = [...merged].find(([id, qty]) => { const v = byId.get(id); return v && v.available !== null && qty > v.available; });
    const next = {
      contact: contactId ? undefined : t("needCustomer"),
      lines: merged.size === 0 ? t("needItems") : short ? t("errors.out_of_stock") : [...merged.values()].some((q) => q > MAX_QTY) ? t("errors.invalid") : undefined,
    };
    setErrors(next);
    if (next.contact || next.lines) return;
    setBusy(true);
    try {
      const r = await createManualOrder({
        contact_id: contactId, client_request_id: requestId, note: note.trim() || null,
        lines: [...merged].map(([variant_id, qty]) => ({ variant_id, qty })),
      });
      if (!r.ok) {
        const key = r.code && t.has(`errors.${r.code}`) ? `errors.${r.code}` : "errors.generic";
        toast.error(t(key));
        // A definite refusal made nothing; a new click may try again with a fresh id.
        if (r.status >= 400 && r.status < 500 && r.status !== 429) setRequestId(crypto.randomUUID());
        return;
      }
      const order = r.value;
      toast.success(t("created", { ref: orderRef(order) }));
      if (sendLink) {
        try {
          const outcome = await sendOrderPaymentLink(order, tOrders("linkDescription", { ref: orderRef(order) }), tOrders("linkFailed"));
          if (outcome.kind === "sent") toast.success(tOrders("linkSent"));
          else if (outcome.kind === "copied") toast.success(tOrders("linkNoChat"));
          else toast.error(tOrders("linkNotSent", { reason: outcome.reason || tOrders("linkFailed") }));
        } catch (err) {
          toast.error(err instanceof Error && err.message ? err.message : tOrders("linkFailed"));
        }
      }
      onOpenChange(false);
      onCreated(order);
    } catch {
      toast.error(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const noProducts = catalogue !== null && known.size === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("totalHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="new-order-customer-search">{t("customer")}</Label>
            <Input id="new-order-customer-search" placeholder={t("customerSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label={t("customer")} aria-invalid={!!errors.contact} className={selectClass} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">{t("chooseCustomer")}</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone || c.id.slice(0, 8)}</option>)}
            </select>
            {errors.contact && <p className="text-xs font-medium text-destructive">{errors.contact}</p>}
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium">{t("items")}</legend>
            {catalogue !== null && (
              <Input aria-label={t("productSearch")} placeholder={t("productSearch")} value={productSearch} maxLength={100}
                onChange={(e) => setProductSearch(e.target.value)} />
            )}
            {catalogue === null && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {noProducts && <p className="text-xs text-muted-foreground">{t("noProducts")}</p>}
            {lines.map((l) => {
              const v = byId.get(l.variantId);
              return (
                <div key={l.key} className="flex flex-wrap items-center gap-2">
                  <select aria-label={t("product")} className={`${selectClass} flex-1 basis-48`} value={l.variantId}
                    onChange={(e) => update(l.key, { variantId: e.target.value })}>
                    {v && !catalogue?.variants.some((opt) => opt.id === v.id) && (
                      <option value={v.id}>{v.name} · {money(v.price_minor)}</option>
                    )}
                    {catalogue?.variants.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.name} · {money(opt.price_minor)}</option>
                    ))}
                  </select>
                  <Input aria-label={t("qty")} type="number" inputMode="numeric" min={1} max={MAX_QTY} step={1} className="w-20 shrink-0"
                    value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeItem")} disabled={lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {v && (
                    <p className="basis-full text-xs text-muted-foreground">
                      {v.available === null ? t("madeToOrder") : t("stock", { count: v.available })} · {v.sku}
                    </p>
                  )}
                </div>
              );
            })}
            {!noProducts && catalogue !== null && (
              <Button type="button" variant="outline" size="sm" onClick={addLine}><Plus className="h-3.5 w-3.5" /> {t("addItem")}</Button>
            )}
            {errors.lines && <p className="text-xs font-medium text-destructive">{errors.lines}</p>}
          </fieldset>

          <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2.5">
            <span className="text-muted-foreground">{t("total")}</span>
            <strong className="tabular-nums" aria-live="polite">{money(total)}</strong>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-order-note">{t("note")}</Label>
            <Textarea id="new-order-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <label className="flex items-center gap-2">
            <Checkbox checked={sendLink} onCheckedChange={(v) => setSendLink(v === true)} />
            <span>{t("sendLink")}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tOrders("cancel")}</Button>
          <Button disabled={busy || noProducts || catalogue === null || !requestId} onClick={() => void submit()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
