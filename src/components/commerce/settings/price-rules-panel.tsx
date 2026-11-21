"use client";

/**
 * Commerce → Store settings: customer groups, wholesale price lists, discount rules, free gift
 * rules, loyalty points and customer balances (store plan Phase 8). Admins
 * edit; agents read (the APIs and RLS enforce the same rule). Money is typed
 * as a decimal and sent in integer minor units; percents are sent in basis
 * points. Every price is worked out on the server: nothing typed here is a
 * price a customer pays until the pricing engine applies it.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import { createClient } from "@/lib/data/client";
import { formatMoney, minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import type { CustomerGroupView, DiscountRuleView, GiftRuleView, PriceListView } from "@/lib/commerce/price-rules-store";
import type { ContactBalances, LoyaltySettingsView } from "@/lib/commerce/store-credit";
import { listSellableVariants, type SellableVariant } from "../orders/order-api";
import { storeApi } from "./settings-api";
import { useReportDirty } from "./section-dirty";
import { OptionSelect } from "@/components/commerce/option-select";
import { SegmentedControl } from "@/components/ui/segmented-control";

type Result<T> = { ok: true; value: T } | { ok: false; code?: string; error?: string };
type Option = { id: string; name: string };

async function call<T>(url: string, key: string, method = "GET", body?: unknown): Promise<Result<T>> {
  const res = await authFetch(url, method === "GET" ? { cache: "no-store" }
    : { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && json[key] !== undefined) return { ok: true, value: json[key] as T };
  return { ok: false, code: typeof json.code === "string" ? json.code : undefined, error: typeof json.error === "string" ? json.error : undefined };
}

const minor = (value: string, currency: string): number | null => {
  try {
    const n = parseMoney(value.trim(), currency);
    return n >= 0 ? n : null;
  } catch {
    return null;
  }
};
const text = (value: number | null, currency: string) => (value === null ? "" : minorToDecimalString(value, currency));
const percentBps = (value: string): number | null => {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value.trim())) return null;
  const bps = Math.round(Number(value) * 100);
  return bps >= 1 && bps <= 10_000 ? bps : null;
};
const iso = (local: string) => (local ? new Date(local).toISOString() : null);
const local = (value: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function Field({ id, label, help, children, wide }: { id: string; label: string; help?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`space-y-1 ${wide ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function Picker({ id, value, onChange, options, empty }: { id: string; value: string; onChange: (v: string) => void; options: Option[]; empty?: string }) {
  return (
    <OptionSelect
      id={id}
      className="w-full"
      value={value}
      onValueChange={onChange}
      options={[
        ...(empty !== undefined ? [{ value: "", label: empty }] : []),
        ...options.map((o) => ({ value: o.id, label: o.name })),
      ]}
    />
  );
}

interface Pickers { groups: Option[]; products: Option[]; categories: Option[]; variants: Option[] }
type ContactOption = { id: string; name: string | null; phone: string | null };

/** Contacts by name for a picker (the first 25), searched as the member types. */
function useContactSearch(search: string): ContactOption[] {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  useEffect(() => {
    let live = true;
    const term = search.trim().replace(/[%_,()]/g, "");
    const timer = setTimeout(() => {
      let q = createClient().from("contacts").select("id,name,phone").order("name").limit(25);
      if (term) q = q.ilike("name", `%${term}%`);
      void q.then(({ data }) => { if (live) setContacts((data ?? []) as ContactOption[]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search]);
  return contacts;
}

export function PriceRulesPanel({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const [lists, setLists] = useState<Omit<Pickers, "groups">>({ products: [], categories: [], variants: [] });
  const [groups, setGroups] = useState<CustomerGroupView[]>([]);
  const reloadGroups = useCallback(() => call<CustomerGroupView[]>("/api/commerce/customer-groups", "customer_groups")
    .then((r) => { if (r.ok) setGroups(r.value); }).catch(() => undefined), []);
  useEffect(() => { void reloadGroups(); }, [reloadGroups]);
  const pickers: Pickers = { ...lists, groups: groups.map((g) => ({ id: g.id, name: g.name })) };
  useEffect(() => {
    let live = true;
    void (async () => {
      const [products, categories, variants] = await Promise.all([
        storeApi.productNames().then((r) => (r.ok ? r.value : [])).catch(() => []),
        call<Option[]>("/api/commerce/shop/categories", "categories").then((r) => (r.ok ? r.value : [])).catch(() => []),
        listSellableVariants().then((r) => (r?.variants ?? []).map((v: SellableVariant) => ({ id: v.id, name: `${v.name} · ${v.sku}` }))).catch(() => []),
      ]);
      if (live) setLists({ products, categories, variants });
    })();
    return () => { live = false; };
  }, []);
  return (
    <>
      <CustomerGroups groups={groups} canEdit={canEdit} reload={reloadGroups} />
      <PriceLists currency={currency} canEdit={canEdit} pickers={pickers} />
      <DiscountRules currency={currency} canEdit={canEdit} pickers={pickers} />
      <GiftRules currency={currency} canEdit={canEdit} pickers={pickers} />
      <Loyalty currency={currency} canEdit={canEdit} />
      <Balances currency={currency} canEdit={canEdit} />
    </>
  );
}

/** List, toggle, delete and a draft form: the part the three rule cards share. */
function useRules<V extends { id: string }>(path: string, plural: string, singular: string) {
  const te = useTranslations("Commerce.settings.errors");
  const [rows, setRows] = useState<V[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = (r: Result<unknown>) => (r.ok ? "" : r.code ? te(r.code as never) : r.error ?? te("invalid"));
  const reload = useCallback(() => call<V[]>(`/api/commerce/${path}`, plural).then((r) => { if (r.ok) setRows(r.value); }).catch(() => undefined), [path, plural]);
  useEffect(() => { void reload(); }, [reload]);
  /** Create (no id) or replace; true when it saved. */
  async function save(id: string | null, body: Record<string, unknown> | null): Promise<boolean> {
    if (!body) { setError(te("invalid")); return false; }
    setBusy(true);
    setError(null);
    try {
      const r = id ? await call<V>(`/api/commerce/${path}/${encodeURIComponent(id)}`, singular, "PATCH", body) : await call<V>(`/api/commerce/${path}`, singular, "POST", body);
      if (!r.ok) {
        setError(errorText(r));
        if (r.code === "conflict") await reload();
        return false;
      }
      await reload();
      return true;
    } finally {
      setBusy(false);
    }
  }
  async function patch(id: string, body: Record<string, unknown>) {
    const r = await call<V>(`/api/commerce/${path}/${encodeURIComponent(id)}`, singular, "PATCH", body);
    if (!r.ok) toast.error(errorText(r));
    await reload();
  }
  async function remove(id: string) {
    const r = await call<true>(`/api/commerce/${path}/${encodeURIComponent(id)}`, "ok", "DELETE");
    if (!r.ok) toast.error(errorText(r));
    await reload();
  }
  return { rows, error, setError, busy, save, patch, remove };
}

function RuleRow({ title, detail, active, canEdit, onToggle, onEdit, onDelete }: {
  title: string; detail: string; active: boolean; canEdit: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const t = useTranslations("Commerce.priceRules");
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0"><span className="font-medium">{title}</span>{detail && ` · ${detail}`}</span>
      <span className="flex items-center gap-2">
        <label className="flex items-center gap-2"><Switch checked={active} disabled={!canEdit} onCheckedChange={onToggle} aria-label={t("active")} /> {t("active")}</label>
        {canEdit && (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>{t("edit")}</Button>
            <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={onDelete}><Trash2 className="size-4" aria-hidden /></Button>
          </>
        )}
      </span>
    </li>
  );
}

function DraftActions({ busy, error, onSave, onCancel }: { busy: boolean; error: string | null; onSave: () => void; onCancel: () => void }) {
  const t = useTranslations("Commerce.priceRules");
  return (
    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
      <Button size="sm" disabled={busy} onClick={onSave}>{t("save")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t("cancel")}</Button>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer groups (membership grants prices: admins only, enforced by the API and the database)

function CustomerGroups({ groups, canEdit, reload }: { groups: CustomerGroupView[]; canEdit: boolean; reload: () => Promise<void> }) {
  const t = useTranslations("Commerce.priceRules");
  const te = useTranslations("Commerce.settings.errors");
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [contactId, setContactId] = useState("");
  const [busy, setBusy] = useState(false);
  const contacts = useContactSearch(search);
  async function run(url: string, key: string, method: string, body?: unknown) {
    setBusy(true);
    try {
      const r = await call<unknown>(url, key, method, body);
      if (!r.ok) toast.error(r.code ? te(r.code as never) : r.error ?? te("invalid"));
      await reload();
      return r.ok;
    } finally {
      setBusy(false);
    }
  }
  const base = (id: string) => `/api/commerce/customer-groups/${encodeURIComponent(id)}`;
  return (
    <Card>
      <CardHeader><CardTitle>{t("groupsTitle")}</CardTitle><CardDescription>{t("groupsHelp")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {groups.length === 0 && <p className="text-sm text-muted-foreground">{t("noGroups")}</p>}
        <ul className="divide-y text-sm">
          {groups.map((g) => (
            <li key={g.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{g.name}</span> · {t("memberCount", { count: g.member_count })}</span>
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setOpen(open === g.id ? null : g.id); setContactId(""); }}>{open === g.id ? t("hideMembers") : t("showMembers")}</Button>
                  {canEdit && <Button size="icon" variant="ghost" disabled={busy} aria-label={t("delete")} onClick={() => void run(base(g.id), "ok", "DELETE")}><Trash2 className="size-4" aria-hidden /></Button>}
                </span>
              </div>
              {open === g.id && (
                <div className="space-y-2 rounded-md border p-3">
                  {g.members.length === 0 && <p className="text-muted-foreground">{t("noMembers")}</p>}
                  <ul className="space-y-1">
                    {g.members.map((m) => (
                      <li key={m.contact_id} className="flex items-center justify-between gap-2">
                        <span>{m.name || m.phone || m.contact_id.slice(0, 8)}</span>
                        {canEdit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(`${base(g.id)}/members`, "customer_group", "DELETE", { contact_id: m.contact_id })}>{t("removeMember")}</Button>}
                      </li>
                    ))}
                  </ul>
                  {canEdit && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <Input aria-label={t("searchCustomer")} placeholder={t("searchCustomer")} value={search} maxLength={80} onChange={(e) => setSearch(e.target.value)} />
                      <OptionSelect
                        className="w-full"
                        aria-label={t("customer")}
                        value={contactId}
                        onValueChange={(v) => setContactId(v)}
                        options={[
                          { value: "", label: t("chooseCustomer") },
                          ...contacts.map((c) => ({ value: c.id, label: c.name || c.phone || c.id.slice(0, 8) })),
                        ]}
                      />
                      <Button size="sm" disabled={busy || !contactId}
                        onClick={() => void run(`${base(g.id)}/members`, "customer_group", "POST", { contact_id: contactId }).then((ok) => { if (ok) setContactId(""); })}>{t("addMember")}</Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && groups.length < 20 && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run("/api/commerce/customer-groups", "customer_group", "POST", { name: name.trim() }).then((ok) => { if (ok) setName(""); }); }}>
            <Input aria-label={t("groupName")} placeholder={t("groupName")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="outline" size="sm" disabled={busy || !name.trim()}><Plus className="size-4" aria-hidden /> {t("addGroup")}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Price lists

interface ListDraft { id: string | null; version: number; name: string; group: string; active: boolean; prices: Array<{ variant: string; qty: string; price: string }> }

function PriceLists({ currency, canEdit, pickers }: { currency: string; canEdit: boolean; pickers: Pickers }) {
  const t = useTranslations("Commerce.priceRules");
  const api = useRules<PriceListView>("price-lists", "price_lists", "price_list");
  const [draft, setDraft] = useState<ListDraft | null>(null);
  useReportDirty("price-list", draft !== null);
  const set = (patch: Partial<ListDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const body = (d: ListDraft): Record<string, unknown> | null => {
    const prices = d.prices.map((p) => ({ variant_id: p.variant, min_qty: Number(p.qty), price_minor: minor(p.price, currency) }));
    if (!d.name.trim() || !d.group || prices.some((p) => !p.variant_id || !Number.isInteger(p.min_qty) || p.min_qty < 1 || p.min_qty > 99 || p.price_minor === null)) return null;
    return { name: d.name.trim(), group_id: d.group, active: d.active, prices, ...(d.id ? { expected_version: d.version } : {}) };
  };
  const stored = (l: PriceListView, active: boolean) => ({
    expected_version: l.version, name: l.name, group_id: l.group_id, active, prices: l.prices.map((p) => ({ variant_id: p.variant_id, min_qty: p.min_qty, price_minor: p.price_minor })),
  });
  // A variant on a saved list may be off sale now: keep it selectable by its stored name.
  const variantOptions = (d: ListDraft): Option[] => {
    const saved = api.rows.find((l) => l.id === d.id)?.prices ?? [];
    const extra = saved.filter((p) => !pickers.variants.some((v) => v.id === p.variant_id)).map((p) => ({ id: p.variant_id, name: `${p.variant_name ?? ""} · ${p.sku ?? ""}` }));
    return [...pickers.variants, ...extra.filter((e, i) => extra.findIndex((x) => x.id === e.id) === i)];
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t("listsTitle")}</CardTitle><CardDescription>{t("listsHelp")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {api.rows.length === 0 && <p className="text-sm text-muted-foreground">{t("noLists")}</p>}
        <ul className="divide-y text-sm">
          {api.rows.map((l) => (
            <RuleRow key={l.id} title={l.name} detail={`${l.group_name ?? t("groupMissing")} · ${t("priceCount", { count: l.prices.length })}`} active={l.active} canEdit={canEdit}
              onToggle={() => void api.patch(l.id, stored(l, !l.active))} onDelete={() => void api.remove(l.id)}
              onEdit={() => { api.setError(null); setDraft({
                id: l.id, version: l.version, name: l.name, group: l.group_id, active: l.active,
                prices: l.prices.map((p) => ({ variant: p.variant_id, qty: String(p.min_qty), price: text(p.price_minor, currency) })),
              }); }} />
          ))}
        </ul>
        {canEdit && !draft && api.rows.length < 20 && (
          <Button variant="outline" size="sm" onClick={() => { api.setError(null); setDraft({ id: null, version: 1, name: "", group: pickers.groups[0]?.id ?? "", active: true, prices: [] }); }}>
            <Plus className="size-4" aria-hidden /> {t("addList")}
          </Button>
        )}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="pl-name" label={t("name")}><Input id="pl-name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field id="pl-group" label={t("group")} help={t("groupHelp")}><Picker id="pl-group" value={draft.group} onChange={(group) => set({ group })} options={pickers.groups} empty={t("chooseGroup")} /></Field>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-sm font-medium">{t("prices")}</legend>
              {draft.prices.map((p, i) => {
                const change = (patch: Partial<ListDraft["prices"][number]>) => set({ prices: draft.prices.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="grid grid-cols-[1fr_5rem_7rem_auto] items-center gap-2">
                    <Picker id={`pl-v-${i}`} value={p.variant} onChange={(variant) => change({ variant })} options={variantOptions(draft)} empty={t("chooseVariant")} />
                    <Input aria-label={t("minQty")} type="number" min={1} max={99} value={p.qty} onChange={(e) => change({ qty: e.target.value })} />
                    <Input aria-label={t("price", { currency })} inputMode="decimal" placeholder={t("price", { currency })} value={p.price} onChange={(e) => change({ price: e.target.value })} />
                    <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={() => set({ prices: draft.prices.filter((_, j) => j !== i) })}><Trash2 className="size-4" aria-hidden /></Button>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">{t("pricesHelp")}</p>
              {draft.prices.length < 500 && (
                <Button variant="outline" size="sm" onClick={() => set({ prices: [...draft.prices, { variant: "", qty: "1", price: "" }] })}><Plus className="size-4" aria-hidden /> {t("addPrice")}</Button>
              )}
            </fieldset>
            <DraftActions busy={api.busy} error={api.error} onCancel={() => setDraft(null)}
              onSave={() => void api.save(draft.id, body(draft)).then((ok) => { if (ok) setDraft(null); })} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Discount rules

interface RuleDraft {
  id: string | null; version: number; name: string; target: "all" | "product" | "category"; product: string; category: string; group: string;
  kind: "percent" | "fixed"; value: string; combinable: boolean; active: boolean; startsAt: string; endsAt: string;
}
const blankRule: RuleDraft = {
  id: null, version: 1, name: "", target: "product", product: "", category: "", group: "", kind: "percent", value: "", combinable: true, active: true, startsAt: "", endsAt: "",
};

function DiscountRules({ currency, canEdit, pickers }: { currency: string; canEdit: boolean; pickers: Pickers }) {
  const t = useTranslations("Commerce.priceRules");
  const api = useRules<DiscountRuleView>("discount-rules", "discount_rules", "discount_rule");
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  useReportDirty("discount-rule", draft !== null);
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const body = (d: RuleDraft): Record<string, unknown> | null => {
    const value = d.kind === "percent" ? percentBps(d.value) : minor(d.value, currency);
    const product = d.target === "product" ? d.product : "", category = d.target === "category" ? d.category : "";
    if (!d.name.trim() || !value || (d.target === "product" && !product) || (d.target === "category" && !category) || (d.target === "all" && !d.group)) return null;
    return {
      name: d.name.trim(), product_id: product || null, category_id: category || null, group_id: d.group || null, kind: d.kind, value, combinable: d.combinable,
      active: d.active, starts_at: iso(d.startsAt), ends_at: iso(d.endsAt), ...(d.id ? { expected_version: d.version } : {}),
    };
  };
  const stored = (r: DiscountRuleView, active: boolean) => ({
    expected_version: r.version, name: r.name, product_id: r.product_id, category_id: r.category_id, group_id: r.group_id, kind: r.kind, value: r.value,
    combinable: r.combinable, active, starts_at: r.starts_at, ends_at: r.ends_at,
  });
  const describe = (r: DiscountRuleView) => [
    r.kind === "percent" ? t("percentOff", { percent: r.value / 100 }) : t("amountOffEach", { amount: formatMoney(r.value, currency) }),
    r.product_id ? r.product_name ?? "" : r.category_id ? r.category_name ?? "" : t("everyProduct"),
    r.group_id ? r.group_name ?? t("groupMissing") : t("everyone"),
    r.combinable ? t("combines") : t("doesNotCombine"),
  ].filter(Boolean).join(" · ");
  return (
    <Card>
      <CardHeader><CardTitle>{t("rulesTitle")}</CardTitle><CardDescription>{t("rulesHelp")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">{t("stackingOrder")}</p>
        {api.rows.length === 0 && <p className="text-sm text-muted-foreground">{t("noRules")}</p>}
        <ul className="divide-y text-sm">
          {api.rows.map((r) => (
            <RuleRow key={r.id} title={r.name} detail={describe(r)} active={r.active} canEdit={canEdit}
              onToggle={() => void api.patch(r.id, stored(r, !r.active))} onDelete={() => void api.remove(r.id)}
              onEdit={() => { api.setError(null); setDraft({
                id: r.id, version: r.version, name: r.name, target: r.product_id ? "product" : r.category_id ? "category" : "all", product: r.product_id ?? "",
                category: r.category_id ?? "", group: r.group_id ?? "", kind: r.kind, value: r.kind === "percent" ? String(r.value / 100) : text(r.value, currency),
                combinable: r.combinable, active: r.active, startsAt: local(r.starts_at), endsAt: local(r.ends_at),
              }); }} />
          ))}
        </ul>
        {canEdit && !draft && api.rows.length < 50 && (
          <Button variant="outline" size="sm" onClick={() => { api.setError(null); setDraft(blankRule); }}><Plus className="size-4" aria-hidden /> {t("addRule")}</Button>
        )}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="dr-name" label={t("name")}><Input id="dr-name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field id="dr-target" label={t("appliesTo")}>
              <SegmentedControl
                aria-label={t("appliesTo")}
                value={draft.target}
                onValueChange={(v) => set({ target: v as RuleDraft["target"] })}
                options={[
                  { value: "product", label: t("oneProduct") },
                  { value: "category", label: t("oneCategory") },
                  { value: "all", label: t("everyProduct") },
                ]}
              />
            </Field>
            {draft.target === "product" && (
              <Field id="dr-product" label={t("product")}><Picker id="dr-product" value={draft.product} onChange={(product) => set({ product })} options={pickers.products} empty={t("chooseProduct")} /></Field>
            )}
            {draft.target === "category" && (
              <Field id="dr-category" label={t("category")} help={t("categoryHelp")}>
                <Picker id="dr-category" value={draft.category} onChange={(category) => set({ category })} options={pickers.categories} empty={t("chooseCategory")} />
              </Field>
            )}
            <Field id="dr-group" label={t("customers")} help={draft.target === "all" ? t("customersNeeded") : t("groupHelp")}>
              <Picker id="dr-group" value={draft.group} onChange={(group) => set({ group })} options={pickers.groups} empty={t("everyone")} />
            </Field>
            <Field id="dr-kind" label={t("kind")}>
              <SegmentedControl
                aria-label={t("kind")}
                value={draft.kind}
                onValueChange={(v) => set({ kind: v as RuleDraft["kind"], value: "" })}
                options={[
                  { value: "percent", label: t("kindPercent") },
                  { value: "fixed", label: t("kindFixed", { currency }) },
                ]}
              />
            </Field>
            <Field id="dr-value" label={draft.kind === "percent" ? t("kindPercent") : t("kindFixed", { currency })}>
              <Input id="dr-value" inputMode="decimal" value={draft.value} onChange={(e) => set({ value: e.target.value })} />
            </Field>
            <Field id="dr-start" label={t("startsAt")}><Input id="dr-start" type="datetime-local" value={draft.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></Field>
            <Field id="dr-end" label={t("endsAt")}><Input id="dr-end" type="datetime-local" value={draft.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
            <div className="space-y-1 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm"><Switch checked={draft.combinable} onCheckedChange={(combinable) => set({ combinable })} /> {t("combinable")}</label>
              <p className="text-xs text-muted-foreground">{t("combinableHelp")}</p>
            </div>
            <DraftActions busy={api.busy} error={api.error} onCancel={() => setDraft(null)}
              onSave={() => void api.save(draft.id, body(draft)).then((ok) => { if (ok) setDraft(null); })} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Gift rules

interface GiftDraft { id: string | null; version: number; name: string; condition: "spend" | "product"; spend: string; product: string; gift: string; active: boolean }

function GiftRules({ currency, canEdit, pickers }: { currency: string; canEdit: boolean; pickers: Pickers }) {
  const t = useTranslations("Commerce.priceRules");
  const api = useRules<GiftRuleView>("gift-rules", "gift_rules", "gift_rule");
  const [draft, setDraft] = useState<GiftDraft | null>(null);
  useReportDirty("gift-rule", draft !== null);
  const set = (patch: Partial<GiftDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const body = (d: GiftDraft): Record<string, unknown> | null => {
    const spend = d.condition === "spend" ? minor(d.spend, currency) : null;
    if (!d.name.trim() || !d.gift || (d.condition === "spend" ? !spend : !d.product)) return null;
    return {
      name: d.name.trim(), min_subtotal_minor: spend, trigger_product_id: d.condition === "product" ? d.product : null, gift_variant_id: d.gift, active: d.active,
      ...(d.id ? { expected_version: d.version } : {}),
    };
  };
  const stored = (r: GiftRuleView, active: boolean) => ({
    expected_version: r.version, name: r.name, min_subtotal_minor: r.min_subtotal_minor, trigger_product_id: r.trigger_product_id, gift_variant_id: r.gift_variant_id,
    active, starts_at: r.starts_at, ends_at: r.ends_at,
  });
  const giftOptions = (d: GiftDraft): Option[] => {
    const saved = api.rows.find((r) => r.id === d.id);
    return saved && !pickers.variants.some((v) => v.id === saved.gift_variant_id) ? [...pickers.variants, { id: saved.gift_variant_id, name: saved.gift_name ?? "" }] : pickers.variants;
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t("giftsTitle")}</CardTitle><CardDescription>{t("giftsHelp")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {api.rows.length === 0 && <p className="text-sm text-muted-foreground">{t("noGifts")}</p>}
        <ul className="divide-y text-sm">
          {api.rows.map((r) => (
            <RuleRow key={r.id} title={r.name} active={r.active} canEdit={canEdit}
              detail={`${r.min_subtotal_minor !== null ? t("spendAtLeast", { amount: formatMoney(r.min_subtotal_minor, currency) }) : t("buyProduct", { product: r.trigger_product_name ?? "" })} → ${r.gift_name ?? ""}`}
              onToggle={() => void api.patch(r.id, stored(r, !r.active))} onDelete={() => void api.remove(r.id)}
              onEdit={() => { api.setError(null); setDraft({
                id: r.id, version: r.version, name: r.name, condition: r.min_subtotal_minor !== null ? "spend" : "product", spend: text(r.min_subtotal_minor, currency),
                product: r.trigger_product_id ?? "", gift: r.gift_variant_id, active: r.active,
              }); }} />
          ))}
        </ul>
        {canEdit && !draft && api.rows.length < 10 && (
          <Button variant="outline" size="sm" onClick={() => { api.setError(null); setDraft({ id: null, version: 1, name: "", condition: "spend", spend: "", product: "", gift: "", active: true }); }}>
            <Plus className="size-4" aria-hidden /> {t("addGift")}
          </Button>
        )}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="gr-name" label={t("name")} help={t("giftNameHelp")}><Input id="gr-name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field id="gr-condition" label={t("condition")}>
              <SegmentedControl
                aria-label={t("condition")}
                value={draft.condition}
                onValueChange={(v) => set({ condition: v as GiftDraft["condition"] })}
                options={[
                  { value: "spend", label: t("conditionSpend", { currency }) },
                  { value: "product", label: t("conditionProduct") },
                ]}
              />
            </Field>
            {draft.condition === "spend" ? (
              <Field id="gr-spend" label={t("conditionSpend", { currency })}><Input id="gr-spend" inputMode="decimal" value={draft.spend} onChange={(e) => set({ spend: e.target.value })} /></Field>
            ) : (
              <Field id="gr-product" label={t("product")}><Picker id="gr-product" value={draft.product} onChange={(product) => set({ product })} options={pickers.products} empty={t("chooseProduct")} /></Field>
            )}
            <Field id="gr-gift" label={t("giftVariant")} help={t("giftVariantHelp")}>
              <Picker id="gr-gift" value={draft.gift} onChange={(gift) => set({ gift })} options={giftOptions(draft)} empty={t("chooseVariant")} />
            </Field>
            <DraftActions busy={api.busy} error={api.error} onCancel={() => setDraft(null)}
              onSave={() => void api.save(draft.id, body(draft)).then((ok) => { if (ok) setDraft(null); })} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loyalty points

function Loyalty({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.priceRules");
  const te = useTranslations("Commerce.settings.errors");
  const [form, setForm] = useState<{ enabled: boolean; earnPoints: string; earnSpend: string; redeemValue: string; redeemMax: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = useCallback((s: LoyaltySettingsView) => setForm({
    enabled: s.enabled, earnPoints: String(s.earn_points), earnSpend: text(s.earn_spend_minor, currency), redeemValue: text(s.redeem_value_minor, currency),
    redeemMax: String(s.redeem_max_bps / 100),
  }), [currency]);
  useEffect(() => { void call<LoyaltySettingsView>("/api/commerce/loyalty", "loyalty").then((r) => { if (r.ok) show(r.value); }).catch(() => undefined); }, [show]);
  if (!form) return null;
  async function save() {
    if (!form) return;
    const earnSpend = minor(form.earnSpend, currency), redeemValue = minor(form.redeemValue, currency), redeemMax = percentBps(form.redeemMax);
    const earnPoints = Number(form.earnPoints);
    if (!earnSpend || !redeemValue || !redeemMax || !Number.isInteger(earnPoints) || earnPoints < 1 || earnPoints > 1000) return void toast.error(te("invalid"));
    setBusy(true);
    try {
      const r = await call<LoyaltySettingsView>("/api/commerce/loyalty", "loyalty", "PUT", {
        enabled: form.enabled, earn_points: earnPoints, earn_spend_minor: earnSpend, redeem_value_minor: redeemValue, redeem_max_bps: redeemMax,
      });
      if (!r.ok) return void toast.error(r.code ? te(r.code as never) : r.error ?? te("invalid"));
      show(r.value);
      toast.success(t("saved"));
    } finally {
      setBusy(false);
    }
  }
  const set = (patch: Partial<NonNullable<typeof form>>) => setForm((f) => (f ? { ...f, ...patch } : f));
  return (
    <Card>
      <CardHeader><CardTitle>{t("loyaltyTitle")}</CardTitle><CardDescription>{t("loyaltyHelp")}</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={form.enabled} disabled={!canEdit} onCheckedChange={(enabled) => set({ enabled })} /> {t("loyaltyEnabled")}</label>
        <Field id="lo-earn" label={t("earnPoints")}><Input id="lo-earn" type="number" min={1} max={1000} disabled={!canEdit} value={form.earnPoints} onChange={(e) => set({ earnPoints: e.target.value })} /></Field>
        <Field id="lo-spend" label={t("earnSpend", { currency })}><Input id="lo-spend" inputMode="decimal" disabled={!canEdit} value={form.earnSpend} onChange={(e) => set({ earnSpend: e.target.value })} /></Field>
        <Field id="lo-value" label={t("redeemValue", { currency })}><Input id="lo-value" inputMode="decimal" disabled={!canEdit} value={form.redeemValue} onChange={(e) => set({ redeemValue: e.target.value })} /></Field>
        <Field id="lo-max" label={t("redeemMax")}><Input id="lo-max" inputMode="decimal" disabled={!canEdit} value={form.redeemMax} onChange={(e) => set({ redeemMax: e.target.value })} /></Field>
        {canEdit && <div className="sm:col-span-2"><Button size="sm" disabled={busy} onClick={() => void save()}>{t("save")}</Button></div>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Customer balances

function Balances({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.priceRules");
  const te = useTranslations("Commerce.settings.errors");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const contacts = useContactSearch(search);
  const [contactId, setContactId] = useState("");
  const [balances, setBalances] = useState<ContactBalances | null>(null);
  const [ledger, setLedger] = useState<"credit" | "points">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((id: string) => {
    if (!id) return setBalances(null);
    void call<ContactBalances>(`/api/commerce/customer-balances?contact_id=${encodeURIComponent(id)}`, "balances").then((r) => setBalances(r.ok ? r.value : null)).catch(() => setBalances(null));
  }, []);
  useEffect(() => { load(contactId); setRequestId(crypto.randomUUID()); }, [contactId, load]);

  async function adjust() {
    // A signed amount: "-50" takes away. Credit is typed in the currency, points as a whole number.
    const negative = amount.trim().startsWith("-");
    const magnitude = ledger === "credit" ? minor(amount.trim().replace(/^[-+]/, ""), currency) : /^[-+]?\d{1,9}$/.test(amount.trim()) ? Math.abs(Number(amount)) : null;
    if (!magnitude || !reason.trim()) return void toast.error(te("invalid"));
    setBusy(true);
    try {
      const res = await authFetch("/api/commerce/customer-balances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, ledger, amount: negative ? -magnitude : magnitude, reason: reason.trim(), client_request_id: requestId }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      // A definite refusal wrote nothing; anything else keeps the id so a retry cannot adjust twice.
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) setRequestId(crypto.randomUUID());
        return void toast.error(json.code ? te(json.code as never) : json.error ?? te("invalid"));
      }
      setAmount("");
      setReason("");
      setRequestId(crypto.randomUUID());
      toast.success(t("adjusted"));
      load(contactId);
    } finally {
      setBusy(false);
    }
  }
  const when = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  return (
    <Card>
      <CardHeader><CardTitle>{t("balancesTitle")}</CardTitle><CardDescription>{t("balancesHelp")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="bal-search" label={t("searchCustomer")}><Input id="bal-search" value={search} maxLength={80} onChange={(e) => setSearch(e.target.value)} /></Field>
          <Field id="bal-contact" label={t("customer")}>
            <OptionSelect
              className="w-full"
              id="bal-contact"
              value={contactId}
              onValueChange={(v) => setContactId(v)}
              options={[
                { value: "", label: t("chooseCustomer") },
                ...contacts.map((c) => ({ value: c.id, label: c.name || c.phone || c.id.slice(0, 8) })),
              ]}
            />
          </Field>
        </div>
        {balances && (
          <>
            <p className="text-sm">
              <span className="font-medium">{t("storeCredit")}:</span> {formatMoney(balances.store_credit_minor, balances.currency ?? currency, locale)}
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="font-medium">{t("points")}:</span> {balances.points}
            </p>
            {balances.credit_entries.length + balances.point_entries.length === 0 && <p className="text-sm text-muted-foreground">{t("noEntries")}</p>}
            <ul className="divide-y text-sm">
              {balances.credit_entries.map((e, i) => (
                <li key={`c${i}`} className="flex justify-between gap-3 py-1.5">
                  <span>{t(`entryKinds.${e.kind}` as never)}{e.reason ? ` · ${e.reason}` : ""}<span className="block text-xs text-muted-foreground">{when(e.created_at)}</span></span>
                  <span className="tabular-nums">{e.amount < 0 ? "−" : "+"}{formatMoney(Math.abs(e.amount), balances.currency ?? currency, locale)}</span>
                </li>
              ))}
              {balances.point_entries.map((e, i) => (
                <li key={`p${i}`} className="flex justify-between gap-3 py-1.5">
                  <span>{t(`entryKinds.${e.kind}` as never)}{e.reason ? ` · ${e.reason}` : ""}<span className="block text-xs text-muted-foreground">{when(e.created_at)}</span></span>
                  <span className="tabular-nums">{t("pointsDelta", { points: `${e.amount < 0 ? "−" : "+"}${Math.abs(e.amount)}` })}</span>
                </li>
              ))}
            </ul>
            {canEdit && (
              <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <Field id="bal-ledger" label={t("adjustWhat")}>
                  <SegmentedControl
                    aria-label={t("adjustWhat")}
                    value={ledger}
                    onValueChange={(v) => { setLedger(v as "credit" | "points"); setAmount(""); }}
                    options={[
                      { value: "credit", label: t("storeCredit") },
                      { value: "points", label: t("points") },
                    ]}
                  />
                </Field>
                <Field id="bal-amount" label={ledger === "credit" ? t("adjustCredit", { currency }) : t("adjustPoints")} help={t("adjustHelp")}>
                  <Input id="bal-amount" inputMode="decimal" value={amount} maxLength={20} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field id="bal-reason" label={t("reason")} wide><Input id="bal-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
                <div className="sm:col-span-2"><Button size="sm" disabled={busy || !amount.trim() || !reason.trim()} onClick={() => void adjust()}>{t("adjust")}</Button></div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
