"use client";

/**
 * The store's core settings (one row, saved through PUT /api/commerce/settings) split across the settings sections. Each section
 * edits only its own fields and saves with one Save; the request still carries every field, the others as they are saved, so
 * what reaches the server is exactly what the single form sent before. Money is typed as a decimal and stored in minor units;
 * tax rates are typed as percent and stored in basis points. Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApprovedTemplates } from "@/components/flows/forms/use-pickers";
import { minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import { useReportDirty } from "./section-dirty";
import { Field, bpsToPercent, percentToBps, useErrorText } from "./settings-fields";
import { storeApi, type StoreSettings, type StoreSettingsInput } from "./settings-api";
import { OptionSelect } from "@/components/commerce/option-select";

export type CorePart = "general" | "checkout" | "taxes" | "notifications" | "advanced";

type Draft = { s: StoreSettings; tax: string; codFee: string; abandonedMinutes: string; abandonedOn: boolean };

function draftFrom(initial: StoreSettings): Draft {
  return {
    s: initial,
    tax: bpsToPercent(initial.default_tax_rate_bps),
    codFee: initial.currency && initial.cod_fee_minor ? minorToDecimalString(initial.cod_fee_minor, initial.currency) : "",
    abandonedMinutes: initial.abandoned_cart_delay_minutes === null ? "" : String(initial.abandoned_cart_delay_minutes),
    abandonedOn: initial.abandoned_cart_delay_minutes !== null,
  };
}

export function CoreSettingsForm({ part, initial, canEdit, onSaved }: {
  part: CorePart; initial: StoreSettings; canEdit: boolean; onSaved: (s: StoreSettings) => void;
}) {
  const t = useTranslations("Commerce.settings");
  const errorText = useErrorText();
  const [start] = useState(() => JSON.stringify(draftFrom(initial)));
  const [draft, setDraft] = useState(() => draftFrom(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { s, tax, codFee, abandonedMinutes, abandonedOn } = draft;
  useReportDirty(`core-${part}`, JSON.stringify(draft) !== start);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const set = <K extends keyof StoreSettings>(key: K) => (value: StoreSettings[K]) => setDraft((d) => ({ ...d, s: { ...d.s, [key]: value } }));
  const text = (key: "legal_name" | "gstin" | "address" | "state_code" | "storefront_title" | "document_prefix") => ({
    value: s[key] ?? "", disabled: !canEdit, onChange: (e: { target: { value: string } }) => set(key)(e.target.value),
  });
  const num = (key: "reservation_minutes" | "low_stock_default" | "return_window_days") => ({
    type: "number", value: String(s[key]), disabled: !canEdit, onChange: (e: { target: { value: string } }) => set(key)(Number(e.target.value)),
  });
  const bps = percentToBps(tax);

  // The COD fee is typed as a decimal in the store currency; empty means no fee.
  const codFeeMinor = (() => {
    if (!codFee.trim()) return 0;
    try {
      return s.currency ? parseMoney(codFee.trim(), s.currency.toUpperCase()) : NaN;
    } catch {
      return NaN;
    }
  })();

  const abandonedDelay = abandonedOn ? Number(abandonedMinutes) : null;
  const abandonedInvalid = abandonedDelay !== null && (!Number.isInteger(abandonedDelay) || abandonedDelay < 30 || abandonedDelay > 2880);

  async function save() {
    if (Number.isNaN(bps) || Number.isNaN(codFeeMinor) || abandonedInvalid) return setError(t("errors.invalid"));
    setSaving(true);
    setError(null);
    const input: StoreSettingsInput = {
      currency: (s.currency ?? "").toUpperCase(), prices_include_tax: s.prices_include_tax, default_tax_rate_bps: bps,
      reservation_minutes: s.reservation_minutes, checkout_enabled: s.checkout_enabled, low_stock_default: s.low_stock_default,
      legal_name: s.legal_name, gstin: s.gstin, address: s.address, state_code: s.state_code, document_prefix: s.document_prefix,
      storefront_title: s.storefront_title, return_window_days: s.return_window_days,
      checkout_template_name: s.checkout_template_name, checkout_template_language: s.checkout_template_language,
      cod_enabled: s.cod_enabled, cod_fee_minor: codFeeMinor,
      cod_confirm_enabled: s.cod_confirm_enabled, abandoned_cart_delay_minutes: abandonedDelay,
      review_requests_enabled: s.review_requests_enabled,
    };
    try {
      const r = await storeApi.saveSettings(input);
      if (r.ok) {
        toast.success(t("saved"));
        onSaved(r.value); // the screen remounts this form from the saved row
      } else setError(errorText(r));
    } catch {
      setError(t("errors.invalid"));
    } finally {
      setSaving(false);
    }
  }

  const switchRow = (checked: boolean, onChange: (v: boolean) => void, label: string, help?: string) => (
    <label className="flex min-h-11 items-start gap-3 text-sm">
      <Switch checked={checked} disabled={!canEdit} onCheckedChange={onChange} aria-label={label} />
      <span>
        <span className="block font-medium">{label}</span>
        {help && <span className="block text-xs text-muted-foreground">{help}</span>}
      </span>
    </label>
  );

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        {part === "general" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ss-title" label={t("storefrontTitle")}><Input id="ss-title" maxLength={120} {...text("storefront_title")} /></Field>
            <Field id="ss-currency" label={t("currency")} help={s.currency_locked ? t("currencyLocked") : t("currencyHelp")}>
              <Input id="ss-currency" maxLength={3} value={s.currency ?? ""} disabled={!canEdit || s.currency_locked}
                onChange={(e) => set("currency")(e.target.value.toUpperCase())} />
            </Field>
          </div>
        )}

        {part === "checkout" && (
          <>
            {switchRow(s.checkout_enabled, set("checkout_enabled"), t("checkoutEnabled"))}
            {s.checkout_enabled && !initial.online_payment_ready && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300" role="status">{t("razorpayMissing")}</p>
            )}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{t("cod.title")}</h3>
              {switchRow(s.cod_enabled, set("cod_enabled"), t("cod.enabled"), t("cod.help"))}
              <Field id="ss-cod-fee" label={t("cod.fee", { currency: s.currency ?? "" })} help={t("cod.feeHelp")}>
                <Input id="ss-cod-fee" inputMode="decimal" value={codFee} disabled={!canEdit || !s.currency} placeholder="0"
                  onChange={(e) => patch({ codFee: e.target.value })} aria-invalid={Number.isNaN(codFeeMinor)} />
              </Field>
              {switchRow(s.cod_confirm_enabled, set("cod_confirm_enabled"), t("cod.confirmEnabled"), t("cod.confirmHelp"))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ss-return" label={t("returnWindowDays")}><Input id="ss-return" min={0} max={90} {...num("return_window_days")} /></Field>
            </div>
            <CheckoutTemplateField value={s} canEdit={canEdit}
              onChange={(name, language) => setDraft((d) => ({ ...d, s: { ...d.s, checkout_template_name: name, checkout_template_language: language } }))} />
          </>
        )}

        {part === "taxes" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ss-tax" label={t("defaultTax")} help={t("defaultTaxHelp")}>
                <Input id="ss-tax" inputMode="decimal" value={tax} disabled={!canEdit} onChange={(e) => patch({ tax: e.target.value })} aria-invalid={Number.isNaN(bps)} />
              </Field>
            </div>
            {switchRow(s.prices_include_tax, set("prices_include_tax"), t("pricesIncludeTax"))}
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
          </>
        )}

        {part === "notifications" && (
          <>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{t("abandoned.title")}</h3>
              {switchRow(abandonedOn, (v) => patch({ abandonedOn: v, abandonedMinutes: v && !abandonedMinutes ? "60" : abandonedMinutes }),
                t("abandoned.enabled"), t("abandoned.help"))}
              {abandonedOn && (
                <Field id="ss-abandoned" label={t("abandoned.delay")} help={t("abandoned.delayHelp")}>
                  <Input id="ss-abandoned" inputMode="numeric" min={30} max={2880} value={abandonedMinutes} disabled={!canEdit}
                    onChange={(e) => patch({ abandonedMinutes: e.target.value })} aria-invalid={abandonedInvalid} />
                </Field>
              )}
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{t("reviewRequests.title")}</h3>
              {switchRow(s.review_requests_enabled, set("review_requests_enabled"), t("reviewRequests.enabled"), t("reviewRequests.help"))}
            </div>
          </>
        )}

        {part === "advanced" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ss-hold" label={t("reservationMinutes")} help={t("reservationHelp")}><Input id="ss-hold" min={15} max={60} {...num("reservation_minutes")} /></Field>
            <Field id="ss-low" label={t("lowStockDefault")}><Input id="ss-low" min={0} {...num("low_stock_default")} /></Field>
          </div>
        )}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {canEdit && (
          <Button className="min-h-11 sm:min-h-9" onClick={save} disabled={saving || !/^[A-Z]{3}$/.test(s.currency ?? "")}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** The checkout link template picker; only the Checkout section loads the approved templates. */
function CheckoutTemplateField({ value, canEdit, onChange }: {
  value: StoreSettings; canEdit: boolean; onChange: (name: string | null, language: string | null) => void;
}) {
  const t = useTranslations("Commerce.settings");
  const templates = useApprovedTemplates();
  const templateKey = value.checkout_template_name ? `${value.checkout_template_name}|${value.checkout_template_language ?? ""}` : "";
  return (
    <Field id="ss-template" label={t("checkoutTemplate")} help={t("checkoutTemplateHelp")}>
      <OptionSelect
        id="ss-template"
        className="w-full"
        disabled={!canEdit}
        value={templateKey}
        onValueChange={(key) => {
          const chosen = templates.find((x) => `${x.name}|${x.language ?? ""}` === key);
          onChange(chosen?.name ?? null, chosen?.language ?? null);
        }}
        options={[
          { value: "", label: t("noTemplate") },
          ...templates.map((x) => ({ value: `${x.name}|${x.language ?? ""}`, label: `${x.name}${x.language ? ` (${x.language})` : ""}` })),
        ]}
      />
    </Field>
  );
}
