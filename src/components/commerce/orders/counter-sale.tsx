"use client";

/**
 * Commerce → Orders → Counter sale (POS-lite). A phone-first screen for the shop counter: a customer (or the
 * walk-in), products found by name or SKU (a scanner that types the SKU and presses Enter adds it), quantities,
 * then cash or UPI. Only ids, quantities and the payment method are sent; the server prices the order from the
 * catalogue and records the payment the way "Record offline payment" does. The total shown while building is the
 * catalogue price; the server's total (price lists, discounts, tax) is shown on the finished sale.
 * An unpaid result (the order exists, the payment did not go through) keeps the same request id, so "Retry
 * payment" repeats the same call and nothing is sold or paid twice.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Banknote, CheckCircle2, Loader2, Minus, Plus, Smartphone, Trash2 } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/data/client";
import { formatMoney } from "@/lib/commerce/money";
import { createCounterSale, documentUrl, getOrderTimeline, listSellableVariants, type CounterSaleResult, type SellableVariant } from "./order-api";
import { orderRef } from "@/lib/commerce/order-state";

const MAX_QTY = 99;
type Method = "cash" | "upi";
interface ContactOption { id: string; name: string | null; phone: string | null }

export function CounterSale() {
  const t = useTranslations("Commerce.counter");
  const locale = useLocale();
  const canSell = useCan("edit-settings");
  const [requestId, setRequestId] = useState("");
  const [walkIn, setWalkIn] = useState(true);
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [results, setResults] = useState<SellableVariant[] | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [cart, setCart] = useState<Array<{ variant: SellableVariant; qty: number }>>([]);
  const [method, setMethod] = useState<Method>("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [sale, setSale] = useState<CounterSaleResult | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRequestId(crypto.randomUUID());
  }, []);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void listSellableVariants(productSearch).then((r) => {
        if (!live) return;
        setResults(r?.variants ?? []);
        if (r?.currency) setCurrency(r.currency);
      });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [productSearch]);

  useEffect(() => {
    if (walkIn) return;
    let live = true;
    const term = search.trim().replace(/[%_,()]/g, "");
    const timer = setTimeout(() => {
      let q = createClient().from("contacts").select("id,name,phone").order("name").limit(10);
      if (term) q = q.ilike("name", `%${term}%`);
      void q.then(({ data }) => { if (live) setContacts((data ?? []) as ContactOption[]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [walkIn, search]);

  // The receipt is issued by a background job just after the payment: look for it a few times.
  useEffect(() => {
    if (!sale?.paid) return;
    let live = true;
    let tries = 0;
    const look = () => {
      void getOrderTimeline(sale.order.id).then((tl) => {
        if (!live) return;
        const receipt = tl?.documents.find((d) => d.kind === "receipt");
        if (receipt) setReceiptId(receipt.id);
        else if (++tries < 6) setTimeout(look, 1500);
      });
    };
    look();
    return () => { live = false; };
  }, [sale]);

  const money = (minor: number, cur = currency) => {
    if (!cur) return String(minor);
    try { return formatMoney(minor, cur, locale); } catch { return `${cur} ${minor}`; }
  };
  const estimate = cart.reduce((n, l) => n + l.variant.price_minor * l.qty, 0);
  const room = (v: SellableVariant) => (v.available === null ? MAX_QTY : Math.min(MAX_QTY, v.available));

  const add = (v: SellableVariant) => {
    setCart((prev) => {
      const at = prev.findIndex((l) => l.variant.id === v.id);
      if (at < 0) return room(v) > 0 ? [...prev, { variant: v, qty: 1 }] : prev;
      return prev.map((l, i) => (i === at ? { ...l, qty: Math.min(l.qty + 1, room(v)) } : l));
    });
  };
  const setQty = (id: string, qty: number) =>
    setCart((prev) => prev.flatMap((l) => (l.variant.id !== id ? [l] : qty <= 0 ? [] : [{ ...l, qty: Math.min(qty, room(l.variant)) }])));

  // Scanner: it types the SKU and presses Enter. An exact SKU match (or the only result) goes straight in the cart.
  const onEnter = () => {
    const term = productSearch.trim().toLowerCase();
    if (!term || !results) return;
    const exact = results.find((v) => v.sku.toLowerCase() === term) ?? (results.length === 1 ? results[0] : null);
    if (exact) { add(exact); setProductSearch(""); }
  };

  const fresh = () => {
    setRequestId(crypto.randomUUID());
    setCart([]); setSale(null); setReceiptId(null); setReference(""); setProductSearch("");
    searchBox.current?.focus();
  };

  async function pay() {
    if (!requestId || busy || cart.length === 0 || (!walkIn && !contact)) return;
    setBusy(true);
    try {
      const r = await createCounterSale({
        contact_id: walkIn ? null : contact!.id, method, reference: reference.trim() || null, client_request_id: requestId,
        lines: cart.map((l) => ({ variant_id: l.variant.id, qty: l.qty })),
      });
      if (!r.ok) {
        toast.error(r.code && t.has(`errors.${r.code}`) ? t(`errors.${r.code}`) : t("errors.generic"));
        // A definite refusal made nothing; a new click may use a fresh id. An uncertain failure keeps its id (a replay is safe).
        if (r.status >= 400 && r.status < 500 && r.status !== 429) setRequestId(crypto.randomUUID());
        return;
      }
      setSale(r.value);
    } catch {
      toast.error(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (!canSell) return <p className="p-4 text-sm text-muted-foreground">{t("adminOnly")}</p>;

  if (sale) {
    const ref = orderRef(sale.order);
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 p-4">
        {sale.paid ? (
          <div className="space-y-3 rounded-xl border border-border bg-card p-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
            <h1 className="text-lg font-semibold">{t("paidTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("paidBody", { ref, total: money(sale.order.total_minor ?? sale.order.subtotal_minor, sale.order.currency), method: t(`method.${method}`) })}
            </p>
            <div className="flex flex-col gap-2">
              {receiptId && (
                <a className={buttonVariants({ variant: "outline" })} href={documentUrl(receiptId)} target="_blank" rel="noopener noreferrer">{t("openReceipt")}</a>
              )}
              <Link className={buttonVariants({ variant: "outline" })} href={`/commerce/orders/${sale.order.id}`}>{t("openOrder")}</Link>
            </div>
            {!receiptId && <p className="text-xs text-muted-foreground">{t("receiptPending")}</p>}
            <Button className="w-full" onClick={fresh}>{t("newSale")}</Button>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-destructive/40 bg-card p-4">
            <h1 className="text-lg font-semibold">{t("unpaidTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("unpaidBody", { ref })} {sale.paymentError && t.has(`paymentErrors.${sale.paymentError}`) ? t(`paymentErrors.${sale.paymentError}`) : t("paymentErrors.generic")}
            </p>
            <Button className="w-full" disabled={busy} onClick={() => void pay()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("retryPayment")}
            </Button>
            <Link className={buttonVariants({ variant: "outline", className: "w-full" })} href={`/commerce/orders/${sale.order.id}`}>{t("openOrder")}</Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-4 pb-28">
      <div>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <section className="space-y-2" aria-label={t("customer")}>
        <Label>{t("customer")}</Label>
        <div className="flex gap-2">
          <Button type="button" variant={walkIn ? "default" : "outline"} className="flex-1" onClick={() => setWalkIn(true)}>{t("walkIn")}</Button>
          <Button type="button" variant={walkIn ? "outline" : "default"} className="flex-1" onClick={() => setWalkIn(false)}>{t("namedCustomer")}</Button>
        </div>
        {!walkIn && (
          <div className="space-y-2">
            <Input aria-label={t("customerSearch")} placeholder={t("customerSearch")} value={search} onChange={(e) => setSearch(e.target.value)} />
            {contact && <p className="text-sm font-medium">{t("chosen", { name: contact.name || contact.phone || contact.id.slice(0, 8) })}</p>}
            <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {contacts.map((c) => (
                <li key={c.id}>
                  <button type="button" className="w-full px-3 py-2.5 text-left text-sm hover:bg-muted" onClick={() => setContact(c)}>
                    {c.name || c.phone || c.id.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-2" aria-label={t("products")}>
        <Label htmlFor="counter-product-search">{t("products")}</Label>
        <Input id="counter-product-search" ref={searchBox} autoFocus placeholder={t("productSearch")} maxLength={100} value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }} />
        {results === null && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {results !== null && results.length === 0 && <p className="text-sm text-muted-foreground">{t("noProducts")}</p>}
        <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {(results ?? []).map((v) => (
            <li key={v.id}>
              <button type="button" disabled={room(v) <= 0} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm hover:bg-muted disabled:opacity-50"
                onClick={() => add(v)}>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{v.name}</span>
                  <span className="block text-xs text-muted-foreground">{v.sku} · {v.available === null ? t("madeToOrder") : t("stock", { count: v.available })}</span>
                </span>
                <span className="shrink-0 tabular-nums">{money(v.price_minor)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2" aria-label={t("cart")}>
        <Label>{t("cart")}</Label>
        {cart.length === 0 && <p className="text-sm text-muted-foreground">{t("emptyCart")}</p>}
        {cart.map((l) => (
          <div key={l.variant.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{l.variant.name}</p>
              <p className="text-xs tabular-nums text-muted-foreground">{money(l.variant.price_minor)}</p>
            </div>
            <Button type="button" variant="outline" size="icon" aria-label={t("less")} onClick={() => setQty(l.variant.id, l.qty - 1)}><Minus className="h-4 w-4" /></Button>
            <span className="w-7 text-center text-sm tabular-nums" aria-live="polite">{l.qty}</span>
            <Button type="button" variant="outline" size="icon" aria-label={t("more")} disabled={l.qty >= room(l.variant)} onClick={() => setQty(l.variant.id, l.qty + 1)}><Plus className="h-4 w-4" /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label={t("remove")} onClick={() => setQty(l.variant.id, 0)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-label={t("payment")}>
        <Label>{t("payment")}</Label>
        <div className="flex gap-2">
          <Button type="button" variant={method === "cash" ? "default" : "outline"} className="flex-1" onClick={() => setMethod("cash")}><Banknote className="h-4 w-4" /> {t("method.cash")}</Button>
          <Button type="button" variant={method === "upi" ? "default" : "outline"} className="flex-1" onClick={() => setMethod("upi")}><Smartphone className="h-4 w-4" /> {t("method.upi")}</Button>
        </div>
        <Input aria-label={t("reference")} placeholder={method === "upi" ? t("referenceUpi") : t("reference")} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
      </section>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-background p-3">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t("estimate")}</p>
            <p className="text-lg font-semibold tabular-nums" aria-live="polite">{money(estimate)}</p>
          </div>
          <Button size="lg" className="h-11 px-6" disabled={busy || cart.length === 0 || (!walkIn && !contact) || !requestId} onClick={() => void pay()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("takePayment")}
          </Button>
        </div>
      </div>
    </div>
  );
}
