"use client";

/**
 * Store settings → Pickup and local delivery (store plan Phase 8). Admins edit; agents read
 * (the API and RLS enforce the same rule). The local delivery fee is typed as a decimal and
 * stored in minor units; the checkout prices it on the server.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import { useReportDirty } from "./section-dirty";
import { storeApi, type DeliveryOptions } from "./settings-api";

export function DeliveryOptionsCard({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const t = useTranslations("Commerce.settings.delivery");
  const te = useTranslations("Commerce.settings.errors");
  const [o, setO] = useState<DeliveryOptions | null>(null);
  const [fee, setFee] = useState("");
  const [prefixes, setPrefixes] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useReportDirty("delivery-options", saved !== null && JSON.stringify({ o, fee, prefixes }) !== saved);

  const load = useCallback((v: DeliveryOptions) => {
    const f = v.local_fee_minor ? minorToDecimalString(v.local_fee_minor, currency) : "";
    const p = v.local_postal_prefixes.join(", ");
    setO(v);
    setFee(f);
    setPrefixes(p);
    setSaved(JSON.stringify({ o: v, fee: f, prefixes: p }));
  }, [currency]);
  useEffect(() => {
    storeApi.deliveryOptions().then((r) => { if (r.ok) load(r.value); }).catch(() => undefined);
  }, [load]);

  if (!o) return null;
  const set = <K extends keyof DeliveryOptions>(key: K, value: DeliveryOptions[K]) => setO({ ...o, [key]: value });

  async function save() {
    if (!o) return;
    let feeMinor = 0;
    try {
      feeMinor = fee.trim() ? parseMoney(fee, currency) : 0;
    } catch {
      return void toast.error(te("invalid"));
    }
    setBusy(true);
    try {
      const r = await storeApi.saveDeliveryOptions({
        ...o, pickup_address: o.pickup_address?.trim() || null, pickup_instructions: o.pickup_instructions?.trim() || null,
        local_fee_minor: feeMinor, local_postal_prefixes: prefixes.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean),
      });
      if (!r.ok) return void toast.error(r.code && te.has(r.code as never) ? te(r.code as never) : te("invalid"));
      load(r.value);
      toast.success(t("saved"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={o.pickup_enabled} disabled={!canEdit} onCheckedChange={(v) => set("pickup_enabled", v)} aria-label={t("pickupEnabled")} />
          {t("pickupEnabled")}
        </label>
        {o.pickup_enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="do-pickup-address">{t("pickupAddress")}</Label>
              <Textarea id="do-pickup-address" maxLength={500} value={o.pickup_address ?? ""} disabled={!canEdit}
                onChange={(e) => set("pickup_address", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="do-pickup-instructions">{t("pickupInstructions")}</Label>
              <Textarea id="do-pickup-instructions" maxLength={500} value={o.pickup_instructions ?? ""} disabled={!canEdit}
                onChange={(e) => set("pickup_instructions", e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("pickupInstructionsHelp")}</p>
            </div>
          </div>
        )}
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={o.local_enabled} disabled={!canEdit} onCheckedChange={(v) => set("local_enabled", v)} aria-label={t("localEnabled")} />
          {t("localEnabled")}
        </label>
        {o.local_enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="do-local-fee">{t("localFee", { currency })}</Label>
              <Input id="do-local-fee" inputMode="decimal" placeholder="0" value={fee} disabled={!canEdit} onChange={(e) => setFee(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("localFeeHelp")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="do-local-prefixes">{t("localPrefixes")}</Label>
              <Input id="do-local-prefixes" value={prefixes} disabled={!canEdit} onChange={(e) => setPrefixes(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("localPrefixesHelp")}</p>
            </div>
          </div>
        )}
        {canEdit && (
          <Button size="sm" onClick={save} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("save")}</Button>
        )}
      </CardContent>
    </Card>
  );
}
