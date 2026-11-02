"use client";

/**
 * Settings → Inbox: routing rules. When a customer writes and no bot is
 * handling the conversation, the first enabled rule (top to bottom) whose
 * conditions all match assigns it to one member or round robin over several;
 * optionally an unanswered conversation moves on to the next member after a
 * while. Admins and owners only (GET/POST/PUT/DELETE /api/inbox/routing-rules
 * and POST /api/inbox/routing-rules/reorder).
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import { createClient } from "@/lib/data/client";
import { MAX_KEYWORDS, MAX_ROUTING_RULES, type AssignTo, type RoutingRule, type RoutingRuleInput } from "@/lib/inbox/routing-contract";
import { NumberSelect } from "../numbers/number-select";
import { useWhatsAppNumbers } from "../numbers/use-whatsapp-numbers";

interface Member { user_id: string; full_name: string; email: string | null; role: string }
interface Tag { id: string; name: string }
interface Team { id: string; name: string }
type HoursChoice = "any" | "within" | "outside";

const ENDPOINT = "/api/inbox/routing-rules";
const json = { "content-type": "application/json" };

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await authFetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : fallback);
  return body as T;
}

const toInput = (rule: RoutingRule): RoutingRuleInput => ({
  name: rule.name, enabled: rule.enabled, conditions: rule.conditions, assign_to: rule.assign_to,
  reassign_after_minutes: rule.reassign_after_minutes,
});

export function RoutingRulesCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.routingRules");
  const { numbers } = useWhatsAppNumbers();
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(canEdit);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [ruleRes, memberRes, tagRes, teamRes] = await Promise.all([
        authFetch(ENDPOINT, { cache: "no-store" }),
        authFetch("/api/account/members", { cache: "no-store" }),
        createClient().from("tags").select("id,name").order("name"),
        authFetch("/api/teams", { cache: "no-store" }),
      ]);
      if (!ruleRes.ok || !memberRes.ok) throw new Error();
      setRules(((await ruleRes.json()) as { rules: RoutingRule[] }).rules);
      setMembers(((await memberRes.json()) as { members: Member[] }).members.filter((m) => m.role !== "viewer"));
      setTags((tagRes.data ?? []) as Tag[]);
      // Teams are optional here: without them the team option is simply not offered.
      setTeams(teamRes.ok ? ((await teamRes.json()) as { teams: Team[] }).teams : []);
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

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (rule: RoutingRule, enabled: boolean) => run(async () => {
    const { rule: saved } = await call<{ rule: RoutingRule }>(`${ENDPOINT}/${rule.id}`,
      { method: "PUT", headers: json, body: JSON.stringify({ ...toInput(rule), enabled }) }, t("saveFailed"));
    setRules((list) => list.map((r) => (r.id === saved.id ? saved : r)));
  });

  const move = (index: number, delta: number) => run(async () => {
    const ids = rules.map((r) => r.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    const { rules: saved } = await call<{ rules: RoutingRule[] }>(`${ENDPOINT}/reorder`,
      { method: "POST", headers: json, body: JSON.stringify({ ids }) }, t("saveFailed"));
    setRules(saved);
  });

  const remove = (rule: RoutingRule) => run(async () => {
    if (!window.confirm(t("deleteConfirm", { name: rule.name }))) return;
    await call(`${ENDPOINT}/${rule.id}`, { method: "DELETE" }, t("deleteFailed"));
    setRules((list) => list.filter((r) => r.id !== rule.id));
    toast.success(t("deleted"));
  });

  const memberName = (id: string) => {
    const member = members.find((m) => m.user_id === id);
    return member ? member.full_name || member.email || t("unknownMember") : t("unknownMember");
  };
  const assigneeSummary = (assignTo: AssignTo) => assignTo.mode === "member"
    ? memberName(assignTo.user_id)
    : assignTo.mode === "team"
      ? t("teamSummary", { team: teams.find((team) => team.id === assignTo.team_id)?.name ?? t("unknownTeam") })
      : t("roundRobinSummary", { names: assignTo.user_ids.map(memberName).join(", ") });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canEdit ? (
          <p className="text-xs text-muted-foreground">{t("adminsOnly")}</p>
        ) : loading ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : loadFailed ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : (
          <>
            {rules.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
            <ol className="space-y-2">
              {rules.map((rule, i) => (
                <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                  <Switch checked={rule.enabled} disabled={busy} onCheckedChange={(on) => toggle(rule, on)}
                    aria-label={t("enabledLabel", { name: rule.name })} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{i + 1}. {rule.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {assigneeSummary(rule.assign_to)}
                      {rule.reassign_after_minutes ? ` · ${t("reassignSummary", { minutes: rule.reassign_after_minutes })}` : ""}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("moveUp")} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("moveDown")} disabled={busy || i === rules.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("edit")} disabled={busy} onClick={() => setEditing(rule)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("delete")} disabled={busy} onClick={() => remove(rule)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ol>
            {rules.length < MAX_ROUTING_RULES && (
              <Button type="button" variant="outline" size="sm" disabled={busy || members.length === 0} onClick={() => setEditing("new")}>
                <Plus className="size-3.5" /> {t("add")}
              </Button>
            )}
            {editing && (
              <RuleDialog
                rule={editing === "new" ? null : editing}
                members={members}
                teams={teams}
                tags={tags}
                numbers={numbers}
                onClose={() => setEditing(null)}
                onSaved={(saved) => {
                  setRules((list) => (list.some((r) => r.id === saved.id) ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved]));
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

function RuleDialog({ rule, members, teams, tags, numbers, onClose, onSaved }: {
  rule: RoutingRule | null;
  members: Member[];
  teams: Team[];
  tags: Tag[];
  numbers: ReturnType<typeof useWhatsAppNumbers>["numbers"];
  onClose: () => void;
  onSaved: (rule: RoutingRule) => void;
}) {
  const t = useTranslations("Settings.routingRules");
  const [name, setName] = useState(rule?.name ?? "");
  const [tagIds, setTagIds] = useState<string[]>(rule?.conditions.tags_any ?? []);
  const [keywords, setKeywords] = useState((rule?.conditions.keywords_any ?? []).join(", "));
  const [numberId, setNumberId] = useState<string | null>(rule?.conditions.whatsapp_config_id ?? null);
  const [hours, setHours] = useState<HoursChoice>(
    rule?.conditions.within_working_hours === undefined ? "any" : rule.conditions.within_working_hours ? "within" : "outside");
  const [mode, setMode] = useState<AssignTo["mode"]>(rule?.assign_to.mode ?? "member");
  const [assignees, setAssignees] = useState<string[]>(
    rule ? (rule.assign_to.mode === "member" ? [rule.assign_to.user_id] : rule.assign_to.mode === "team" ? [] : rule.assign_to.user_ids) : []);
  const [teamId, setTeamId] = useState(rule?.assign_to.mode === "team" ? rule.assign_to.team_id : teams[0]?.id ?? "");
  const [reassign, setReassign] = useState(rule?.reassign_after_minutes ? String(rule.reassign_after_minutes) : "");
  const [saving, setSaving] = useState(false);

  const toggleIn = (list: string[], id: string, on: boolean) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id));

  const save = async () => {
    setSaving(true);
    try {
      const words = keywords.split(",").map((w) => w.trim()).filter(Boolean).slice(0, MAX_KEYWORDS);
      const input: RoutingRuleInput = {
        name: name.trim(),
        enabled: rule?.enabled ?? true,
        conditions: {
          ...(tagIds.length ? { tags_any: tagIds } : {}),
          ...(words.length ? { keywords_any: words } : {}),
          ...(numberId ? { whatsapp_config_id: numberId } : {}),
          ...(hours === "any" ? {} : { within_working_hours: hours === "within" }),
        },
        assign_to: mode === "member" ? { mode, user_id: assignees[0] ?? "" }
          : mode === "team" ? { mode, team_id: teamId } : { mode, user_ids: assignees },
        reassign_after_minutes: reassign.trim() ? Number(reassign) : null,
      };
      const { rule: saved } = await call<{ rule: RoutingRule }>(rule ? `${ENDPOINT}/${rule.id}` : ENDPOINT,
        { method: rule ? "PUT" : "POST", headers: json, body: JSON.stringify(input) }, t("saveFailed"));
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
      <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{rule ? t("editTitle") : t("addTitle")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="routing-rule-name">{t("name")}</Label>
            <Input id="routing-rule-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="bg-muted" />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-foreground">{t("conditions")}</legend>
            <p className="text-xs text-muted-foreground">{t("conditionsHint")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="routing-rule-keywords">{t("keywords")}</Label>
              <Input id="routing-rule-keywords" value={keywords} placeholder={t("keywordsPlaceholder")}
                onChange={(e) => setKeywords(e.target.value)} className="bg-muted" />
            </div>
            {tags.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm text-foreground">{t("tags")}</p>
                <div className="flex flex-wrap gap-3">
                  {tags.map((tag) => (
                    <label key={tag.id} className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                      <Checkbox checked={tagIds.includes(tag.id)} onCheckedChange={(on) => setTagIds(toggleIn(tagIds, tag.id, on === true))} />
                      {tag.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {numbers.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="routing-rule-number">{t("number")}</Label>
                <NumberSelect id="routing-rule-number" numbers={numbers} value={numberId} onChange={setNumberId} emptyLabel={t("anyNumber")} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="routing-rule-hours">{t("hours")}</Label>
              <select id="routing-rule-hours" value={hours} onChange={(e) => setHours(e.target.value as HoursChoice)}
                className="border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm">
                <option value="any">{t("hoursAny")}</option>
                <option value="within">{t("hoursWithin")}</option>
                <option value="outside">{t("hoursOutside")}</option>
              </select>
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">{t("assignTo")}</legend>
            <select aria-label={t("assignMode")} value={mode}
              onChange={(e) => { setMode(e.target.value as AssignTo["mode"]); setAssignees(assignees.slice(0, 1)); }}
              className="border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm">
              <option value="member">{t("modeMember")}</option>
              <option value="round_robin">{t("modeRoundRobin")}</option>
              {(teams.length > 0 || mode === "team") && <option value="team">{t("modeTeam")}</option>}
            </select>
            {mode === "team" ? (
              <select aria-label={t("team")} value={teamId} onChange={(e) => setTeamId(e.target.value)}
                className="border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm">
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {members.map((member) => (
                <label key={member.user_id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={assignees.includes(member.user_id)}
                    onCheckedChange={(on) => setAssignees(mode === "member"
                      ? (on === true ? [member.user_id] : [])
                      : toggleIn(assignees, member.user_id, on === true))}
                  />
                  <span className="min-w-0 truncate">{member.full_name || member.email}</span>
                </label>
              ))}
            </div>
            )}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="routing-rule-reassign">{t("reassign")}</Label>
            <Input id="routing-rule-reassign" type="number" inputMode="numeric" min={1} max={10080} step={1}
              placeholder={t("off")} value={reassign} onChange={(e) => setReassign(e.target.value)} className="bg-muted sm:max-w-[10rem]" />
            <p className="text-xs text-muted-foreground">{t("reassignHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button type="button" onClick={save} disabled={saving || !name.trim() || (mode === "team" ? !teamId : assignees.length === 0)}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
