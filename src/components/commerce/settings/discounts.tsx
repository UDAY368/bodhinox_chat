"use client";

/**
 * Store settings -> Discounts and pricing: coupons and automatic discounts (store plan Phase 3, applied by the server at checkout
 * with no code). Each is created or edited in its own draft and saved by itself. Admins edit; agents read (the APIs and RLS
 * enforce the same rule).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMoney } from "@/lib/commerce/money";
import { useReportDirty } from "./section-dirty";
import { Field, bpsToPercent, minorText, percentToBps, toMinor, useErrorText } from "./settings-fields";
import { storeApi, type AutoDiscountView, type CouponView } from "./settings-api";
import { OptionSelect } from "@/components/commerce/option-select";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl } from "@/components/ui/segmented-control";

type CouponDraft = { code: string; kind: "percent" | "fixed"; value: string; min: string; maxDiscount: string; startsAt: string; endsAt: string;
  maxRedemptions: string; perContact: string };
const blankCoupon: CouponDraft = { code: "", kind: "percent", value: "", min: "", maxDiscount: "", startsAt: "", endsAt: "", maxRedemptions: "", perContact: "" };
const optInt = (v: string) => (v.trim() ? Number(v) : null);
const optDate = (v: string) => (v ? new Date(v).toISOString() : null);

export function Coupons({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [coupons, setCoupons] = useState<CouponView[]>([]);
  const [draft, setDraft] = useState<CouponDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => storeApi.coupons().then((r) => r.ok && setCoupons(r.value)).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);
  useReportDirty("coupon", draft !== null);

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
              <SegmentedControl
                aria-label={t("couponKind")}
                value={draft.kind}
                onValueChange={(v) => setDraft({ ...draft, kind: v as "percent" | "fixed" })}
                options={[
                  { value: "percent", label: t("kindPercent") },
                  { value: "fixed", label: t("kindFixed", { currency }) },
                ]}
              />
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

// ---------------------------------------------------------------------------
// Automatic discounts (store plan Phase 3): applied by the server at checkout with no code.

type AutoKind = AutoDiscountView["kind"];
const AUTO_KINDS: AutoKind[] = ["amount_off_over", "percent_off_over", "free_shipping_over", "buy_x_get_y", "prepaid"];
type AutoDraft = {
  id: string | null; version: number; name: string; kind: AutoKind; min: string; amount: string; percent: string; buy: string; get: string;
  products: string[]; active: boolean; startsAt: string; endsAt: string;
};
const blankAuto: AutoDraft = {
  id: null, version: 1, name: "", kind: "percent_off_over", min: "", amount: "", percent: "", buy: "2", get: "1", products: [], active: true,
  startsAt: "", endsAt: "",
};
/** An ISO time as the local value a datetime-local input takes. */
function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The API body for a draft, or null when a field is not valid. Each kind sends only its own fields. */
export function autoDiscountBody(draft: AutoDraft, currency: string): Record<string, unknown> | null {
  const min = toMinor(draft.min, currency) ?? 0;
  const amount = toMinor(draft.amount, currency), percent = percentToBps(draft.percent);
  const wantsAmount = draft.kind === "amount_off_over" || (draft.kind === "prepaid" && amount !== null);
  const wantsPercent = draft.kind === "percent_off_over" || (draft.kind === "prepaid" && !wantsAmount);
  const buy = Number(draft.buy), get = Number(draft.get);
  if (!draft.name.trim() || Number.isNaN(min)) return null;
  if (wantsAmount && (amount === null || Number.isNaN(amount) || amount < 1)) return null;
  if (wantsPercent && (percent === null || Number.isNaN(percent) || percent < 1)) return null;
  if (draft.kind === "prepaid" && amount !== null && percent !== null) return null;
  if (draft.kind === "buy_x_get_y" && ![buy, get].every((n) => Number.isInteger(n) && n >= 1 && n <= 20)) return null;
  return {
    name: draft.name.trim(), kind: draft.kind, min_subtotal_minor: min, active: draft.active,
    starts_at: optDate(draft.startsAt), ends_at: optDate(draft.endsAt),
    ...(wantsAmount ? { amount_minor: amount } : {}), ...(wantsPercent ? { percent_bps: percent } : {}),
    ...(draft.kind === "buy_x_get_y" ? { buy_qty: buy, get_qty: get, product_ids: draft.products } : {}),
  };
}

