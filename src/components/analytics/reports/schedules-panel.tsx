"use client";

/**
 * Scheduled reports (admins and owners): a report kind and format delivered
 * daily, weekly (Monday) or monthly (the 1st) at a local hour, covering the
 * previous complete day, week or month. Recipients must be admins or owners;
 * each one is rechecked when the report is sent, and the email links to the
 * sign-in download page only. A schedule pauses itself when its creator is no
 * longer an admin. At most 10 schedules per workspace.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import { REPORT_FORMATS, REPORT_KINDS, type ReportFormat, type ReportKind, type RunKind } from "@/lib/analytics/report-kinds";

const CADENCES = ["daily", "weekly", "monthly"] as const;
type Cadence = (typeof CADENCES)[number];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-lg border px-2.5 text-[13px] transition-colors duration-150 hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export interface ReportScheduleView {
  id: string;
  kind: RunKind;
  /** Minutes past hourLocal (saved report schedules). */
  minuteLocal?: number;
  /** The saved report a saved_report schedule emails. */
  savedReport?: { id: string; name: string } | null;
  format: ReportFormat;
  cadence: Cadence;
  hourLocal: number;
  recipients: { userId: string; name: string | null }[];
  createdBy: { userId: string; name: string | null };
  pausedAt: string | null;
  pauseReason: "manual" | "creator_lost_access" | "no_recipients" | null;
  nextRunAt: string;
}

interface Member {
  user_id: string;
  full_name: string;
  role: string;
}

const hourLabel = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

export function SchedulesPanel() {
  const t = useTranslations("Analytics.reports.schedules");
  const tr = useTranslations("Analytics.reports");
  const format = useFormatter();
  const [schedules, setSchedules] = useState<ReportScheduleView[] | null>(null);
  const [admins, setAdmins] = useState<Member[]>([]);
  const [kind, setKind] = useState<ReportKind>("campaign_summary");
  const [fileFormat, setFileFormat] = useState<ReportFormat>("csv");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [hour, setHour] = useState(8);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/analytics/reports/schedules", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setSchedules(((await res.json()) as { schedules: ReportScheduleView[] }).schedules);
    } catch {
      setError(t("loadFailed"));
      setSchedules([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
    void (async () => {
      try {
        const res = await authFetch("/api/account/members", { cache: "no-store" });
        if (!res.ok) return;
        const members = ((await res.json()) as { members: Member[] }).members;
        setAdmins(members.filter((m) => m.role === "owner" || m.role === "admin"));
      } catch {
        // The picker stays empty; creating then reports the missing recipients.
      }
    })();
  }, [load]);

  const toggle = (id: string) =>
    setRecipients((list) => (list.includes(id) ? list.filter((r) => r !== id) : list.length >= 10 ? list : [...list, id]));

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (recipients.length === 0) {
      setError(t("pickRecipients"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/analytics/reports/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, format: fileFormat, cadence, hour_local: hour, recipients }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error || t("saveFailed"));
        return;
      }
      setRecipients([]);
      await load();
    } catch {
      setError(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, change: Record<string, unknown>) => {
    setError(null);
    try {
      const res = await authFetch(`/api/analytics/reports/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(body?.error || t("saveFailed"));
      await load();
    } catch {
      setError(t("saveFailed"));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("confirmDelete"))) return;
    setError(null);
    try {
      const res = await authFetch(`/api/analytics/reports/schedules/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error();
      await load();
    } catch {
      setError(t("saveFailed"));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" onSubmit={create}>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-kind">{tr("kind")}</Label>
            <select id="schedule-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)} className={selectClass}>
              {REPORT_KINDS.map((k) => <option key={k} value={k}>{tr(`kinds.${k}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-format">{tr("format")}</Label>
            <select id="schedule-format" value={fileFormat} onChange={(e) => setFileFormat(e.target.value as ReportFormat)} className={selectClass}>
              {REPORT_FORMATS.map((f) => <option key={f} value={f}>{tr(`formats.${f}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-cadence">{t("cadence")}</Label>
            <select id="schedule-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} className={selectClass}>
              {CADENCES.map((c) => <option key={c} value={c}>{t(`cadences.${c}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-hour">{t("hour")}</Label>
            <select id="schedule-hour" value={hour} onChange={(e) => setHour(Number(e.target.value))} className={selectClass}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          <fieldset className="space-y-1.5 sm:col-span-2 lg:col-span-4">
            <legend className="text-sm font-medium text-foreground">{t("recipients")}</legend>
            {admins.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noAdmins")}</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {admins.map((m) => (
                  <label key={m.user_id} className="flex items-center gap-2 text-sm text-foreground">
                    <input type="checkbox" className="size-4" checked={recipients.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
                    {m.full_name || tr("formerMember")}
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("recipientsHelp")}</p>
          </fieldset>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("create")}
            </Button>
          </div>
        </form>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

        {schedules === null ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3.5 py-2 font-semibold">{tr("kind")}</th>
                  <th scope="col" className="px-3.5 py-2 font-semibold">{t("when")}</th>
                  <th scope="col" className="px-3.5 py-2 font-semibold">{t("recipients")}</th>
                  <th scope="col" className="px-3.5 py-2 font-semibold">{tr("statusLabel")}</th>
                  <th scope="col" className="px-3.5 py-2 font-semibold"><span className="sr-only">{t("actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-t border-border align-top transition-colors duration-150 hover:bg-muted/50">
                    <td className="px-3.5 py-2.5 text-foreground">
                      {s.savedReport ? s.savedReport.name : tr(`kinds.${s.kind}`)}
                      <span className="block text-xs text-muted-foreground">{tr(`formats.${s.format}`)}</span>
                    </td>
                    <td className="px-3.5 py-2.5 text-muted-foreground">
                      {t("whenValue", { cadence: t(`cadences.${s.cadence}`), hour: hourLabel(s.hourLocal, s.minuteLocal ?? 0) })}
                    </td>
                    <td className="px-3.5 py-2.5 text-muted-foreground">
                      {s.recipients.map((r) => r.name || tr("formerMember")).join(", ")}
                    </td>
                    <td className="px-3.5 py-2.5 text-muted-foreground">
                      {s.pausedAt ? (
                        <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{t(`paused.${s.pauseReason ?? "manual"}`)}</span>
                      ) : (
                        t("next", { date: format.dateTime(new Date(s.nextRunAt), { dateStyle: "medium", timeStyle: "short" }) })
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                      <Button type="button" size="sm" variant="ghost" onClick={() => patch(s.id, { paused: !s.pausedAt })}
                        aria-label={s.pausedAt ? t("resume") : t("pause")}>
                        {s.pausedAt ? <Play className="size-4" /> : <Pause className="size-4" />}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => remove(s.id)} aria-label={t("delete")}>
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
