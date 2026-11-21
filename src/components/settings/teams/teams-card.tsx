"use client";

/**
 * Settings → Team members: teams. Named groups of members that routing rules
 * can target (round robin over the team) and that agents can filter the inbox
 * by ("My team"). Admins and owners manage them (GET/POST /api/teams,
 * PUT/DELETE /api/teams/[id]); everyone else does not see this card.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageLoading } from "@/components/ui/page-loading";
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsMoreMenu } from "../settings-row";
import { InlineError } from "@/components/ui/inline-error";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  const confirm = useConfirm();
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
    if (!(await confirm({ title: t("deleteConfirm", { name: team.name }), confirmLabel: t("delete", { name: team.name }), destructive: true }))) return;
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
    <SettingsGroup
      title={t("title")}
      footer={t("description")}
      action={!loading && !loadFailed ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing("new")}>
          <Plus className="size-3.5" /> {t("add")}
        </Button>
      ) : undefined}
    >
      {loading ? (
        <SettingsBlock><PageLoading rows={3} /></SettingsBlock>
      ) : loadFailed ? (
        <SettingsBlock><InlineError message={t("loadFailed")} onRetry={() => void load()} /></SettingsBlock>
      ) : (
        <>
          {teams.length === 0 && (
            <SettingsBlock><p className="text-sm text-muted-foreground">{t("empty")}</p></SettingsBlock>
          )}
          {teams.map((team) => (
            <div key={team.id} className={`${SETTINGS_ROW_HAIRLINE} flex min-h-11 items-center gap-1 pr-2`}>
              {/* Tapping the row edits the team; deleting sits in its more menu. */}
              <button type="button" aria-label={t("edit", { name: team.name })} disabled={busy}
                onClick={() => setEditing(team)}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted disabled:opacity-60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{team.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {team.member_ids.length ? team.member_ids.map(memberName).join(", ") : t("noMembers")}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
              </button>
              <SettingsMoreMenu actions={[
                { label: t("edit", { name: team.name }), icon: Pencil, disabled: busy, onSelect: () => setEditing(team) },
                { label: t("delete", { name: team.name }), icon: Trash2, destructive: true, disabled: busy, onSelect: () => void remove(team) },
              ]} />
            </div>
          ))}
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
    </SettingsGroup>
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
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent size="md" className="w-full gap-4 overflow-y-auto p-4">
        <SheetHeader className="p-0 pr-8">
          <SheetTitle className="text-popover-foreground">{team ? t("editTitle") : t("addTitle")}</SheetTitle>
          <SheetDescription className="text-muted-foreground">{t("dialogDescription")}</SheetDescription>
        </SheetHeader>
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
        <SheetFooter className="flex-row flex-wrap justify-end p-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button type="button" onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
