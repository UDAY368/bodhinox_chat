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
import { CalendarClock, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fieldTrigger } from "./reports-tab";
import { authFetch } from "@/lib/auth/client";
import { REPORT_FORMATS, REPORT_KINDS, type ReportFormat, type ReportKind, type RunKind } from "@/lib/analytics/report-kinds";

const CADENCES = ["daily", "weekly", "monthly"] as const;
type Cadence = (typeof CADENCES)[number];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

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
  const confirm = useConfirm();
  const [loadFailed, setLoadFailed] = useState(false);
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
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      setSchedules([]);
    }
  }, []);

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
    if (!(await confirm({ title: t("confirmDelete"), confirmLabel: t("delete"), destructive: true }))) return;
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
            <Select value={kind} onValueChange={(v) => { if (v) setKind(v as ReportKind); }}>
              <SelectTrigger id="schedule-kind" className={fieldTrigger}>
                <SelectValue>{(v: string) => tr(`kinds.${v as ReportKind}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {REPORT_KINDS.map((k) => <SelectItem key={k} value={k}>{tr(`kinds.${k}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm leading-none font-medium">{tr("format")}</p>
            <SegmentedControl aria-label={tr("format")} value={fileFormat} onValueChange={setFileFormat}
              options={REPORT_FORMATS.map((f) => ({ value: f, label: tr(`formats.${f}`) }))} />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm leading-none font-medium">{t("cadence")}</p>
            <SegmentedControl aria-label={t("cadence")} value={cadence} onValueChange={setCadence}
              options={CADENCES.map((c) => ({ value: c, label: t(`cadences.${c}`) }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-hour">{t("hour")}</Label>
            <Select value={String(hour)} onValueChange={(v) => { if (v) setHour(Number(v)); }}>
              <SelectTrigger id="schedule-hour" className={fieldTrigger}>
                <SelectValue>{(v: string) => hourLabel(Number(v))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((h) => <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-1.5 sm:col-span-2 lg:col-span-4">
            <legend className="text-sm font-medium text-foreground">{t("recipients")}</legend>
            {admins.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noAdmins")}</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {admins.map((m) => (
                  <label key={m.user_id} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground sm:min-h-8">
                    <Checkbox checked={recipients.includes(m.user_id)} onCheckedChange={() => toggle(m.user_id)} />
                    {m.full_name || tr("formerMember")}
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("recipientsHelp")}</p>
          </fieldset>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" className="min-h-11 sm:min-h-8" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("create")}
            </Button>
          </div>
        </form>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

        {loadFailed ? (
          <InlineError message={t("loadFailed")} onRetry={() => void load()} />
        ) : schedules === null ? (
          <PageLoading rows={2} />
        ) : schedules.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t("empty")} />
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
                      <Button type="button" size="icon" variant="ghost" className="size-11 sm:size-8" onClick={() => patch(s.id, { paused: !s.pausedAt })}
                        aria-label={s.pausedAt ? t("resume") : t("pause")}>
                        {s.pausedAt ? <Play className="size-4" /> : <Pause className="size-4" />}
                      </Button>
                      <Button type="button" size="icon" variant="ghost" className="size-11 sm:size-8" onClick={() => remove(s.id)} aria-label={t("delete")}>
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
