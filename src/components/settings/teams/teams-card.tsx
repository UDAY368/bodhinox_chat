"use client";

/**
 * Settings → Team members: teams. Named groups of members that routing rules
 * can target (round robin over the team) and that agents can filter the inbox
 * by ("My team"). Admins and owners manage them (GET/POST /api/teams,
 * PUT/DELETE /api/teams/[id]); everyone else does not see this card.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";

interface Member { user_id: string; full_name: string; email: string | null }
export interface TeamView { id: string; name: string; member_ids: string[] }

const ENDPOINT = "/api/teams";
const json = { "content-type": "application/json" };
const MAX_NAME = 80;

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await authFetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : fallback);
  return body as T;
}

export function TeamsCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.teams");
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(canEdit);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TeamView | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [teamRes, memberRes] = await Promise.all([
        authFetch(ENDPOINT, { cache: "no-store" }),
        authFetch("/api/account/members", { cache: "no-store" }),
      ]);
      if (!teamRes.ok || !memberRes.ok) throw new Error();
      setTeams(((await teamRes.json()) as { teams: TeamView[] }).teams);
      setMembers(((await memberRes.json()) as { members: Member[] }).members);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canEdit) void load();
  }, [canEdit, load]);

  if (!canEdit) return null;

  const memberName = (id: string) => {
    const member = members.find((m) => m.user_id === id);
    return member ? member.full_name || member.email || t("unknownMember") : t("unknownMember");
  };

  const remove = async (team: TeamView) => {
    if (!window.confirm(t("deleteConfirm", { name: team.name }))) return;
    setBusy(true);
    try {
      await call(`${ENDPOINT}/${team.id}`, { method: "DELETE" }, t("deleteFailed"));
      setTeams((list) => list.filter((x) => x.id !== team.id));
      toast.success(t("deleted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : loadFailed ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : (
          <>
            {teams.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
            <ul className="space-y-2">
              {teams.map((team) => (
                <li key={team.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{team.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {team.member_ids.length ? team.member_ids.map(memberName).join(", ") : t("noMembers")}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("edit", { name: team.name })} disabled={busy}
                    onClick={() => setEditing(team)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("delete", { name: team.name })} disabled={busy}
                    onClick={() => remove(team)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditing("new")}>
              <Plus className="size-3.5" /> {t("add")}
            </Button>
            {editing && (
              <TeamDialog
                team={editing === "new" ? null : editing}
                members={members}
                onClose={() => setEditing(null)}
                onSaved={(saved) => {
                  setTeams((list) => (list.some((x) => x.id === saved.id)
                    ? list.map((x) => (x.id === saved.id ? saved : x))
                    : [...list, saved].sort((a, b) => a.name.localeCompare(b.name))));
                  setEditing(null);
                }}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TeamDialog({ team, members, onClose, onSaved }: {
  team: TeamView | null;
  members: Member[];
  onClose: () => void;
  onSaved: (team: TeamView) => void;
}) {
  const t = useTranslations("Settings.teams");
  const [name, setName] = useState(team?.name ?? "");
  const [selected, setSelected] = useState<string[]>(team?.member_ids ?? []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { team: saved } = await call<{ team: TeamView }>(team ? `${ENDPOINT}/${team.id}` : ENDPOINT, {
        method: team ? "PUT" : "POST", headers: json, body: JSON.stringify({ name: name.trim(), member_ids: selected }),
      }, t("saveFailed"));
      toast.success(t("saved"));
      onSaved(saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{team ? t("editTitle") : t("addTitle")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">{t("name")}</Label>
            <Input id="team-name" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} className="bg-muted" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">{t("members")}</legend>
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {members.map((member) => (
                <label key={member.user_id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={selected.includes(member.user_id)}
                    onCheckedChange={(on) => setSelected((list) => (on === true
                      ? [...list.filter((x) => x !== member.user_id), member.user_id]
                      : list.filter((x) => x !== member.user_id)))}
                  />
                  <span className="min-w-0 truncate">{member.full_name || member.email}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button type="button" onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
