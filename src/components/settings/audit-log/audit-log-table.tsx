"use client";

/**
 * Settings → Audit log: who did what in the workspace, newest first, for
 * admins and owners (GET /api/audit-log). A free-text search, a person filter
 * and category chips up front; action and date range under "More filters";
 * "Load more" follows the server cursor; Export downloads the filtered trail
 * as CSV (GET /api/audit-log/export). Entries carry identifiers and counts
 * only, never secrets or message content.
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

interface Entry {
  id: string;
  action: string;
  actor: { user_id: string; name: string | null } | null;
  resource_id: string | null;
  metadata: Record<string, string | number | boolean | null>;
  created_at: string;
}
interface Page { entries: Entry[]; next_cursor: string | null; actions?: string[] }
interface Member { user_id: string; full_name: string; email: string | null }
export interface AuditFilters { q: string; category: string; actor: string; action: string; from: string; to: string }

/** The category chips, in the prototype's order; '' is All. Ids match the server's AUDIT_CATEGORIES. */
export const AUDIT_CHIPS = ["", "team", "channels", "billing", "security", "integrations", "settings"] as const;
const EMPTY: AuditFilters = { q: "", category: "", actor: "", action: "", from: "", to: "" };
const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Query string for the list or the export (pure). */
export function auditQuery(filters: AuditFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim().slice(0, 80));
  if (filters.category) params.set("category", filters.category);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  // Date inputs are local calendar days; send the whole day.
  if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function AuditLogTable({ canView, showHeader = true }: { canView: boolean; showHeader?: boolean }) {
  const t = useTranslations("Settings.auditLog");
  const tr = useTranslations("SettingsRedesign.audit");
  const format = useFormatter();
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const [query, setQuery] = useState<AuditFilters>(EMPTY);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(canView);
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Typing filters after a short pause; chips and selects apply at once.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(filters), filters.q === query.q ? 0 : 300);
    return () => window.clearTimeout(id);
  }, [filters, query.q]);

  const fetchPage = useCallback(async (f: AuditFilters, after: string | null) => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/audit-log?${auditQuery(f, after)}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const page = (await res.json()) as Page;
      setEntries((list) => (after ? [...list, ...page.entries] : page.entries));
      if (page.actions) setActions(page.actions);
      setCursor(page.next_cursor);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    void fetchPage(query, null);
  }, [canView, query, fetchPage]);

  useEffect(() => {
    if (!canView) return;
    void authFetch("/api/account/members", { cache: "no-store" })
      .then(async (res) => (res.ok ? setMembers(((await res.json()) as { members: Member[] }).members) : undefined))
      .catch(() => undefined);
  }, [canView]);

  if (!canView) return <p className="text-sm text-muted-foreground">{t("adminsOnly")}</p>;

  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const details = (entry: Entry) =>
    Object.entries(entry.metadata).map(([key, value]) => `${key}: ${value === null ? "-" : String(value)}`).join(" · ");
  const filtered = JSON.stringify(query) !== JSON.stringify(EMPTY);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await authFetch(`/api/audit-log/export?${auditQuery(query, null)}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const rows = Number(res.headers.get("X-Rows") ?? "0");
      if (!rows) {
        toast.error(tr("nothingToExport"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(res.headers.get("X-Truncated") ? tr("exportedTruncated", { count: rows }) : tr("exported", { count: rows }));
    } catch {
      toast.error(tr("exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const exportButton = (
    <Button type="button" variant="outline" onClick={() => void exportCsv()} disabled={exporting || loading}>
      {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} {tr("export")}
    </Button>
  );

  return (
    <section className="space-y-4">
      {showHeader ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-[19px] font-bold tracking-tight text-foreground">{t("title")}</h2>
            <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{tr("description")}</p>
          </div>
          <div className="shrink-0">{exportButton}</div>
        </div>
      ) : (
        <div className="flex justify-end">{exportButton}</div>
      )}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <label className="relative block min-w-0">
          <span className="sr-only">{tr("search")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={filters.q} maxLength={80} placeholder={tr("search")} onChange={(e) => set("q", e.target.value)} className="bg-card pl-8" />
        </label>
        <select aria-label={tr("person")} value={filters.actor} onChange={(e) => set("actor", e.target.value)} className={selectClass}>
          <option value="">{tr("everyone")}</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr("categories")}>
        {AUDIT_CHIPS.map((chip) => {
          const on = filters.category === chip;
          return (
            <button key={chip || "all"} type="button" aria-pressed={on} onClick={() => set("category", chip)}
              className={cn(
                "min-h-8 rounded-full border px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-transparent bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}>
              {tr(`chips.${chip || "all"}`)}
            </button>
          );
        })}
      </div>

      <details className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">{tr("moreFilters")}</summary>
        <div className="grid gap-3 pt-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">{t("action")}</Label>
            <select id="audit-action" value={filters.action} onChange={(e) => set("action", e.target.value)} className={selectClass}>
              <option value="">{t("anyAction")}</option>
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-from">{t("from")}</Label>
            <Input id="audit-from" type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} className="bg-muted" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-to">{t("to")}</Label>
            <Input id="audit-to" type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} className="bg-muted" />
          </div>
        </div>
      </details>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {failed ? (
          <p role="alert" className="px-4 py-6 text-sm text-destructive">{t("loadFailed")}</p>
        ) : entries.length === 0 && !loading ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <Search className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-foreground">{tr("noMatch")}</p>
            <p className="text-xs text-muted-foreground">{tr("noMatchHint")}</p>
            {filtered && <Button type="button" variant="outline" size="sm" onClick={() => setFilters(EMPTY)}>{tr("clear")}</Button>}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li key={entry.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,11rem)] sm:items-center sm:gap-4">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[13px] font-medium text-foreground">{entry.action}</p>
                  <p className="text-xs break-all text-muted-foreground">{details(entry) || entry.resource_id || "-"}</p>
                </div>
                <Badge variant="outline" className="w-fit">{tr(`chips.${categoryFor(entry.action) || "other"}`)}</Badge>
                <div className="min-w-0 text-xs sm:text-right">
                  <p className="truncate text-foreground">{entry.actor ? entry.actor.name || t("formerMember") : t("system")}</p>
                  <p className="text-muted-foreground">{format.dateTime(new Date(entry.created_at), { dateStyle: "medium", timeStyle: "short" })}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {loading && <Loader2 className="size-4 animate-spin text-primary" aria-label={tr("loading")} />}
        {cursor && !loading && (
          <Button type="button" variant="outline" size="sm" onClick={() => fetchPage(query, cursor)}>{t("loadMore")}</Button>
        )}
        <p className="text-xs text-muted-foreground" aria-live="polite">{tr("shown", { count: entries.length })}</p>
      </div>
    </section>
  );
}

/** Mirrors the server's categoryOf for the row badge (pure). */
export function categoryFor(action: string): (typeof AUDIT_CHIPS)[number] {
  const rules: [Exclude<(typeof AUDIT_CHIPS)[number], "">, string[]][] = [
    ["billing", ["billing.", "plan.", "settings.billing", "subscription."]],
    ["team", ["team.", "member.", "membership.", "invitation.", "invite.", "role.", "permission"]],
    ["channels", ["channels.", "whatsapp", "instagram.", "templates.", "template."]],
    ["security", ["auth.", "support.", "mfa.", "session", "api_key", "security."]],
    ["integrations", ["integrations.", "webhook", "shopify", "woocommerce", "razorpay", "payments.", "zoom", "meta_ads", "ads.", "google"]],
    ["settings", ["settings.", "workspace.", "account.", "inbox.", "quick_repl", "tags.", "custom_fields.", "audit_log."]],
  ];
  for (const [category, prefixes] of rules) if (prefixes.some((p) => action.startsWith(p))) return category;
  return "";
}
