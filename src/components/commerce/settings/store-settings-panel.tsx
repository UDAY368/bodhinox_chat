"use client";

/**
 * Commerce → Store settings (design §6): currency, tax, reservation minutes,
 * checkout toggle, seller details, shipping rates, coupons and the order
 * notice templates (Phase 9). Admins edit;
 * agents read (the APIs and RLS enforce the same rule). Money is typed as a
 * decimal and stored in integer minor units; tax rates are typed as percent
 * and stored in basis points.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApprovedTemplates } from "@/components/flows/forms/use-pickers";
import { formatMoney, minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import { NoticeTemplates } from "./notice-templates";
import { storeApi, type ApiResult, type CouponView, type ShippingRateView, type StoreSettings, type StoreSettingsInput } from "./settings-api";

/** "18" or "12.5" percent -> basis points; null for empty; NaN when invalid. */
export function percentToBps(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return NaN;
  const [whole, fraction = ""] = v.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= 10000 ? bps : NaN;
}
export const bpsToPercent = (bps: number | null) => (bps === null ? "" : (bps / 100).toString());

function useErrorText() {
  const te = useTranslations("Commerce.settings.errors");
  return (r: ApiResult<unknown>) => (r.ok ? "" : r.code ? te(r.code as never) : r.error ?? te("invalid"));
}

