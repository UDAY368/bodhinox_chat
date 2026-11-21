"use client";

/**
 * Settings -> Meetings & shipping: the Zoom connection card (Phase 9, design §7). Owner: T2.
 *
 * States: not available on this deployment (no Zoom app configured) / not
 * connected (Connect) / connected (registration switch with the email-sharing
 * note, Disconnect) / reconnect needed (token withdrawn or expired). Members see
 * the status; admins (integrations.meetings) change it. No token reaches here.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Unplug, Video } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth/client";
import { hasMinRole } from "@/lib/auth/roles";
import type { MeetingConnectionDto } from "@/lib/meetings/types";
import { GroupedListRow } from "@/components/ui/grouped-list";
import { SettingsBlock, SettingsGroup, SettingsSwitchRow } from "./settings-row";
import { PageLoading } from "@/components/ui/page-loading";

/** ?zoom=<outcome> values the callback can send. */
const OUTCOMES = new Set([
  "connected", "denied", "signed_out", "forbidden", "save_failed", "not_configured", "invalid_state", "auth",
  "missing_scopes", "provider_unreachable", "zoom_account_in_use", "feature_unavailable",
]);
const ERRORS = new Set([
  "not_configured", "not_connected", "zoom_account_in_use", "auth", "provider_unreachable", "invalid_state",
  "missing_scopes", "feature_unavailable",
]);

export function ZoomCard() {
  const t = useTranslations("Settings.zoom");
  const confirm = useConfirm();
  const { accountRole } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, "admin");
  const searchParams = useSearchParams();
  const [state, setState] = useState<MeetingConnectionDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const errorText = useCallback((code: unknown) =>
    typeof code === "string" && ERRORS.has(code) ? t(`errors.${code}`) : t("errors.generic"), [t]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch("/api/integrations/zoom", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setState(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const outcome = searchParams.get("zoom");
  useEffect(() => {
    if (!outcome || !OUTCOMES.has(outcome)) return;
    if (outcome === "connected") toast.success(t("outcomes.connected"));
    else toast.error(t(`outcomes.${outcome}`));
  }, [outcome, t]);

  const send = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
    const res = await authFetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(json.code ?? json.error));
    return json;
  };

  const connect = async () => {
    setBusy(true);
    try {
      const json = await send("POST", "/api/integrations/zoom/connect");
      if (typeof json.url !== "string" || !json.url.startsWith("https://zoom.us/")) throw new Error(t("errors.generic"));
      window.location.assign(json.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: t("disconnectConfirm"), confirmLabel: t("disconnect"), destructive: true }))) return;
    setBusy(true);
    try {
      setState(await send("DELETE", "/api/integrations/zoom"));
      toast.success(t("disconnected"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const setRegister = async (value: boolean) => {
    if (value && !(await confirm({ title: t("registerConfirm") }))) return;
    setBusy(true);
    try {
      setState(await send("PATCH", "/api/integrations/zoom", { register_attendees: value }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const stored = state?.status === "active" || state?.status === "token_invalid";
  const badge = !state ? null
    : !state.available ? <Badge variant="outline">{t("statusUnavailable")}</Badge>
    : state.status === "active" ? <Badge variant="secondary">{t("statusConnected")}</Badge>
    : state.status === "token_invalid" ? <Badge variant="destructive">{t("statusReconnect")}</Badge>
    : <Badge variant="outline">{t("statusNotConnected")}</Badge>;

  return (
    <SettingsGroup
      title={<span className="inline-flex items-center gap-2"><Video className="size-4" aria-hidden="true" /> {t("title")}</span>}
      footer={t("description")}
      action={state?.available && state.status !== "active" && canEdit ? (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={connect} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {state.status === "token_invalid" ? t("reconnect") : t("connect")}
        </Button>
      ) : undefined}
      more={[{ label: t("disconnect"), icon: Unplug, destructive: true, disabled: busy, hidden: !canEdit || !stored, onSelect: () => void disconnect() }]}
    >
      {loadFailed && <SettingsBlock><InlineError message={t("loadFailed")} onRetry={() => void load()} /></SettingsBlock>}
      {!state && !loadFailed && <SettingsBlock><PageLoading rows={2} /></SettingsBlock>}
      {state && (
        <>
          <GroupedListRow
            title={t("title")}
            subtitle={!state.available ? t("unavailableHelp")
              : state.status === "token_invalid" ? t("reconnectHelp")
              : state.connected_at && stored ? t("connectedOn", { date: new Date(state.connected_at).toLocaleDateString() })
              : canEdit && state.status !== "active" ? t("connectHelp")
              : undefined}
            trailing={badge}
            className="[&_.truncate]:whitespace-normal"
          />
          {state.available && state.status === "active" && (
            <SettingsSwitchRow
              title={t("registerAttendees")}
              description={t("registerAttendeesHelp")}
              control={<Switch checked={state.register_attendees} onCheckedChange={(v: boolean) => void setRegister(v)}
                disabled={!canEdit || busy} aria-label={t("registerAttendees")} />}
            />
          )}
        </>
      )}
    </SettingsGroup>
  );
}
