"use client";

/**
 * Commerce → Settings → Buyer self-service (store plan Phase 8): whether buyers can ask for a return or exchange from their order
 * page (staff still approve), whether wishlist buyers get a WhatsApp nudge when a price drops (consent and template rules are
 * enforced on the server), and the checkout extras: order note, gift message, delivery date with lead days and time slots, and up
 * to five custom fields. Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CUSTOM_FIELD_TYPES, EXTRAS_LIMITS } from "@/lib/commerce/checkout-extras-limits";
import type { CustomField } from "@/lib/commerce/checkout-extras";
import type { BuyerSettings } from "@/lib/commerce/buyer-settings";
import { useReportDirty } from "./section-dirty";
import { OptionSelect } from "@/components/commerce/option-select";

const newId = () => Math.random().toString(36).slice(2, 8);

export function BuyerSettingsPanel({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Commerce.settings.buyer");
  const te = useTranslations("Commerce.settings.errors");
  const [settings, setSettings] = useState<BuyerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useReportDirty("buyer-settings", saved !== null && JSON.stringify(settings) !== saved);
  const load = (s: BuyerSettings) => { setSettings(s); setSaved(JSON.stringify(s)); };

  useEffect(() => {
    authFetch("/api/commerce/buyer-settings", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const loaded = ((await res.json()) as { settings: BuyerSettings }).settings;
        setSettings(loaded);
        setSaved(JSON.stringify(loaded));
      })
      .catch(() => undefined);
  }, []);
  if (!settings) return null;
  const set = (patch: Partial<BuyerSettings>) => setSettings({ ...settings, ...patch });
  const setField = (id: string, patch: Partial<CustomField>) => set({ custom_fields: settings.custom_fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const save = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/buyer-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { settings?: BuyerSettings; code?: string };
    if (!res?.ok || !data.settings) {
      toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid"));
      return;
    }
    load(data.settings);
    toast.success(t("saved"));
  };

  const toggle = (id: string, label: string, hint: string | null, checked: boolean, onChange: (v: boolean) => void) => (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} disabled={!canEdit} onCheckedChange={(v) => onChange(v === true)} />
      <div>
        <Label htmlFor={id} className="text-sm font-medium leading-snug">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );

  return (
    <Card id="buyer-self-service">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          {toggle("bs-returns", t("returns"), t("returnsHint"), settings.buyer_returns_enabled, (v) => set({ buyer_returns_enabled: v }))}
          {toggle("bs-nudges", t("nudges"), t("nudgesHint"), settings.price_drop_nudges_enabled, (v) => set({ price_drop_nudges_enabled: v }))}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("extrasTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("extrasHint")}</p>
          {toggle("bs-note", t("note"), null, settings.note_enabled, (v) => set({ note_enabled: v }))}
          {toggle("bs-gift", t("gift"), null, settings.gift_message_enabled, (v) => set({ gift_message_enabled: v }))}
          {toggle("bs-date", t("deliveryDate"), t("deliveryDateHint"), settings.delivery_date_enabled, (v) => set({ delivery_date_enabled: v }))}
          {settings.delivery_date_enabled && (
            <div className="space-y-3 pl-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="bs-lead">{t("leadDays")}</Label>
                  <Input id="bs-lead" type="number" min={0} max={EXTRAS_LIMITS.leadDays} disabled={!canEdit} value={settings.lead_days}
                    onChange={(e) => set({ lead_days: Math.max(0, Math.min(EXTRAS_LIMITS.leadDays, Number(e.target.value) || 0)) })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bs-window">{t("windowDays")}</Label>
                  <Input id="bs-window" type="number" min={1} max={EXTRAS_LIMITS.windowDays} disabled={!canEdit} value={settings.window_days}
                    onChange={(e) => set({ window_days: Math.max(1, Math.min(EXTRAS_LIMITS.windowDays, Number(e.target.value) || 1)) })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t("slots")}</Label>
                {settings.slots.map((s) => (
                  <div key={s.id} className="flex gap-2">
                    <Input aria-label={t("slotLabel")} maxLength={EXTRAS_LIMITS.slotLabel} disabled={!canEdit} value={s.label}
                      onChange={(e) => set({ slots: settings.slots.map((x) => (x.id === s.id ? { ...x, label: e.target.value } : x)) })} />
                    {canEdit && (
                      <Button type="button" variant="ghost" size="icon" aria-label={t("remove")} onClick={() => set({ slots: settings.slots.filter((x) => x.id !== s.id) })}>
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                ))}
                {canEdit && settings.slots.length < EXTRAS_LIMITS.slots && (
                  <Button type="button" variant="outline" size="sm" onClick={() => set({ slots: [...settings.slots, { id: newId(), label: "" }] })}>
                    <Plus className="size-4" aria-hidden /> {t("addSlot")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("fieldsTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("fieldsHint", { max: EXTRAS_LIMITS.customFields })}</p>
          {settings.custom_fields.map((f) => (
            <div key={f.id} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
                <Input aria-label={t("fieldLabel")} placeholder={t("fieldLabel")} maxLength={EXTRAS_LIMITS.fieldLabel} disabled={!canEdit} value={f.label}
                  onChange={(e) => setField(f.id, { label: e.target.value })} />
                <OptionSelect
                  aria-label={t("fieldType")}
                  value={f.type}
                  onValueChange={(v) => setField(f.id, { type: v as CustomField["type"], options: v === "select" ? (f.options.length ? f.options : ["", ""]) : [] })}
                  disabled={!canEdit}
                  options={[
                    ...CUSTOM_FIELD_TYPES.map((type) => ({ value: type, label: t(`types.${type}`) })),
                  ]}
                />
              </div>
              {f.type === "select" && (
                <Input aria-label={t("fieldOptions")} placeholder={t("fieldOptionsHint")} disabled={!canEdit} value={f.options.join(", ")}
                  onChange={(e) => setField(f.id, { options: e.target.value.split(",").map((o) => o.trim().slice(0, EXTRAS_LIMITS.option)).slice(0, EXTRAS_LIMITS.options) })} />
              )}
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={f.required} disabled={!canEdit} onCheckedChange={(v) => setField(f.id, { required: v === true })} /> {t("required")}
                </label>
                {canEdit && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => set({ custom_fields: settings.custom_fields.filter((x) => x.id !== f.id) })}>
                    <Trash2 className="size-4" aria-hidden /> {t("remove")}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {canEdit && settings.custom_fields.length < EXTRAS_LIMITS.customFields && (
            <Button type="button" variant="outline" size="sm"
              onClick={() => set({ custom_fields: [...settings.custom_fields, { id: newId(), label: "", type: "text", required: false, options: [] }] })}>
              <Plus className="size-4" aria-hidden /> {t("addField")}
            </Button>
          )}
        </div>

        {canEdit && (
          <Button type="button" onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}{t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