export function StoreSettingsPanel() {
  const t = useTranslations("Commerce.settings");
  const canEdit = useCan("edit-settings");
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    storeApi.settings().then((r) => (r.ok ? setSettings(r.value) : setLoadError(true))).catch(() => setLoadError(true));
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {loadError && <p className="text-sm text-destructive" role="alert">{t("loadError")}</p>}
      {!settings && !loadError && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />}
      {settings && <GeneralForm initial={settings} canEdit={canEdit} onSaved={setSettings} />}
      {settings?.configured && settings.currency && <ShippingRates currency={settings.currency} canEdit={canEdit} />}
      {settings?.configured && settings.currency && <Coupons currency={settings.currency} canEdit={canEdit} />}
      {settings?.configured && <NoticeTemplates canEdit={canEdit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GeneralForm({ initial, canEdit, onSaved }: { initial: StoreSettings; canEdit: boolean; onSaved: (s: StoreSettings) => void }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const templates = useApprovedTemplates();
  const [s, setS] = useState(initial);
  const [tax, setTax] = useState(bpsToPercent(initial.default_tax_rate_bps));
  const [codFee, setCodFee] = useState(initial.currency && initial.cod_fee_minor ? minorToDecimalString(initial.cod_fee_minor, initial.currency) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof StoreSettings>(key: K) => (value: StoreSettings[K]) => setS((x) => ({ ...x, [key]: value }));
  const text = (key: "legal_name" | "gstin" | "address" | "state_code" | "storefront_title" | "document_prefix") => ({
    value: s[key] ?? "", disabled: !canEdit, onChange: (e: { target: { value: string } }) => set(key)(e.target.value),
  });
  const num = (key: "reservation_minutes" | "low_stock_default" | "return_window_days") => ({
    type: "number", value: String(s[key]), disabled: !canEdit, onChange: (e: { target: { value: string } }) => set(key)(Number(e.target.value)),
  });
  const bps = percentToBps(tax);
  const templateKey = s.checkout_template_name ? `${s.checkout_template_name}|${s.checkout_template_language ?? ""}` : "";

  // The COD fee is typed as a decimal in the store currency; empty means no fee.
  const codFeeMinor = (() => {
    if (!codFee.trim()) return 0;
    try {
      return s.currency ? parseMoney(codFee.trim(), s.currency.toUpperCase()) : NaN;
    } catch {
      return NaN;
    }
  })();

  async function save() {
    if (Number.isNaN(bps) || Number.isNaN(codFeeMinor)) return setError(t("errors.invalid"));
    setSaving(true);
    setError(null);
    const input: StoreSettingsInput = {
      currency: (s.currency ?? "").toUpperCase(), prices_include_tax: s.prices_include_tax, default_tax_rate_bps: bps,
      reservation_minutes: s.reservation_minutes, checkout_enabled: s.checkout_enabled, low_stock_default: s.low_stock_default,
      legal_name: s.legal_name, gstin: s.gstin, address: s.address, state_code: s.state_code, document_prefix: s.document_prefix,
      storefront_title: s.storefront_title, return_window_days: s.return_window_days,
      checkout_template_name: s.checkout_template_name, checkout_template_language: s.checkout_template_language,
      cod_enabled: s.cod_enabled, cod_fee_minor: codFeeMinor,
    };
    try {
      const r = await storeApi.saveSettings(input);
      if (r.ok) {
        onSaved(r.value);
        setS(r.value);
        toast.success(t("saved"));
      } else setError(errorText(r));
    } catch {
      setError(t("errors.invalid"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("generalTitle")}</CardTitle>
        <CardDescription>{t("generalHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={s.checkout_enabled} disabled={!canEdit} onCheckedChange={(v) => set("checkout_enabled")(v)} aria-label={t("checkoutEnabled")} />
          {t("checkoutEnabled")}
        </label>
        {s.checkout_enabled && !initial.online_payment_ready && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300" role="status">{t("razorpayMissing")}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ss-currency" label={t("currency")} help={s.currency_locked ? t("currencyLocked") : t("currencyHelp")}>
            <Input id="ss-currency" maxLength={3} value={s.currency ?? ""} disabled={!canEdit || s.currency_locked}
              onChange={(e) => set("currency")(e.target.value.toUpperCase())} />
          </Field>
          <Field id="ss-tax" label={t("defaultTax")} help={t("defaultTaxHelp")}>
            <Input id="ss-tax" inputMode="decimal" value={tax} disabled={!canEdit} onChange={(e) => setTax(e.target.value)} aria-invalid={Number.isNaN(bps)} />
          </Field>
          <label className="flex items-center gap-3 text-sm sm:col-span-2">
            <Switch checked={s.prices_include_tax} disabled={!canEdit} onCheckedChange={(v) => set("prices_include_tax")(v)} aria-label={t("pricesIncludeTax")} />
            {t("pricesIncludeTax")}
          </label>
          <Field id="ss-hold" label={t("reservationMinutes")} help={t("reservationHelp")}><Input id="ss-hold" min={15} max={60} {...num("reservation_minutes")} /></Field>
          <Field id="ss-low" label={t("lowStockDefault")}><Input id="ss-low" min={0} {...num("low_stock_default")} /></Field>
          <Field id="ss-return" label={t("returnWindowDays")}><Input id="ss-return" min={0} max={90} {...num("return_window_days")} /></Field>
          <Field id="ss-title" label={t("storefrontTitle")}><Input id="ss-title" maxLength={120} {...text("storefront_title")} /></Field>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("cod.title")}</h3>
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={s.cod_enabled} disabled={!canEdit} onCheckedChange={(v) => set("cod_enabled")(v)} aria-label={t("cod.enabled")} />
            <span>
              <span className="block font-medium">{t("cod.enabled")}</span>
              <span className="block text-xs text-muted-foreground">{t("cod.help")}</span>
            </span>
          </label>
          <Field id="ss-cod-fee" label={t("cod.fee", { currency: s.currency ?? "" })} help={t("cod.feeHelp")}>
            <Input id="ss-cod-fee" inputMode="decimal" value={codFee} disabled={!canEdit || !s.currency} placeholder="0"
              onChange={(e) => setCodFee(e.target.value)} aria-invalid={Number.isNaN(codFeeMinor)} />
          </Field>
        </div>
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">{t("sellerTitle")}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ss-legal" label={t("legalName")}><Input id="ss-legal" maxLength={200} {...text("legal_name")} /></Field>
            <Field id="ss-gstin" label={t("gstin")}><Input id="ss-gstin" maxLength={15} {...text("gstin")} /></Field>
            <Field id="ss-state" label={t("stateCode")} help={t("stateCodeHelp")}><Input id="ss-state" maxLength={2} {...text("state_code")} /></Field>
            <Field id="ss-prefix" label={t("documentPrefix")}><Input id="ss-prefix" maxLength={8} {...text("document_prefix")} /></Field>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ss-address">{t("sellerAddress")}</Label>
              <Textarea id="ss-address" maxLength={500} value={s.address ?? ""} disabled={!canEdit} onChange={(e) => set("address")(e.target.value)} />
            </div>
          </div>
        </div>
        <Field id="ss-template" label={t("checkoutTemplate")} help={t("checkoutTemplateHelp")}>
          <select id="ss-template" className="h-9 w-full rounded-md border bg-background px-2 text-sm" disabled={!canEdit} value={templateKey}
            onChange={(e) => {
              const chosen = templates.find((x) => `${x.name}|${x.language ?? ""}` === e.target.value);
              setS((x) => ({ ...x, checkout_template_name: chosen?.name ?? null, checkout_template_language: chosen?.language ?? null }));
            }}>
            <option value="">{t("noTemplate")}</option>
            {templates.map((x) => <option key={x.id} value={`${x.name}|${x.language ?? ""}`}>{x.name}{x.language ? ` (${x.language})` : ""}</option>)}
          </select>
        </Field>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {canEdit && (
          <Button onClick={save} disabled={saving || !/^[A-Z]{3}$/.test(s.currency ?? "")}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

const minorText = (minor: number | null, currency: string) => (minor === null ? "" : minorToDecimalString(minor, currency));
function toMinor(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  try {
    return parseMoney(value, currency);
  } catch {
    return NaN;
  }
}

// ---------------------------------------------------------------------------

type RateDraft = { id: string | null; name: string; country: string; prefixes: string; min: string; max: string; fee: string; tax: string; active: boolean };
const blankRate: RateDraft = { id: null, name: "", country: "IN", prefixes: "", min: "", max: "", fee: "", tax: "", active: true };

function ShippingRates({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [rates, setRates] = useState<ShippingRateView[]>([]);
  const [draft, setDraft] = useState<RateDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => storeApi.rates().then((r) => r.ok && setRates(r.value)).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (!draft) return;
    const input = {
      name: draft.name.trim(), country: draft.country.trim().toUpperCase(),
      postal_prefixes: draft.prefixes.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean),
      min_subtotal_minor: toMinor(draft.min, currency) ?? 0, max_subtotal_minor: toMinor(draft.max, currency),
      fee_minor: toMinor(draft.fee, currency) ?? NaN, tax_rate_bps: percentToBps(draft.tax), active: draft.active, position: 0,
    };
    if ([input.min_subtotal_minor, input.max_subtotal_minor, input.fee_minor, input.tax_rate_bps].some((v) => typeof v === "number" && Number.isNaN(v)))
      return setError(t("errors.invalid"));
    setBusy(true);
    setError(null);
    try {
      const r = draft.id ? await storeApi.updateRate(draft.id, input) : await storeApi.createRate(input);
      if (!r.ok) return setError(errorText(r));
      setDraft(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const r = await storeApi.deleteRate(id);
    if (!r.ok) toast.error(errorText(r));
    await reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("shippingTitle")}</CardTitle>
        <CardDescription>{t("shippingHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rates.length === 0 && <p className="text-sm text-muted-foreground">{t("noShipping")}</p>}
        <ul className="divide-y text-sm">
          {rates.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{r.name}</span> · {r.country}{r.postal_prefixes.length ? ` · ${r.postal_prefixes.join(", ")}` : ""} ·{" "}
                {formatMoney(r.fee_minor, currency)}{r.active ? "" : ` · ${t("inactive")}`}
              </span>
              {canEdit && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDraft({
                    id: r.id, name: r.name, country: r.country, prefixes: r.postal_prefixes.join(", "), min: minorText(r.min_subtotal_minor, currency),
                    max: minorText(r.max_subtotal_minor, currency), fee: minorText(r.fee_minor, currency), tax: bpsToPercent(r.tax_rate_bps), active: r.active,
                  })}>{t("edit")}</Button>
                  <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={() => remove(r.id)}><Trash2 className="size-4" aria-hidden /></Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canEdit && !draft && <Button variant="outline" size="sm" onClick={() => setDraft(blankRate)}><Plus className="size-4" aria-hidden /> {t("addShipping")}</Button>}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="sr-name" label={t("rateName")}><Input id="sr-name" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field id="sr-country" label={t("country")}><Input id="sr-country" maxLength={2} value={draft.country} onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })} /></Field>
            <Field id="sr-prefixes" label={t("postalPrefixes")} help={t("postalPrefixesHelp")}>
              <Input id="sr-prefixes" value={draft.prefixes} onChange={(e) => setDraft({ ...draft, prefixes: e.target.value })} />
            </Field>
            <Field id="sr-fee" label={t("fee", { currency })}><Input id="sr-fee" inputMode="decimal" value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} /></Field>
            <Field id="sr-min" label={t("minSubtotal", { currency })}><Input id="sr-min" inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} /></Field>
            <Field id="sr-max" label={t("maxSubtotal", { currency })}><Input id="sr-max" inputMode="decimal" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} /></Field>
            <Field id="sr-tax" label={t("shippingTax")} help={t("shippingTaxHelp")}><Input id="sr-tax" inputMode="decimal" value={draft.tax} onChange={(e) => setDraft({ ...draft, tax: e.target.value })} /></Field>
            <label className="flex items-center gap-3 self-end text-sm">
              <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} aria-label={t("active")} /> {t("active")}
            </label>
            {error && <p className="text-sm text-destructive sm:col-span-2" role="alert">{error}</p>}
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" onClick={save} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("save")}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null); }}>{t("cancel")}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

type CouponDraft = { code: string; kind: "percent" | "fixed"; value: string; min: string; maxDiscount: string; startsAt: string; endsAt: string;
  maxRedemptions: string; perContact: string };
const blankCoupon: CouponDraft = { code: "", kind: "percent", value: "", min: "", maxDiscount: "", startsAt: "", endsAt: "", maxRedemptions: "", perContact: "" };
const optInt = (v: string) => (v.trim() ? Number(v) : null);
const optDate = (v: string) => (v ? new Date(v).toISOString() : null);

function Coupons({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [coupons, setCoupons] = useState<CouponView[]>([]);
  const [draft, setDraft] = useState<CouponDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => storeApi.coupons().then((r) => r.ok && setCoupons(r.value)).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);

  const limits = (c: CouponView) => ({
    min_subtotal_minor: c.min_subtotal_minor, max_discount_minor: c.max_discount_minor, starts_at: c.starts_at, ends_at: c.ends_at,
    max_redemptions: c.max_redemptions, per_contact_limit: c.per_contact_limit,
  });

  async function create() {
    if (!draft) return;
    const value = draft.kind === "percent" ? percentToBps(draft.value) : toMinor(draft.value, currency);
    const input = {
      code: draft.code.trim().toUpperCase(), kind: draft.kind, value, min_subtotal_minor: toMinor(draft.min, currency) ?? 0,
      max_discount_minor: toMinor(draft.maxDiscount, currency), starts_at: optDate(draft.startsAt), ends_at: optDate(draft.endsAt),
      max_redemptions: optInt(draft.maxRedemptions), per_contact_limit: optInt(draft.perContact), active: true,
    };
    if ([value, input.min_subtotal_minor, input.max_discount_minor].some((v) => v === null ? false : Number.isNaN(v)) || value === null)
      return setError(t("errors.invalid"));
    setBusy(true);
    setError(null);
    try {
      const r = await storeApi.createCoupon(input);
      if (!r.ok) return setError(errorText(r));
      setDraft(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: CouponView) {
    const r = await storeApi.updateCoupon(c.id, { ...limits(c), active: !c.active });
    if (!r.ok) toast.error(errorText(r));
    await reload();
  }

  const describe = (c: CouponView) => (c.kind === "percent" ? `${c.value / 100}%` : formatMoney(c.value, currency));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("couponsTitle")}</CardTitle>
        <CardDescription>{t("couponsHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {coupons.length === 0 && <p className="text-sm text-muted-foreground">{t("noCoupons")}</p>}
        <ul className="divide-y text-sm">
          {coupons.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-mono font-medium">{c.code}</span> · {describe(c)} ·{" "}
                {t("redeemed", { count: c.redemptions, max: c.max_redemptions ?? "∞" })}
              </span>
              <label className="flex items-center gap-2">
                <Switch checked={c.active} disabled={!canEdit} onCheckedChange={() => toggle(c)} aria-label={t("active")} /> {t("active")}
              </label>
            </li>
          ))}
        </ul>
        {canEdit && !draft && <Button variant="outline" size="sm" onClick={() => setDraft(blankCoupon)}><Plus className="size-4" aria-hidden /> {t("addCoupon")}</Button>}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="cp-code" label={t("couponCode")}><Input id="cp-code" maxLength={32} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} /></Field>
            <Field id="cp-kind" label={t("couponKind")}>
              <select id="cp-kind" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as "percent" | "fixed" })}>
                <option value="percent">{t("kindPercent")}</option>
                <option value="fixed">{t("kindFixed", { currency })}</option>
              </select>
            </Field>
            <Field id="cp-value" label={t("couponValue")}><Input id="cp-value" inputMode="decimal" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /></Field>
            <Field id="cp-min" label={t("minSubtotal", { currency })}><Input id="cp-min" inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} /></Field>
            <Field id="cp-maxd" label={t("maxDiscount", { currency })}><Input id="cp-maxd" inputMode="decimal" value={draft.maxDiscount} onChange={(e) => setDraft({ ...draft, maxDiscount: e.target.value })} /></Field>
            <Field id="cp-maxr" label={t("maxRedemptions")}><Input id="cp-maxr" type="number" min={1} value={draft.maxRedemptions} onChange={(e) => setDraft({ ...draft, maxRedemptions: e.target.value })} /></Field>
            <Field id="cp-per" label={t("perContactLimit")}><Input id="cp-per" type="number" min={1} value={draft.perContact} onChange={(e) => setDraft({ ...draft, perContact: e.target.value })} /></Field>
            <Field id="cp-start" label={t("startsAt")}><Input id="cp-start" type="datetime-local" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} /></Field>
            <Field id="cp-end" label={t("endsAt")}><Input id="cp-end" type="datetime-local" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} /></Field>
            {error && <p className="text-sm text-destructive sm:col-span-2" role="alert">{error}</p>}
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" onClick={create} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("save")}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null); }}>{t("cancel")}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
