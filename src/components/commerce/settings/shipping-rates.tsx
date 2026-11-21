"use client";

/**
 * Store settings -> Shipping and delivery: the shipping rates list. Each rate is created or edited in its own draft and saved by
 * itself (a list, not a form). Money is typed as a decimal and stored in minor units; tax as percent, stored in basis points.
 * Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMoney } from "@/lib/format/money";
import { useReportDirty } from "./section-dirty";
import { Field, bpsToPercent, minorText, percentToBps, toMinor, useErrorText } from "./settings-fields";
import { storeApi, type ShippingRateView } from "./settings-api";

type RateDraft = { id: string | null; name: string; country: string; prefixes: string; min: string; max: string; fee: string; tax: string; active: boolean;
  states: string; baseWeight: string; step: string; extraStep: string; maxWeight: string; freeOver: string; cod: boolean };
const blankRate: RateDraft = { id: null, name: "", country: "IN", prefixes: "", min: "", max: "", fee: "", tax: "", active: true,
  states: "", baseWeight: "", step: "", extraStep: "", maxWeight: "", freeOver: "", cod: true };
/** Whole grams, or null for empty; NaN for anything else (the save check refuses it). */
const gramsOrNull = (v: string) => (v.trim() ? (/^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN) : null);

export function ShippingRates({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [rates, setRates] = useState<ShippingRateView[]>([]);
  const [draft, setDraft] = useState<RateDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => storeApi.rates().then((r) => r.ok && setRates(r.value)).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);
  useReportDirty("shipping-rate", draft !== null);

  async function save() {
    if (!draft) return;
    const input = {
      name: draft.name.trim(), country: draft.country.trim().toUpperCase(),
      postal_prefixes: draft.prefixes.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean),
      min_subtotal_minor: toMinor(draft.min, currency) ?? 0, max_subtotal_minor: toMinor(draft.max, currency),
      fee_minor: toMinor(draft.fee, currency) ?? NaN, tax_rate_bps: percentToBps(draft.tax), active: draft.active, position: 0,
      states: draft.states.split(",").map((p) => p.trim()).filter(Boolean),
      base_weight_grams: gramsOrNull(draft.baseWeight), step_grams: gramsOrNull(draft.step), extra_per_step_minor: toMinor(draft.extraStep, currency),
      max_weight_grams: gramsOrNull(draft.maxWeight), free_over_minor: toMinor(draft.freeOver, currency), cod_allowed: draft.cod,
    };
    if ([input.min_subtotal_minor, input.max_subtotal_minor, input.fee_minor, input.tax_rate_bps, input.base_weight_grams, input.step_grams,
      input.extra_per_step_minor, input.max_weight_grams, input.free_over_minor].some((v) => typeof v === "number" && Number.isNaN(v)))
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
                <span className="font-medium">{r.name}</span> · {r.country}{r.postal_prefixes.length ? ` · ${r.postal_prefixes.join(", ")}` : ""}{r.states.length ? ` · ${r.states.join(", ")}` : ""} ·{" "}
                {formatMoney(r.fee_minor, currency, { locale: "en" })}{r.active ? "" : ` · ${t("inactive")}`}
              </span>
              {canEdit && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDraft({
                    id: r.id, name: r.name, country: r.country, prefixes: r.postal_prefixes.join(", "), min: minorText(r.min_subtotal_minor, currency),
                    max: minorText(r.max_subtotal_minor, currency), fee: minorText(r.fee_minor, currency), tax: bpsToPercent(r.tax_rate_bps), active: r.active,
                    states: r.states.join(", "), baseWeight: r.base_weight_grams === null ? "" : String(r.base_weight_grams),
                    step: r.step_grams === null ? "" : String(r.step_grams), extraStep: minorText(r.extra_per_step_minor, currency),
                    maxWeight: r.max_weight_grams === null ? "" : String(r.max_weight_grams), freeOver: minorText(r.free_over_minor, currency), cod: r.cod_allowed,
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
            <Field id="sr-states" label={t("states")} help={t("statesHelp")}>
              <Input id="sr-states" value={draft.states} onChange={(e) => setDraft({ ...draft, states: e.target.value })} />
            </Field>
            <Field id="sr-fee" label={t("fee", { currency })}><Input id="sr-fee" inputMode="decimal" value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} /></Field>
            <Field id="sr-min" label={t("minSubtotal", { currency })}><Input id="sr-min" inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} /></Field>
            <Field id="sr-max" label={t("maxSubtotal", { currency })}><Input id="sr-max" inputMode="decimal" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} /></Field>
            <Field id="sr-base-weight" label={t("baseWeight")} help={t("weightHelp")}><Input id="sr-base-weight" inputMode="numeric" value={draft.baseWeight} onChange={(e) => setDraft({ ...draft, baseWeight: e.target.value })} /></Field>
            <Field id="sr-step" label={t("stepGrams")}><Input id="sr-step" inputMode="numeric" value={draft.step} onChange={(e) => setDraft({ ...draft, step: e.target.value })} /></Field>
            <Field id="sr-extra" label={t("extraPerStep", { currency })}><Input id="sr-extra" inputMode="decimal" value={draft.extraStep} onChange={(e) => setDraft({ ...draft, extraStep: e.target.value })} /></Field>
            <Field id="sr-max-weight" label={t("maxWeight")}><Input id="sr-max-weight" inputMode="numeric" value={draft.maxWeight} onChange={(e) => setDraft({ ...draft, maxWeight: e.target.value })} /></Field>
            <Field id="sr-free" label={t("freeOver", { currency })} help={t("freeOverHelp")}><Input id="sr-free" inputMode="decimal" value={draft.freeOver} onChange={(e) => setDraft({ ...draft, freeOver: e.target.value })} /></Field>
            <Field id="sr-tax" label={t("shippingTax")} help={t("shippingTaxHelp")}><Input id="sr-tax" inputMode="decimal" value={draft.tax} onChange={(e) => setDraft({ ...draft, tax: e.target.value })} /></Field>
            <label className="flex items-center gap-3 self-end text-sm">
              <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} aria-label={t("active")} /> {t("active")}
            </label>
            <label className="flex items-center gap-3 self-end text-sm">
              <Switch checked={draft.cod} onCheckedChange={(v) => setDraft({ ...draft, cod: v })} aria-label={t("codAllowed")} /> {t("codAllowed")}
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
