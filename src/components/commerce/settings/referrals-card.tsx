"use client";

/**
 * Commerce → Settings → Marketing → Referrals and affiliates (store plan Phase 8, batch 6). Every paying customer gets a code (when the
 * program is on); an admin can add named affiliates with a commission share. The table shows each code's link and what it brought in:
 * a customer's code earns store credit, an affiliate's earns a commission figure. The figures are a report only: nothing is paid out
 * to an affiliate by the system. Admins write; agents read.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format/money";
import type { ReferralOverview } from "@/lib/commerce/referrals";

export function ReferralsCard({ canEdit, refreshKey }: { canEdit: boolean; refreshKey: number }) {
  const t = useTranslations("Commerce.settings.marketing.referrals");
  const te = useTranslations("Commerce.settings.errors");
  const locale = useLocale();
  const [data, setData] = useState<ReferralOverview | null>(null);
  const [name, setName] = useState("");
  const [percent, setPercent] = useState("10");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch("/api/commerce/referrals", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setData(((await res.json()) as { referrals: ReferralOverview }).referrals);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other settings panels do
    void load();
  }, [load, refreshKey]);
  if (!data) return null;

  const money = (minor: number) => (data.currency ? formatMoney(minor, data.currency, { locale }) : String(minor));
  const bps = Math.round(Number(percent) * 100);
  const validPercent = Number.isFinite(bps) && bps >= 0 && bps <= 5000;

  const failure = (body: { code?: string }) => toast.error(body.code && te.has(body.code as never) ? te(body.code as never) : te("invalid"));
  const addAffiliate = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/referrals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, commission_bps: bps }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) { failure((await res?.json().catch(() => ({}))) as { code?: string }); return; }
    setName("");
    toast.success(t("added"));
    await load();
  };
  const toggle = async (id: string, active: boolean) => {
    const res = await authFetch(`/api/commerce/referrals/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }),
    }).catch(() => null);
    if (!res?.ok) { failure((await res?.json().catch(() => ({}))) as { code?: string }); return; }
    await load();
  };
  const copy = (link: string) => navigator.clipboard?.writeText(link).then(() => toast.success(t("copied"))).catch(() => undefined);

  return (
    <Card id="referrals">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data.enabled && <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">{t("off")}</p>}
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="af-name">{t("affiliateName")}</Label>
              <Input id="af-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="af-percent">{t("commission")}</Label>
              <Input id="af-percent" type="number" min={0} max={50} step={0.5} className="w-28" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </div>
            <Button onClick={addAffiliate} disabled={busy || !name.trim() || !validPercent}>
              {busy && <Loader2 className="size-4 animate-spin" />}{t("addAffiliate")}
            </Button>
          </div>
        )}
        {data.codes.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t("colWho")}</th><th className="py-1 pr-3 font-medium">{t("colCode")}</th>
                  <th className="py-1 pr-3 font-medium">{t("colOrders")}</th><th className="py-1 pr-3 font-medium">{t("colNet")}</th>
                  <th className="py-1 pr-3 font-medium">{t("colEarned")}</th><th className="py-1 font-medium"><span className="sr-only">{t("colActions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.codes.map((c) => (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{c.kind === "affiliate" ? c.name : (c.contact_name ?? t("customer"))}</span>{" "}
                      <Badge variant="secondary">{t(`kind.${c.kind}`)}</Badge>
                      {!c.active && <Badge variant="outline" className="ml-1">{t("off")}</Badge>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{c.code}</td>
                    <td className="py-2 pr-3">{t("ordersCell", { orders: c.orders, rewarded: c.rewarded, pending: c.pending })}</td>
                    <td className="py-2 pr-3">{money(c.net_minor)}</td>
                    <td className="py-2 pr-3">{c.kind === "affiliate" ? `${money(c.commission_minor)} (${(c.commission_bps ?? 0) / 100}%)` : money(c.credit_minor)}</td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        {c.link && <Button type="button" size="sm" variant="ghost" aria-label={t("copyLink")} onClick={() => copy(c.link!)}><Copy className="size-4" /></Button>}
                        {canEdit && <Button type="button" size="sm" variant="ghost" onClick={() => toggle(c.id, !c.active)}>{c.active ? t("switchOff") : t("switchOn")}</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("reportNote")}</p>
      </CardContent>
    </Card>
  );
}
