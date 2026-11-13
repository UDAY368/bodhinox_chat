"use client";

/**
 * Share one ready report with members of this workspace (admins and owners).
 * A share opens only for someone signed in to this workspace whose role is at
 * least the chosen minimum, until it expires (at most 7 days, never past the
 * report's own expiry) or is revoked. The minimum role can never be below the
 * lowest role that sees the same data live (shareRolesFor). The link carries
 * only the share id. Every open is counted and audit-logged.
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import { shareRolesFor, type RunKind, type ShareRole } from "@/lib/analytics/report-kinds";

const EXPIRY_HOURS = [24, 72, 168] as const;
const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-lg border px-2.5 text-[13px] transition-colors duration-150 hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export interface ReportShareView {
  id: string;
  minRole: ShareRole;
  path: string;
  url?: string | null;
  createdBy: { userId: string; name: string | null };
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
}

const linkFor = (share: Pick<ReportShareView, "path" | "url">) =>
  share.url || (typeof window === "undefined" ? share.path : new URL(share.path, window.location.origin).toString());

export function SharePanel({ reportId, kind }: { reportId: string; kind: RunKind }) {
  const t = useTranslations("Analytics.reports.share");
  const format = useFormatter();
  const roles = shareRolesFor(kind);
  const [minRole, setMinRole] = useState<ShareRole>(roles[0]);
  const [hours, setHours] = useState<number>(72);
  const [shares, setShares] = useState<ReportShareView[] | null>(null);
  const [created, setCreated] = useState<ReportShareView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`/api/analytics/reports/${reportId}/shares`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      setShares(((await res.json()) as { shares: ReportShareView[] }).shares);
    } catch {
      setError(t("loadFailed"));
    }
  }, [reportId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await authFetch(`/api/analytics/reports/${reportId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min_role: minRole, expires_in_hours: hours }),
      });
      const body = (await res.json().catch(() => null)) as { share?: ReportShareView; error?: string } | null;
      if (!res.ok || !body?.share) {
        setError(body?.error || t("createFailed"));
        return;
      }
      setCreated(body.share);
      await load();
    } catch {
      setError(t("createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      const res = await authFetch(`/api/analytics/reports/${reportId}/shares/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error();
      if (created?.id === id) setCreated(null);
      await load();
    } catch {
      setError(t("revokeFailed"));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const state = (s: ReportShareView) =>
    s.revokedAt ? t("revoked") : Date.parse(s.expiresAt) <= Date.now() ? t("expired") : t("active");

  return (
    <div className="space-y-3 rounded-xl bg-muted/60 p-3.5">
      <p className="text-xs text-muted-foreground">{t("explain")}</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`share-role-${reportId}`}>{t("minRole")}</Label>
          <select id={`share-role-${reportId}`} value={minRole} onChange={(e) => setMinRole(e.target.value as ShareRole)} className={selectClass}>
            {roles.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`share-expiry-${reportId}`}>{t("expiresIn")}</Label>
          <select id={`share-expiry-${reportId}`} value={hours} onChange={(e) => setHours(Number(e.target.value))} className={selectClass}>
            {EXPIRY_HOURS.map((h) => <option key={h} value={h}>{t(`hours.${h}`)}</option>)}
          </select>
        </div>
        <Button type="button" size="sm" onClick={create} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t("create")}
        </Button>
      </div>
      {created && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="max-w-full truncate rounded bg-card px-2 py-1 text-xs text-foreground">{linkFor(created)}</code>
          <Button type="button" size="sm" variant="outline" onClick={() => copy(linkFor(created))}>
            <Copy className="size-4" />
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {shares === null ? (
        <Loader2 className="size-4 animate-spin text-primary" />
      ) : shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1 last:border-0">
              <span className="text-foreground">
                {t("summary", { role: t(`roles.${s.minRole}`), date: when(s.expiresAt), count: s.openCount })}
                <span className="ml-2 text-muted-foreground">{state(s)}</span>
              </span>
              {!s.revokedAt && Date.parse(s.expiresAt) > Date.now() && (
                <span className="flex gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => copy(linkFor(s))}>{t("copy")}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => revoke(s.id)}>{t("revoke")}</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
