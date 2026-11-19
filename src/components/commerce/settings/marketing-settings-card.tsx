"use client";

/**
 * Commerce → Settings → Marketing (store plan Phase 8, batch 6), the settings part: whether an order confirmation email is sent, the
 * sender details every marketing email carries (name, postal address, reply-to) and the referral program (a reward in store credit,
 * paid once the order is paid and the hold has passed). Email leaves through the platform SMTP only; without it the card says "not
 * connected" and nothing is sent. Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import type { MarketingSettings } from "@/lib/commerce/marketing-settings";
import { useReportDirty } from "./section-dirty";

export function MarketingSettingsCard({ canEdit, currency, onChanged }: { canEdit: boolean; currency: string; onChanged?: (s: MarketingSettings) => void }) {
  const t = useTranslations("Commerce.settings.marketing.settings");
  const te = useTranslations("Commerce.settings.errors");
  const [settings, setSettings] = useState<MarketingSettings | null>(null);
  const [reward, setReward] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useReportDirty("marketing-settings", saved !== null && JSON.stringify({ settings, reward }) !== saved);

  useEffect(() => {
    authFetch("/api/commerce/marketing-settings", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const s = ((await res.json()) as { settings: MarketingSettings }).settings;
        const r = minorToDecimalString(s.referral_reward_minor, currency);
        setSettings(s);
        setReward(r);
        setSaved(JSON.stringify({ settings: s, reward: r }));
        onChanged?.(s);
      })
      .catch(() => undefined);
  }, [currency, onChanged]);
  if (!settings) return null;
  const set = (patch: Partial<MarketingSettings>) => setSettings({ ...settings, ...patch });

  const save = async () => {
    let rewardMinor: number;
    try { rewardMinor = parseMoney(reward || "0", currency); } catch { toast.error(te("invalid")); return; }
    setBusy(true);
    const res = await authFetch("/api/commerce/marketing-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, referral_reward_minor: rewardMinor }),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { settings?: MarketingSettings; code?: string };
    if (!res?.ok || !data.settings) {
      toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid"));
      return;
    }
    const savedReward = minorToDecimalString(data.settings.referral_reward_minor, currency);
    setSettings(data.settings);
    setReward(savedReward);
    setSaved(JSON.stringify({ settings: data.settings, reward: savedReward }));
    onChanged?.(data.settings);
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
    <Card id="marketing-settings">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${settings.email_connected ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100"}`}>
          {settings.email_connected ? t("connected") : t("notConnected")}
        </p>

        <div className="space-y-3">
          {toggle("mk-order-emails", t("orderEmails"), t("orderEmailsHint"), settings.order_emails_enabled, (v) => set({ order_emails_enabled: v }))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="mk-sender-name">{t("senderName")}</Label>
            <Input id="mk-sender-name" maxLength={80} value={settings.sender_name ?? ""} disabled={!canEdit} onChange={(e) => set({ sender_name: e.target.value || null })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mk-reply-to">{t("replyTo")}</Label>
            <Input id="mk-reply-to" type="email" maxLength={254} value={settings.reply_to ?? ""} disabled={!canEdit} onChange={(e) => set({ reply_to: e.target.value || null })} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="mk-address">{t("senderAddress")}</Label>
            <Textarea id="mk-address" rows={2} maxLength={300} value={settings.sender_address ?? ""} disabled={!canEdit} onChange={(e) => set({ sender_address: e.target.value || null })} />
            <p className="text-xs text-muted-foreground">{t("senderAddressHint")}</p>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t("referralTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("referralHint")}</p>
          {toggle("mk-referral", t("referralEnabled"), null, settings.referral_enabled, (v) => set({ referral_enabled: v }))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="mk-reward">{t("reward", { currency })}</Label>
              <Input id="mk-reward" inputMode="decimal" value={reward} disabled={!canEdit} onChange={(e) => setReward(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mk-hold">{t("holdDays")}</Label>
              <Input id="mk-hold" type="number" min={0} max={90} value={settings.referral_hold_days} disabled={!canEdit}
                onChange={(e) => set({ referral_hold_days: Math.min(90, Math.max(0, Math.floor(Number(e.target.value) || 0))) })} />
              <p className="text-xs text-muted-foreground">{t("holdHint")}</p>
            </div>
          </div>
        </div>

        {canEdit && (
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}{t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
