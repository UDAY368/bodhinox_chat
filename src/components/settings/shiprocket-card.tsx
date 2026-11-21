"use client";

/**
 * Settings → Meetings & shipping: the Shiprocket connection card (Phase 9, design §7). Owner: T4.
 *
 * Not connected (form) / Connected (pickup location, default package, the
 * tracking webhook URL with copy, a webhook token shown once when generated,
 * the hostname keyword warning) / Reconnect needed / Disconnect. Admins enter
 * the workspace's own Shiprocket API user; the server checks it with Shiprocket
 * and lists the pickup locations before saving. The browser never gets the
 * password, the login token or a stored webhook token back.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Truck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCan } from "@/hooks/use-can";
import { authFetch } from "@/lib/auth/client";

interface ShiprocketStatus {
  available: boolean;
  connected: boolean;
  status: "active" | "token_invalid" | "disconnected" | null;
  api_email: string | null;
  pickup_location: string | null;
  default_length_cm: number | null;
  default_breadth_cm: number | null;
  default_height_cm: number | null;
  default_weight_grams: number | null;
  webhook_token_set: boolean;
  webhook_url: string | null;
}

const ENDPOINT = "/api/integrations/shiprocket";
/** Shiprocket refuses webhook URLs containing these words (also in the hostname). */
const BLOCKED_URL_WORDS = /shiprocket|kartrocket|sr|kr/i;

type Dims = { length_cm: string; breadth_cm: string; height_cm: string; weight_grams: string };
const dimText = (v: number | null) => (v === null || v === undefined ? "" : String(v));

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => ({}));
  return typeof json.error === "string" ? json.error : fallback;
}

