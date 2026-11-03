"use client";

/**
 * Analytics → Reports: request a CSV report (campaign day-wise, campaign
 * summary, campaigns per member, agent performance) for a date range, then
 * download it when the worker has built it. Admins and owners only
 * (POST/GET /api/analytics/reports; downloads go through the audit-logged
 * /api/analytics/reports/[id]/download). Polls while a report is building.
 * Files hold counts and names only, never message content, and expire after
 * 30 days.
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";

export const REPORT_KIND_OPTIONS = ["campaign_daily", "campaign_summary", "member_campaigns", "agent_performance"] as const;
type Kind = (typeof REPORT_KIND_OPTIONS)[number];
const PRESETS = ["7d", "30d", "90d", "custom"] as const;
type Preset = (typeof PRESETS)[number];
type Status = "queued" | "running" | "ready" | "failed" | "expired";

export interface ReportRunView {
  id: string;
  kind: Kind;
  status: Status;
  params: { from: string; to: string; timezone: string };
  requestedBy: { userId: string; name: string | null } | null;
  rowCount: number | null;
  truncated: boolean;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm";
const POLL_MS = 5_000;
const statusClass: Record<Status, string> = {
  queued: "text-muted-foreground",
  running: "text-primary",
  ready: "text-foreground",
  failed: "text-destructive",
  expired: "text-muted-foreground",
};

export function ReportsTab({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Analytics.reports");
  const format = useFormatter();
  const [kind, setKind] = useState<Kind>("campaign_summary");
  const [preset, setPreset] = useState<Preset>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [email, setEmail] = useState(false);
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
        body: JSON.stringify(preset === "custom" ? { kind, preset, from, to, email } : { kind, preset, email }),
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
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_auto_auto] lg:items-end" onSubmit={submit}>
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
            <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2 lg:col-span-4">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="size-4" />
              {t("emailMe")}
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">{t("kind")}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("range")}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("requested")}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("statusLabel")}</th>
                    <th scope="col" className="py-2 font-medium"><span className="sr-only">{t("download")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className="border-b border-border align-top last:border-0">
                      <td className="py-2 pr-3 text-foreground">{t(`kinds.${r.kind}`)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {t("rangeValue", { from: day(r.params.from), to: day(r.params.to) })}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {format.dateTime(new Date(r.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                        {r.requestedBy && <span className="block text-xs">{r.requestedBy.name || t("formerMember")}</span>}
                      </td>
                      <td className={`py-2 pr-3 ${statusClass[r.status]}`}>
                        {t(`status.${r.status}`)}
                        {r.status === "ready" && r.rowCount !== null && (
                          <span className="block text-xs text-muted-foreground">
                            {t("rows", { count: r.rowCount })}{r.truncated ? ` · ${t("truncated")}` : ""}
                          </span>
                        )}
                        {r.status === "ready" && (
                          <span className="block text-xs text-muted-foreground">
                            {t("expires", { date: format.dateTime(new Date(r.expiresAt), { dateStyle: "medium" }) })}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {r.status === "ready" ? (
                          <a href={`/api/analytics/reports/${r.id}/download`} download
                            className={buttonVariants({ size: "sm", variant: "outline" })}>
                            <Download className="size-4" />
                            {t("download")}
                          </a>
                        ) : (r.status === "queued" || r.status === "running") ? (
                          <Loader2 className="ml-auto size-4 animate-spin text-primary" aria-label={t("status.running")} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
