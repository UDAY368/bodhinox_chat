"use client";

/**
 * Settings → Inbox: the workspace's working hours and time zone, the away
 * message sent once per off-hours stretch to a customer who writes while
 * closed, auto-resolve for idle conversations and the first-reply target
 * (SLA). Every member can read it; only admins and owners can save
 * (PUT /api/inbox/settings).
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import { useWorkspaceChannels } from "@/hooks/use-workspace-channels";
import { DEFAULT_INBOX_BEHAVIOUR, type WorkspaceInboxSettings } from "@/lib/inbox/inbox-settings";
import {
  DEFAULT_INBOX_SETTINGS,
  MAX_RANGES_PER_DAY,
  WEEKDAYS,
  type TimeRange,
  type Weekday,
} from "@/lib/inbox/working-hours";

const MAX_AWAY = 1024;
const DEFAULT_RANGE: TimeRange = { start: "09:00", end: "18:00" };

/** "" for off; otherwise the whole number typed. */
const toLimit = (value: string): number | null => (value.trim() === "" ? null : Number(value));
const fromLimit = (value: number | null): string => (value === null ? "" : String(value));

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function WorkingHoursCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.workingHours");
  const tDay = useTranslations("Weekdays");
  const [settings, setSettings] = useState<WorkspaceInboxSettings>({ ...DEFAULT_INBOX_SETTINGS, instagram_away_message_enabled: false, ...DEFAULT_INBOX_BEHAVIOUR });
  // The Instagram away switch shows only when the workspace uses Instagram (or it is already on).
  const { data: channels } = useWorkspaceChannels();
  const showInstagram = Boolean(channels?.channels.instagram.enabled) || settings.instagram_away_message_enabled;
  const hasAwayText = Boolean(settings.away_message?.trim());
  const [autoResolve, setAutoResolve] = useState("");
  const [sla, setSla] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const zones = useMemo(timeZones, []);
  const editable = canEdit && !loadFailed && !saving;

  useEffect(() => {
    let live = true;
    authFetch("/api/inbox/settings", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: { settings: WorkspaceInboxSettings }) => {
        if (!live) return;
        setSettings(json.settings);
        setAutoResolve(fromLimit(json.settings.auto_resolve_after_hours));
        setSla(fromLimit(json.settings.sla_first_response_minutes));
      })
      .catch(() => { if (live) setLoadFailed(true); })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const setDay = (day: Weekday, ranges: TimeRange[]) =>
    setSettings((s) => ({ ...s, working_hours: { ...s.working_hours, [day]: ranges } }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch("/api/inbox/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...settings,
          working_hours: Object.fromEntries(WEEKDAYS.map((d) => [d, settings.working_hours[d] ?? []])),
          auto_resolve_after_hours: toLimit(autoResolve),
          sla_first_response_minutes: toLimit(sla),
          // Clearing the away text turns the Instagram switch off with it (it has nothing to send).
          instagram_away_message_enabled: hasAwayText && settings.instagram_away_message_enabled,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : t("saveFailed"));
      setSettings(json.settings);
      setAutoResolve(fromLimit(json.settings.auto_resolve_after_hours));
      setSla(fromLimit(json.settings.sla_first_response_minutes));
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : loadFailed ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="inbox-timezone">{t("timezone")}</Label>
              <Input
                id="inbox-timezone"
                list="inbox-timezones"
                value={settings.timezone}
                maxLength={64}
                disabled={!editable}
                onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                className="bg-muted sm:max-w-xs"
              />
              <datalist id="inbox-timezones">
                {zones.map((zone) => <option key={zone} value={zone} />)}
              </datalist>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">{t("hours")}</legend>
              <p className="text-xs text-muted-foreground">{t("hoursHint")}</p>
              {WEEKDAYS.map((day) => {
                const ranges = settings.working_hours[day] ?? [];
                return (
                  <div key={day} className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-start">
                    <label className="flex w-36 shrink-0 items-center gap-2 text-sm text-foreground">
                      <Switch
                        checked={ranges.length > 0}
                        disabled={!editable}
                        onCheckedChange={(open) => setDay(day, open ? [DEFAULT_RANGE] : [])}
                        aria-label={t("openOn", { day: tDay(day) })}
                      />
                      {tDay(day)}
                    </label>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      {ranges.length === 0 && <p className="py-1 text-xs text-muted-foreground">{t("closed")}</p>}
                      {ranges.map((range, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Input
                            type="time"
                            aria-label={t("opensAt", { day: tDay(day) })}
                            value={range.start}
                            disabled={!editable}
                            onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? { ...r, start: e.target.value } : r)))}
                            className="bg-muted w-32"
                          />
                          <span className="text-xs text-muted-foreground">{t("to")}</span>
                          <Input
                            type="time"
                            aria-label={t("closesAt", { day: tDay(day) })}
                            value={range.end === "24:00" ? "23:59" : range.end}
                            disabled={!editable}
                            onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? { ...r, end: e.target.value === "23:59" ? "24:00" : e.target.value } : r)))}
                            className="bg-muted w-32"
                          />
                          {editable && (
                            <Button type="button" variant="ghost" size="sm" aria-label={t("removeRange")}
                              onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                      {editable && ranges.length > 0 && ranges.length < MAX_RANGES_PER_DAY && ranges[ranges.length - 1].end < "23:59" && (
                        <Button type="button" variant="ghost" size="sm"
                          onClick={() => setDay(day, [...ranges, { start: ranges[ranges.length - 1].end, end: "24:00" }])}>
                          <Plus className="size-3.5" /> {t("addRange")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </fieldset>

            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("awayTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("awayDescription")}</p>
                </div>
                <Switch
                  checked={settings.away_message_enabled}
                  disabled={!editable}
                  onCheckedChange={(on) => setSettings({ ...settings, away_message_enabled: on })}
                  aria-label={t("awayTitle")}
                />
              </div>
              <Textarea
                aria-label={t("awayText")}
                placeholder={t("awayPlaceholder")}
                value={settings.away_message ?? ""}
                maxLength={MAX_AWAY}
                rows={3}
                disabled={!editable}
                onChange={(e) => setSettings({ ...settings, away_message: e.target.value })}
                className="bg-muted"
              />
              {showInstagram && (
                <div className="flex items-center justify-between gap-4 border-t border-border pt-2">
                  <div>
                    <p className="text-sm text-foreground">{t("instagramAway.label")}</p>
                    <p className="text-xs text-muted-foreground">
                      {hasAwayText ? t("instagramAway.help") : t("instagramAway.needsMessage")}
                    </p>
                  </div>
                  <Switch
                    checked={settings.instagram_away_message_enabled}
                    disabled={!editable || (!settings.instagram_away_message_enabled && !hasAwayText)}
                    onCheckedChange={(on) => setSettings({ ...settings, instagram_away_message_enabled: on })}
                    aria-label={t("instagramAway.label")}
                  />
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="inbox-sla">{t("slaLabel")}</Label>
                <Input id="inbox-sla" type="number" inputMode="numeric" min={1} max={10080} step={1}
                  placeholder={t("off")} value={sla} disabled={!editable}
                  onChange={(e) => setSla(e.target.value)} className="bg-muted" />
                <p className="text-xs text-muted-foreground">{t("slaHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inbox-auto-resolve">{t("autoResolveLabel")}</Label>
                <Input id="inbox-auto-resolve" type="number" inputMode="numeric" min={1} max={720} step={1}
                  placeholder={t("off")} value={autoResolve} disabled={!editable}
                  onChange={(e) => setAutoResolve(e.target.value)} className="bg-muted" />
                <p className="text-xs text-muted-foreground">{t("autoResolveHint")}</p>
              </div>
            </div>

            {canEdit ? (
              <Button type="button" size="sm" onClick={save} disabled={!editable}>
                {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t("adminsOnly")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
