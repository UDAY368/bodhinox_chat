"use client";

/**
 * Analytics → Reports: request a CSV or PDF report (campaign day-wise,
 * campaign summary, campaigns per member, agent performance, products,
 * services, daily collections) for a date range, then download it when the
 * worker has built it, share it inside the workspace by role, or schedule it. Admins and owners only
 * (POST/GET /api/analytics/reports; downloads go through the audit-logged
 * /api/analytics/reports/[id]/download). Polls while a report is building.
 * Files hold counts and names only, never message content, and expire after
 * 30 days.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { Download, Loader2, Share2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import { REPORT_FORMATS, REPORT_KINDS, type ReportFormat } from "@/lib/analytics/report-kinds";
import { SchedulesPanel } from "./schedules-panel";
import { SharePanel } from "./share-panel";

export const REPORT_KIND_OPTIONS = REPORT_KINDS;
type Kind = (typeof REPORT_KIND_OPTIONS)[number];
const PRESETS = ["7d", "30d", "90d", "this_week", "last_week", "this_month", "last_month", "custom"] as const;
type Preset = (typeof PRESETS)[number];
type Status = "queued" | "running" | "ready" | "failed" | "expired";

export interface ReportRunView {
  id: string;
  kind: Kind;
  format?: ReportFormat;
  scheduled?: boolean;
  status: Status;
  params: { from: string; to: string; timezone: string };
  requestedBy: { userId: string; name: string | null } | null;
  rowCount: number | null;
  truncated: boolean;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-lg border px-2.5 text-[13px] transition-colors duration-150 hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const POLL_MS = 5_000;
const statusClass: Record<Status, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  ready: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
};

export function ReportsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Analytics.reports");
  const format = useFormatter();
  const [kind, setKind] = useState<Kind>("campaign_summary");
  const [preset, setPreset] = useState<Preset>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [email, setEmail] = useState(false);
  const [fileFormat, setFileFormat] = useState<ReportFormat>("csv");
  const [sharing, setSharing] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportRunView[]>([]);
  const [loading, setLoading] = useState(canManage);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/analytics/reports", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setReports(((await res.json()) as { reports: ReportRunView[] }).reports);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  const building = reports.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [building, load]);

  if (!canManage) return <p className="text-sm text-muted-foreground">{t("adminsOnly")}</p>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (preset === "custom" && (!from || !to)) {
      setError(t("pickDates"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch("/api/analytics/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset === "custom"
          ? { kind, format: fileFormat, preset, from, to, email } : { kind, format: fileFormat, preset, email }),
      });
      const body = (await res.json().catch(() => null)) as { report?: ReportRunView; error?: string } | null;
      if (!res.ok || !body?.report) {
        setError(body?.error || t("requestFailed"));
        return;
      }
      setReports((list) => [body.report!, ...list]);
    } catch {
      setError(t("requestFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const day = (value: string) => format.dateTime(new Date(`${value}T00:00:00`), { dateStyle: "medium" });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t("title")}</CardTitle>
          <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_auto_auto] lg:items-end" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="report-kind">{t("kind")}</Label>
              <select id="report-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectClass}>
                {REPORT_KIND_OPTIONS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-range">{t("range")}</Label>
              <select id="report-range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={selectClass}>
                {PRESETS.map((p) => <option key={p} value={p}>{t(`presets.${p}`)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-format">{t("format")}</Label>
              <select id="report-format" value={fileFormat} onChange={(e) => setFileFormat(e.target.value as ReportFormat)} className={selectClass}>
                {REPORT_FORMATS.map((f) => <option key={f} value={f}>{t(`formats.${f}`)}</option>)}
              </select>
            </div>
            {preset === "custom" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="report-from">{t("from")}</Label>
                  <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-muted" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="report-to">{t("to")}</Label>
                  <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-muted" />
                </div>
              </>
            )}
            {fileFormat === "pdf" && (
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">{t("pdfNote")}</p>
            )}
            <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2 lg:col-span-5">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="size-4" />
              {t("emailMe")}
            </label>
            <div className="sm:col-span-2 lg:col-span-5">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {t("request")}
              </Button>
            </div>
          </form>
          {error && <p className="mt-3 text-xs text-destructive" role="alert">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t("listTitle")}</CardTitle>
          <CardDescription className="text-muted-foreground">{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadFailed ? (
            <p className="text-xs text-destructive">{t("loadFailed")}</p>
          ) : loading ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : reports.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="bg-muted text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3.5 py-2 font-semibold">{t("kind")}</th>
                    <th scope="col" className="px-3.5 py-2 font-semibold">{t("range")}</th>
                    <th scope="col" className="px-3.5 py-2 font-semibold">{t("requested")}</th>
                    <th scope="col" className="px-3.5 py-2 font-semibold">{t("statusLabel")}</th>
                    <th scope="col" className="px-3.5 py-2 font-semibold"><span className="sr-only">{t("download")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <Fragment key={r.id}>
                    <tr className="border-t border-border align-top transition-colors duration-150 hover:bg-muted/50">
                      <td className="px-3.5 py-2.5 text-foreground">
                        {t(`kinds.${r.kind}`)}
                        <span className="block text-xs text-muted-foreground">
                          {t(`formats.${r.format ?? "csv"}`)}{r.scheduled ? ` · ${t("scheduledRun")}` : ""}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
                        {t("rangeValue", { from: day(r.params.from), to: day(r.params.to) })}
                      </td>
                      <td className="px-3.5 py-2.5 text-muted-foreground">
                        {format.dateTime(new Date(r.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                        {r.requestedBy && <span className="block text-xs">{r.requestedBy.name || t("formerMember")}</span>}
                      </td>
                      <td className="px-3.5 py-2.5">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[r.status]}`}>
                          {t(`status.${r.status}`)}
                        </span>
                        {r.status === "ready" && r.rowCount !== null && (
                          <span className="block text-xs text-muted-foreground">
                            {t("rows", { count: r.rowCount })}{r.truncated ? ` · ${r.format === "pdf" ? t("truncatedPdf") : t("truncated")}` : ""}
                          </span>
                        )}
                        {r.status === "ready" && (
                          <span className="block text-xs text-muted-foreground">
                            {t("expires", { date: format.dateTime(new Date(r.expiresAt), { dateStyle: "medium" }) })}
                          </span>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 text-right">
                        {r.status === "ready" ? (
                          <span className="inline-flex gap-1">
                            <a href={`/api/analytics/reports/${r.id}/download`} download
                              className={buttonVariants({ size: "sm", variant: "outline" })}>
                              <Download className="size-4" />
                              {t("download")}
                            </a>
                            <Button type="button" size="sm" variant="ghost" aria-expanded={sharing === r.id}
                              onClick={() => setSharing((id) => (id === r.id ? null : r.id))}>
                              <Share2 className="size-4" />
                              {t("share.open")}
                            </Button>
                          </span>
                        ) : (r.status === "queued" || r.status === "running") ? (
                          <Loader2 className="ml-auto size-4 animate-spin text-primary" aria-label={t("status.running")} />
                        ) : null}
                      </td>
                    </tr>
                    {sharing === r.id && r.status === "ready" && (
                      <tr className="border-t border-border">
                        <td colSpan={5} className="px-3.5 py-2.5">
                          <SharePanel reportId={r.id} kind={r.kind} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <SchedulesPanel />
    </div>
  );
}
