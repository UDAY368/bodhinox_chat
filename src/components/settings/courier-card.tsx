"use client";

/**
 * Settings -> Integrations: the Delhivery and Shipway connection cards (store Phase 5, more couriers).
 *
 * Both are NOT TESTED AGAINST THE LIVE API YET and the card says so. Not connected by default (a form); connected
 * (masked secret hint, defaults, test, update, disconnect). Admins enter the workspace's own credentials: the server
 * checks them with the courier before saving. The browser never gets the secret back, only a masked hint.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Truck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/hooks/use-can";
import { authFetch } from "@/lib/auth/client";

export type CourierCardProvider = "delhivery" | "shipway";

interface CourierStatus {
  available: boolean;
  connected: boolean;
  status: "active" | "token_invalid" | "disconnected" | null;
  label: string | null;
  secret_hint: string | null;
  pickup_location: string | null;
  default_length_cm: number | null;
  default_breadth_cm: number | null;
  default_height_cm: number | null;
  default_weight_grams: number | null;
}

type Dims = { length_cm: string; breadth_cm: string; height_cm: string; weight_grams: string };
const dimText = (v: number | null) => (v === null || v === undefined ? "" : String(v));

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => ({}));
  return typeof json.error === "string" ? json.error : fallback;
}

export function CourierCard({ provider }: { provider: CourierCardProvider }) {
  const t = useTranslations("Settings.couriers");
  const confirm = useConfirm();
  const canEdit = useCan("edit-settings");
  const endpoint = `/api/integrations/couriers/${provider}`;
  const [status, setStatus] = useState<CourierStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [pickup, setPickup] = useState("");
  const [dims, setDims] = useState<Dims>({ length_cm: "", breadth_cm: "", height_cm: "", weight_grams: "" });
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  const needsPickup = provider === "delhivery";

  const apply = useCallback((json: CourierStatus) => {
    setStatus(json);
    setLabel(json.label ?? "");
    setPickup(json.pickup_location ?? "");
    setDims({
      length_cm: dimText(json.default_length_cm), breadth_cm: dimText(json.default_breadth_cm),
      height_cm: dimText(json.default_height_cm), weight_grams: dimText(json.default_weight_grams),
    });
  }, []);

  useEffect(() => {
    let live = true;
    authFetch(endpoint, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: CourierStatus) => { if (live) apply(json); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [apply, endpoint]);

  const test = async () => {
    setBusy("test");
    try {
      const res = await authFetch(`${endpoint}/test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), secret: secret || null }),
      });
      if (!res.ok) throw new Error(await errorText(res, t("testFailed")));
      toast.success(t("testOk"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("testFailed"));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      const defaults: Record<string, number> = {};
      for (const [key, value] of Object.entries(dims)) if (value.trim()) defaults[key] = Number(value);
      const res = await authFetch(endpoint, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), secret: secret || null, pickup_location: needsPickup ? pickup.trim() : null, defaults }),
      });
      if (!res.ok) throw new Error(await errorText(res, t("saveFailed")));
      apply((await res.json()) as CourierStatus);
      setSecret("");
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: t("disconnectConfirm", { name: t(`${provider}.name`) }), confirmLabel: t("disconnect"), destructive: true }))) return;
    setBusy("remove");
    try {
      const res = await authFetch(endpoint, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorText(res, t("disconnectFailed")));
      setSecret("");
      setStatus((s) => (s ? { ...s, connected: false, status: null, label: null, secret_hint: null, pickup_location: null } : s));
      toast.success(t("disconnected"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("disconnectFailed"));
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.connected;
  const reconnect = status?.status === "token_invalid";
  const dimsValid = Object.values(dims).every((v) => !v.trim() || (Number.isFinite(Number(v)) && Number(v) > 0));
  const ready = canEdit && !busy && label.trim().length > 0 && (!needsPickup || pickup.trim().length > 0) && dimsValid
    && (secret.length >= 8 || connected);
  const name = t(`${provider}.name`);
  const description = loadFailed ? t("loadFailed") : !status ? t("loading") : !status.available ? t("unavailable", { name })
    : !connected ? t("notConnected", { name }) : reconnect ? t("reconnectNeeded", { name }) : t("connectedAs", { label: status.label ?? "" });

  const dimField = (key: keyof Dims, text: string, step: string) => (
    <div>
      <Label htmlFor={`${provider}-${key}`} className="mb-1 block text-xs text-muted-foreground">{text}</Label>
      <Input id={`${provider}-${key}`} type="number" inputMode="decimal" min={0} step={step} value={dims[key]}
        onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Truck className="h-4 w-4" />
          {name}
          <Badge variant="outline">{t("notTestedBadge")}</Badge>
          {connected && (reconnect
            ? <Badge variant="destructive">{t("reconnectBadge")}</Badge>
            : <Badge variant="secondary">{t("connectedBadge")}</Badge>)}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {status && (status.available || connected) && (
        <CardContent className="space-y-5">
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("notTested", { name })}</p>
          <p className="text-xs text-muted-foreground">{t(`${provider}.help`)}</p>

          {canEdit && status.available ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor={`${provider}-label`} className="mb-1 block text-xs text-muted-foreground">{t(`${provider}.labelField`)}</Label>
                <Input id={`${provider}-label`} value={label} autoComplete="off" spellCheck={false} maxLength={120}
                  onChange={(e) => setLabel(e.target.value)} />
              </div>
              <div>
                <Label htmlFor={`${provider}-secret`} className="mb-1 block text-xs text-muted-foreground">{t(`${provider}.secretField`)}</Label>
                <Input id={`${provider}-secret`} type="password" value={secret} autoComplete="new-password" maxLength={200}
                  placeholder={connected ? t("secretKeep", { hint: status.secret_hint ?? "" }) : undefined}
                  onChange={(e) => setSecret(e.target.value)} />
              </div>
              {needsPickup && (
                <div>
                  <Label htmlFor={`${provider}-pickup`} className="mb-1 block text-xs text-muted-foreground">{t("warehouse")}</Label>
                  <Input id={`${provider}-pickup`} value={pickup} maxLength={100} onChange={(e) => setPickup(e.target.value)} />
                  <p className="mt-1 text-xs text-muted-foreground">{t("warehouseHelp")}</p>
                </div>
              )}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t("defaults")}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {dimField("length_cm", t("length"), "0.1")}
                  {dimField("breadth_cm", t("breadth"), "0.1")}
                  {dimField("height_cm", t("height"), "0.1")}
                  {dimField("weight_grams", t("weight"), "1")}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void save()} disabled={!ready}>
                  {busy === "save" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {connected ? t("save") : t("connect")}
                </Button>
                <Button variant="outline" onClick={() => void test()} disabled={!!busy || label.trim().length === 0 || (!secret && !connected)}>
                  {busy === "test" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {t("test")}
                </Button>
                {connected && (
                  <Button variant="outline" onClick={() => void disconnect()} disabled={!!busy}>
                    {busy === "remove" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Unplug className="mr-1 h-4 w-4" />}
                    {t("disconnect")}
                  </Button>
                )}
              </div>
            </div>
          ) : canEdit && connected ? (
            <Button variant="outline" onClick={() => void disconnect()} disabled={!!busy}>
              {busy === "remove" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Unplug className="mr-1 h-4 w-4" />}
              {t("disconnect")}
            </Button>
          ) : (
            !canEdit && <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