export function AutoDiscounts({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [rules, setRules] = useState<AutoDiscountView[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<AutoDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => storeApi.autoDiscounts().then((r) => r.ok && setRules(r.value)).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);
  useReportDirty("auto-discount", draft !== null);
  useEffect(() => {
    if (canEdit) storeApi.productNames().then((r) => r.ok && setProducts(r.value)).catch(() => undefined);
  }, [canEdit]);

  const body = (r: AutoDiscountView, active: boolean) => ({
    expected_version: r.version, name: r.name, kind: r.kind, min_subtotal_minor: r.min_subtotal_minor, active, starts_at: r.starts_at, ends_at: r.ends_at,
    ...(r.amount_minor !== null ? { amount_minor: r.amount_minor } : {}), ...(r.percent_bps !== null ? { percent_bps: r.percent_bps } : {}),
    ...(r.kind === "buy_x_get_y" ? { buy_qty: r.buy_qty, get_qty: r.get_qty, product_ids: r.product_ids } : {}),
  });

  async function save() {
    if (!draft) return;
    const input = autoDiscountBody(draft, currency);
    if (!input) return setError(t("errors.invalid"));
    setBusy(true);
    setError(null);
    try {
      const r = draft.id ? await storeApi.updateAutoDiscount(draft.id, { ...input, expected_version: draft.version }) : await storeApi.createAutoDiscount(input);
      if (!r.ok) {
        setError(errorText(r));
        if (r.code === "conflict") await reload();
        return;
      }
      setDraft(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }
  async function toggle(r: AutoDiscountView) {
    const res = await storeApi.updateAutoDiscount(r.id, body(r, !r.active));
    if (!res.ok) toast.error(errorText(res));
    await reload();
  }
  async function remove(id: string) {
    const res = await storeApi.deleteAutoDiscount(id);
    if (!res.ok) toast.error(errorText(res));
    await reload();
  }

  const describe = (r: AutoDiscountView) => {
    const what = r.kind === "buy_x_get_y" ? `${r.buy_qty} + ${r.get_qty}`
      : r.percent_bps !== null ? `${r.percent_bps / 100}%` : r.amount_minor !== null ? formatMoney(r.amount_minor, currency) : "";
    const over = r.min_subtotal_minor > 0 ? t("autoOver", { amount: formatMoney(r.min_subtotal_minor, currency) }) : "";
    return [t(`autoKinds.${r.kind}`), what, over].filter(Boolean).join(" · ");
  };
  const set = (patch: Partial<AutoDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("autoTitle")}</CardTitle>
        <CardDescription>{t("autoHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rules.length === 0 && <p className="text-sm text-muted-foreground">{t("noAuto")}</p>}
        <ul className="divide-y text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0"><span className="font-medium">{r.name}</span> · {describe(r)}</span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-2">
                  <Switch checked={r.active} disabled={!canEdit} onCheckedChange={() => toggle(r)} aria-label={t("active")} /> {t("active")}
                </label>
                {canEdit && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => { setError(null); setDraft({
                      id: r.id, version: r.version, name: r.name, kind: r.kind, min: r.min_subtotal_minor ? minorText(r.min_subtotal_minor, currency) : "",
                      amount: minorText(r.amount_minor, currency), percent: bpsToPercent(r.percent_bps), buy: String(r.buy_qty ?? 2), get: String(r.get_qty ?? 1),
                      products: r.product_ids, active: r.active, startsAt: localInput(r.starts_at), endsAt: localInput(r.ends_at),
                    }); }}>{t("edit")}</Button>
                    <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={() => remove(r.id)}><Trash2 className="size-4" aria-hidden /></Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {canEdit && !draft && rules.length < 20 && (
          <Button variant="outline" size="sm" onClick={() => { setError(null); setDraft(blankAuto); }}><Plus className="size-4" aria-hidden /> {t("addAuto")}</Button>
        )}
        {draft && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field id="ad-name" label={t("autoName")}><Input id="ad-name" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field id="ad-kind" label={t("autoKind")}>
              <OptionSelect
                id="ad-kind"
                value={draft.kind}
                onValueChange={(v) => set({ kind: v as AutoKind })}
                className="w-full"
                options={[
                  ...AUTO_KINDS.map((k) => ({ value: k, label: t(`autoKinds.${k}`) })),
                ]}
              />
            </Field>
            {(draft.kind === "amount_off_over" || draft.kind === "prepaid") && (
              <Field id="ad-amount" label={t("autoAmount", { currency })} help={draft.kind === "prepaid" ? t("autoPrepaidHelp") : undefined}>
                <Input id="ad-amount" inputMode="decimal" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} />
              </Field>
            )}
            {(draft.kind === "percent_off_over" || draft.kind === "prepaid") && (
              <Field id="ad-percent" label={t("autoPercent")}>
                <Input id="ad-percent" inputMode="decimal" value={draft.percent} onChange={(e) => set({ percent: e.target.value })} />
              </Field>
            )}
            {draft.kind === "buy_x_get_y" && (
              <>
                <Field id="ad-buy" label={t("buyQty")}><Input id="ad-buy" type="number" min={1} max={20} value={draft.buy} onChange={(e) => set({ buy: e.target.value })} /></Field>
                <Field id="ad-get" label={t("getQty")}><Input id="ad-get" type="number" min={1} max={20} value={draft.get} onChange={(e) => set({ get: e.target.value })} /></Field>
              </>
            )}
            <Field id="ad-min" label={t("minSubtotal", { currency })}><Input id="ad-min" inputMode="decimal" value={draft.min} onChange={(e) => set({ min: e.target.value })} /></Field>
            <Field id="ad-start" label={t("startsAt")}><Input id="ad-start" type="datetime-local" value={draft.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></Field>
            <Field id="ad-end" label={t("endsAt")}><Input id="ad-end" type="datetime-local" value={draft.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
            {draft.kind === "buy_x_get_y" && (
              <fieldset className="space-y-1 sm:col-span-2">
                <legend className="text-sm font-medium">{t("autoProducts")}</legend>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                  {products.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={draft.products.includes(p.id)}
                        onCheckedChange={(checked) => set({ products: checked ? [...draft.products, p.id].slice(0, 50) : draft.products.filter((id) => id !== p.id) })} />
                      {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
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
