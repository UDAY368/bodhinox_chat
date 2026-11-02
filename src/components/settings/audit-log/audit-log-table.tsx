"use client";

/**
 * Settings → Audit log: who did what in the workspace, newest first, for
 * admins and owners (GET /api/audit-log). Filters by member, action and date
 * range; "Load more" follows the server cursor. Entries carry identifiers and
 * counts only, never secrets or message content.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";

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
interface Filters { actor: string; action: string; from: string; to: string }

const EMPTY: Filters = { actor: "", action: "", from: "", to: "" };
const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm";

function queryFor(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  // Date inputs are local calendar days; send the whole day.
  if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function AuditLogTable({ canView }: { canView: boolean }) {
  const t = useTranslations("Settings.auditLog");
  const format = useFormatter();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(canView);
  const [failed, setFailed] = useState(false);

  const fetchPage = useCallback(async (f: Filters, after: string | null) => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/audit-log?${queryFor(f, after)}`, { cache: "no-store" });
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
    void fetchPage(applied, null);
  }, [canView, applied, fetchPage]);

  useEffect(() => {
    if (!canView) return;
    void authFetch("/api/account/members", { cache: "no-store" })
      .then(async (res) => (res.ok ? setMembers(((await res.json()) as { members: Member[] }).members) : undefined))
      .catch(() => undefined);
  }, [canView]);

  if (!canView) return <p className="text-sm text-muted-foreground">{t("adminsOnly")}</p>;

  const set = (key: keyof Filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const details = (entry: Entry) =>
    Object.entries(entry.metadata).map(([key, value]) => `${key}: ${value === null ? "-" : String(value)}`).join(" · ");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto] lg:items-end"
          onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">{t("member")}</Label>
            <select id="audit-actor" value={filters.actor} onChange={(e) => set("actor")(e.target.value)} className={selectClass}>
              <option value="">{t("anyMember")}</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">{t("action")}</Label>
            <select id="audit-action" value={filters.action} onChange={(e) => set("action")(e.target.value)} className={selectClass}>
              <option value="">{t("anyAction")}</option>
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-from">{t("from")}</Label>
            <Input id="audit-from" type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)} className="bg-muted" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-to">{t("to")}</Label>
            <Input id="audit-to" type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)} className="bg-muted" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={loading}>{t("apply")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={loading}
              onClick={() => { setFilters(EMPTY); setApplied(EMPTY); }}>{t("reset")}</Button>
          </div>
        </form>

        {failed ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : entries.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">{t("when")}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t("member")}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t("action")}</th>
                  <th scope="col" className="py-2 font-medium">{t("details")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-border align-top last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                      {format.dateTime(new Date(entry.created_at), { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="py-2 pr-3 text-foreground">
                      {entry.actor ? entry.actor.name || t("formerMember") : t("system")}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-foreground">{entry.action}</td>
                    <td className="py-2 text-xs break-all text-muted-foreground">{details(entry) || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && <Loader2 className="size-4 animate-spin text-primary" />}
        {cursor && !loading && (
          <Button type="button" variant="outline" size="sm" onClick={() => fetchPage(applied, cursor)}>{t("loadMore")}</Button>
        )}
      </CardContent>
    </Card>
  );
}