export function ShiprocketCard() {
  const t = useTranslations("Settings.shiprocket");
  const confirm = useConfirm();
  const canEdit = useCan("edit-settings");
  const [status, setStatus] = useState<ShiprocketStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [locations, setLocations] = useState<string[] | null>(null);
  const [pickup, setPickup] = useState("");
  const [dims, setDims] = useState<Dims>({ length_cm: "", breadth_cm: "", height_cm: "", weight_grams: "" });
  const [busy, setBusy] = useState<"test" | "save" | "remove" | "token" | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  const apply = useCallback((json: ShiprocketStatus) => {
    setStatus(json);
    setEmail(json.api_email ?? "");
    setPickup(json.pickup_location ?? "");
    setLocations(json.pickup_location ? [json.pickup_location] : null);
    setDims({
      length_cm: dimText(json.default_length_cm), breadth_cm: dimText(json.default_breadth_cm),
      height_cm: dimText(json.default_height_cm), weight_grams: dimText(json.default_weight_grams),
    });
  }, []);

  useEffect(() => {
    let live = true;
    authFetch(ENDPOINT, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: ShiprocketStatus) => { if (live) apply(json); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [apply]);

  const test = async () => {
    setBusy("test");
    try {
      const res = await authFetch(`${ENDPOINT}/test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password: password || null }),
      });
      if (!res.ok) throw new Error(await errorText(res, t("testFailed")));
      const json = (await res.json()) as { pickup_locations: string[] };
      setLocations(json.pickup_locations);
      if (!json.pickup_locations.includes(pickup)) setPickup(json.pickup_locations[0] ?? "");
      if (!json.pickup_locations.length) toast.error(t("noPickup"));
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
      const res = await authFetch(ENDPOINT, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password: password || null, pickup_location: pickup, defaults }),
      });
      if (!res.ok) throw new Error(await errorText(res, t("saveFailed")));
      apply((await res.json()) as ShiprocketStatus);
      setPassword("");
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: t("disconnectConfirm"), confirmLabel: t("disconnect"), destructive: true }))) return;
    setBusy("remove");
    try {
      const res = await authFetch(ENDPOINT, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorText(res, t("disconnectFailed")));
      setToken(null);
      setPassword("");
      setStatus((s) => (s ? { ...s, connected: false, status: null, api_email: null, pickup_location: null, webhook_token_set: false, webhook_url: null } : s));
      setLocations(null);
      toast.success(t("disconnected"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("disconnectFailed"));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async () => {
    if (status?.webhook_token_set && !(await confirm({ title: t("regenerateConfirm"), confirmLabel: t("regenerateToken"), destructive: true }))) return;
    setBusy("token");
    try {
      const res = await authFetch(`${ENDPOINT}/webhook-token`, { method: "POST" });
      if (!res.ok) throw new Error(await errorText(res, t("tokenFailed")));
      const json = (await res.json()) as { token: string };
      setToken(json.token);
      setStatus((s) => (s ? { ...s, webhook_token_set: true } : s));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("tokenFailed"));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (what: "url" | "token", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const connected = !!status?.connected;
  const reconnect = status?.status === "token_invalid";
  const dimsValid = Object.values(dims).every((v) => !v.trim() || (Number.isFinite(Number(v)) && Number(v) > 0));
  const ready = canEdit && !busy && email.trim().length > 3 && !!pickup && dimsValid && (password.length > 0 || connected);
  const urlBlocked = !!status?.webhook_url && BLOCKED_URL_WORDS.test(status.webhook_url.replace(/\/api\/fulfilment\/tracking\/.*/, ""));

  const description = loadFailed ? t("loadFailed") : !status ? t("loading") : !status.available ? t("unavailable")
    : !connected ? t("notConnected") : reconnect ? t("reconnectNeeded") : t("connectedAs", { email: status.api_email ?? "" });

  const dimField = (key: keyof Dims, label: string, step: string) => (
    <div>
      <Label htmlFor={`shiprocket-${key}`} className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <Input id={`shiprocket-${key}`} type="number" inputMode="decimal" min={0} step={step} value={dims[key]}
        onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))} />
    </div>
  );

  return (
    // Save or Connect is the one primary action; the webhook token and Disconnect sit in the group's more menu.
    <SettingsGroup
      title={
        <span className="inline-flex items-center gap-2">
          <Truck className="h-4 w-4" />
          {t("title")}
          {connected && (reconnect
            ? <Badge variant="destructive" className="normal-case">{t("reconnectBadge")}</Badge>
            : <Badge variant="secondary" className="normal-case">{t("connectedBadge")}</Badge>)}
        </span>
      }
      footer={status && (status.available || connected) ? (!canEdit ? <>{description} {t("adminOnly")}</> : description) : undefined}
      more={[
        { label: status?.webhook_token_set ? t("regenerateToken") : t("generateToken"), icon: KeyRound,
          hidden: !canEdit || !connected || !status?.webhook_url, disabled: !!busy, onSelect: () => void rotate() },
        { label: t("disconnect"), icon: Unplug, destructive: true, hidden: !canEdit || !connected, disabled: !!busy, onSelect: () => void disconnect() },
      ]}
    >
      {status && (status.available || connected) ? (
        <>
          <SettingsBlock className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("walletNote")}</p>
            {(busy === "token" || busy === "remove") && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {busy === "token" ? t("regenerateToken") : t("disconnect")}
              </p>
            )}
          </SettingsBlock>

          {connected && status.webhook_url && (
            <SettingsRow
              label={t("webhookUrl")}
              htmlFor="shiprocket-webhook-url"
              hint={
                <>
                  {t("webhookHelp")}
                  {urlBlocked && <span className="mt-1 block text-amber-600 dark:text-amber-400">{t("hostnameWarning")}</span>}
                  <span className="mt-1 block">{status.webhook_token_set ? t("tokenSet") : t("tokenMissing")}</span>
                </>
              }
            >
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input id="shiprocket-webhook-url" readOnly value={status.webhook_url} className="bg-muted font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button type="button" variant="outline" size="icon" onClick={() => void copy("url", status.webhook_url!)} aria-label={t("copy")}>
                    {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                {token && (
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input readOnly value={token} className="bg-muted font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                      <Button type="button" variant="outline" size="icon" onClick={() => void copy("token", token)} aria-label={t("copy")}>
                        {copied === "token" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-amber-600 dark:text-amber-400">{t("tokenOnce")}</p>
                  </div>
                )}
              </div>
            </SettingsRow>
          )}

          {canEdit && status.available && (
            <>
              <SettingsBlock className="py-2.5"><p className="text-xs text-muted-foreground">{t("apiHelp")}</p></SettingsBlock>
              <SettingsRow label={t("apiEmail")} htmlFor="shiprocket-email">
                <Input id="shiprocket-email" type="email" value={email} autoComplete="off" spellCheck={false} maxLength={254}
                  onChange={(e) => setEmail(e.target.value)} />
              </SettingsRow>
              <SettingsRow label={t("apiPassword")} htmlFor="shiprocket-password">
                <Input id="shiprocket-password" type="password" value={password} autoComplete="new-password" maxLength={200}
                  placeholder={connected ? t("passwordKeep") : undefined} onChange={(e) => setPassword(e.target.value)} />
              </SettingsRow>
              <SettingsRow label={t("pickupLocation")} htmlFor="shiprocket-pickup">
                {/* Test signs in and loads the pickup locations into this menu. */}
                <div className="flex gap-2">
                  <Select value={pickup || null} onValueChange={(v) => setPickup(v ? String(v) : "")} disabled={!locations?.length}>
                    <SelectTrigger id="shiprocket-pickup" className="min-h-11 w-full min-w-0 flex-1 bg-background sm:min-h-9">
                      <SelectValue placeholder={t("pickupHelp")}>{(v: string | null) => v || t("pickupHelp")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {locations?.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" onClick={() => void test()}
                    disabled={!!busy || email.trim().length < 4 || (!password && !connected)}>
                    {busy === "test" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {t("test")}
                  </Button>
                </div>
              </SettingsRow>
              <SettingsBlock>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t("defaults")}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {dimField("length_cm", t("length"), "0.1")}
                  {dimField("breadth_cm", t("breadth"), "0.1")}
                  {dimField("height_cm", t("height"), "0.1")}
                  {dimField("weight_grams", t("weight"), "1")}
                </div>
              </SettingsBlock>
              <SettingsBlock className="flex justify-end py-2.5">
                <Button onClick={() => void save()} disabled={!ready}>
                  {busy === "save" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {connected ? t("save") : t("connect")}
                </Button>
              </SettingsBlock>
            </>
          )}
        </>
      ) : (
        <SettingsBlock><p className="text-xs text-muted-foreground">{description}</p></SettingsBlock>
      )}
    </SettingsGroup>
  );
}
