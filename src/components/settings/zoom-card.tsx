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
import { Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth/client";
import { hasMinRole } from "@/lib/auth/roles";
import type { MeetingConnectionDto } from "@/lib/meetings/types";

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
    if (!window.confirm(t("disconnectConfirm"))) return;
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
    if (value && !window.confirm(t("registerConfirm"))) return;
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="size-4" aria-hidden="true" /> {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadFailed && <p className="text-destructive text-sm">{t("loadFailed")}</p>}
        {!state && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t("loading")} />}
        {state && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {badge}
              {state.available && state.connected_at && stored && (
                <span className="text-muted-foreground">
                  {t("connectedOn", { date: new Date(state.connected_at).toLocaleDateString() })}
                </span>
              )}
              {canEdit && stored && (
                <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={disconnect} disabled={busy}>
                  {t("disconnect")}
                </Button>
              )}
            </div>
            {!state.available && <p className="text-muted-foreground text-sm">{t("unavailableHelp")}</p>}
            {state.available && state.status === "token_invalid" && (
              <p className="text-muted-foreground text-sm">{t("reconnectHelp")}</p>
            )}
            {state.available && state.status !== "active" && canEdit && (
              <div className="space-y-2">
                {state.status !== "token_invalid" && <p className="text-muted-foreground text-sm">{t("connectHelp")}</p>}
                <Button type="button" onClick={connect} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {state.status === "token_invalid" ? t("reconnect") : t("connect")}
                </Button>
              </div>
            )}
            {state.available && state.status === "active" && (
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={state.register_attendees} onCheckedChange={(v: boolean) => void setRegister(v)}
                  disabled={!canEdit || busy} />
                <span>
                  <span className="text-foreground block font-medium">{t("registerAttendees")}</span>
                  <span className="text-muted-foreground block text-xs">{t("registerAttendeesHelp")}</span>
                </span>
              </label>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
