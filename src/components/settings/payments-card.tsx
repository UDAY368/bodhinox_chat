"use client";

/**
 * Settings → Payments: connect Razorpay so agents and flows can send payment
 * links. Admins paste the key id, key secret and webhook secret; the server
 * checks the keys with Razorpay before saving them encrypted. The browser
 * never gets a secret back, only whether one is stored. The webhook URL is
 * shown for the Razorpay dashboard (events payment_link.*).
 */

import { useEffect, useState } from "react";
import { Check, Copy, CreditCard, Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { useCan } from "@/hooks/use-can";
import { authFetch } from "@/lib/auth/client";
import { SettingsPanelHead } from "./settings-panel-head";
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSwitchRow } from "./settings-row";

interface RazorpayStatus {
  connected: boolean;
  mode: "test" | "live" | null;
  key_id: string | null;
  connected_at: string | null;
  webhook_secret_set: boolean;
  webhook_url: string;
}

const ENDPOINT = "/api/payments/razorpay/settings";

export function PaymentsCard() {
  const t = useTranslations("Payments.settings");
  const confirm = useConfirm();
  const canEdit = useCan("edit-settings");
  const [status, setStatus] = useState<RazorpayStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch(ENDPOINT, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: RazorpayStatus) => { if (live) setStatus(json); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key_id: keyId.trim(), key_secret: keySecret, webhook_secret: webhookSecret || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : t("saveFailed"));
      setStatus(json as RazorpayStatus);
      setKeySecret("");
      setWebhookSecret("");
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: t("disconnectConfirm"), confirmLabel: t("disconnect"), destructive: true }))) return;
    setRemoving(true);
    try {
      const res = await authFetch(ENDPOINT, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setStatus((s) => (s ? { ...s, connected: false, mode: null, key_id: null, connected_at: null, webhook_secret_set: false } : s));
      toast.success(t("disconnected"));
    } catch {
      toast.error(t("disconnectFailed"));
    } finally {
      setRemoving(false);
    }
  };

  const copy = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.webhook_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const ready = canEdit && keyId.trim().length > 0 && keySecret.length > 0 && !saving;

  return (
    <div>
      <SettingsPanelHead title={t("title")} description={t("description")} />
      {/* Connect or replace is the one primary action; Disconnect sits in the group's more menu. */}
      <SettingsGroup
        title={
          <span className="inline-flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            {t("razorpay")}
            {status?.connected && (
              <Badge variant={status.mode === "live" ? "default" : "secondary"} className="normal-case">{status.mode === "live" ? t("live") : t("test")}</Badge>
            )}
          </span>
        }
        footer={canEdit ? t("keysHelp") : t("adminOnly")}
        more={[
          { label: t("disconnect"), icon: Unplug, destructive: true, disabled: removing, hidden: !canEdit || !status?.connected, onSelect: () => void disconnect() },
        ]}
      >
        <SettingsSwitchRow
          title={t("razorpay")}
          description={loadFailed ? t("loadFailed") : !status ? t("loading") : status.connected
            ? t("connectedAs", { keyId: status.key_id ?? "" })
            : t("notConnected")}
          control={removing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        />
        {status && (
          <SettingsRow
            label={t("webhookUrl")}
            htmlFor="razorpay-webhook-url"
            hint={
              <>
                {t("webhookHelp")}
                {status.connected && !status.webhook_secret_set && (
                  <span className="mt-1 block text-amber-600 dark:text-amber-400">{t("webhookSecretMissing")}</span>
                )}
              </>
            }
          >
            <div className="flex gap-2">
              <Input id="razorpay-webhook-url" readOnly value={status.webhook_url} className="bg-muted font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="icon" onClick={() => void copy()} aria-label={t("copy")}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </SettingsRow>
        )}

        {canEdit && (
          <>
            <SettingsRow label={t("keyId")} htmlFor="razorpay-key-id">
              <Input id="razorpay-key-id" value={keyId} autoComplete="off" spellCheck={false} maxLength={100}
                placeholder={status?.key_id ?? "rzp_live_…"} onChange={(e) => setKeyId(e.target.value)} className="font-mono" />
            </SettingsRow>
            <SettingsRow label={t("keySecret")} htmlFor="razorpay-key-secret">
              <Input id="razorpay-key-secret" type="password" value={keySecret} autoComplete="new-password" maxLength={200}
                onChange={(e) => setKeySecret(e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("webhookSecret")} htmlFor="razorpay-webhook-secret">
              <Input id="razorpay-webhook-secret" type="password" value={webhookSecret} autoComplete="new-password" maxLength={200}
                placeholder={status?.webhook_secret_set ? t("webhookSecretKeep") : undefined} onChange={(e) => setWebhookSecret(e.target.value)} />
            </SettingsRow>
            <SettingsBlock className="flex justify-end py-2.5">
              <Button onClick={() => void save()} disabled={!ready}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {status?.connected ? t("replace") : t("connect")}
              </Button>
            </SettingsBlock>
          </>
        )}
      </SettingsGroup>
    </div>
  );
}
