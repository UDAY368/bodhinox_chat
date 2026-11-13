"use client";
import { authFetch } from "@/lib/auth/client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  Copy,
  Search,
  Split,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  RotateCcw,
  FileText,
  Tag,
} from "lucide-react";

import { useFormatter, useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TemplateSummary } from "@/components/flows/template-gallery";
import type { AccountMember, Channel } from "@/types";
import { cn } from "@/lib/utils";
import { creatorLabel, type CreatorLabel } from "@/lib/flows/creator-label";
import { channelPath } from "@/lib/channels/routes";
import { effectiveTriggers } from "@/lib/flows/flow-triggers";
import { isKnownTrigger } from "@/lib/automations/trigger-meta";
import type { FlowTriggerConfig, FlowTriggerType } from "@/lib/flows/types";
import { splitFlow } from "./split-flow";
import { navChannels } from "@/components/layout/page-search-navigation";
import { useWorkspaceChannels } from "@/hooks/use-workspace-channels";
import { useSearchParams } from "next/navigation";
import {
  automationItems,
  canSwitch,
  displayStatus as itemDisplayStatus,
  itemMatches,
  kindCounts,
  KIND_TABS,
  STATUS_FILTERS,
  type AutomationItem,
  type FlowRow,
  type ItemStatus,
  type KindTab,
  type RuleRow,
  type SequenceRow,
  type StatusFilter,
} from "@/components/automation/automation-items";
import { duplicateRule, removeItem, rename, setLive } from "@/components/automation/automation-actions";
import { ChannelDotMark, KIND_ICON, NewAutomationDialog, type NewAutomationInput } from "@/components/automation/new-automation-dialog";
import { RenameDialog } from "@/components/automation/rename-dialog";
import { sequenceApi, sequenceErrorKey } from "@/components/sequences/sequence-api";

/**
 * Automation: flows, rules and sequences in one list (`channel="all"`,
 * /automation), with All / Flows / Rules / Sequences tabs and their counts, a
 * status, channel and trigger filter and a search box. Each row shows its
 * type, what starts it, runs, click-through rate (flows) and a Live switch:
 * turning it on publishes a flow, activates a rule or resumes a sequence,
 * and the server's checks refuse one with problems (the toast says how many
 * and opens it). The row menu opens, duplicates, renames, moves (flow
 * folders), splits (a legacy flow on both channels), restores (archived
 * flows), shows a rule's logs and deletes.
 *
 * A single channel (`whatsapp` / `instagram`) keeps the earlier per-channel
 * flows list with folders. Deleting a flow that was ever live archives it
 * (restorable); a draft or an archived flow is deleted; a rule is deleted; a
 * sequence is archived (its subscribers stop). On Instagram a rail links the
 * three automation tabs: My automations, Basics and Sequences. Open to every
 * authenticated user; the APIs enforce role, CSRF, tenancy and the channel rules.
 */

export type { FlowRow } from "@/components/automation/automation-items";

interface FolderRow {
  id: string;
  name: string;
  flow_count: number;
}

/** Folder filter: every flow, the top level only, or one folder. */
type FolderFilter = "all" | "none" | string;

export const displayStatus = itemDisplayStatus;

/** Whether a flow passes the list's filters (status, trigger type, folder, search). */
export function flowMatches(flow: FlowRow, filters: { status: StatusFilter; trigger: FlowTriggerType | "all"; folder: FolderFilter; query: string }): boolean {
  return itemMatches(automationItems([flow], [], [])[0], { ...filters, kind: "all", channel: "all" });
}

// Best-effort, like the flow builder's member picker. Returns null when the
// roster could not be loaded (older deployment, failed request), so cards
// drop the created-by line instead of claiming the creator left. Members
// with no visible name stay in the map so they are not mistaken for former
// members.
async function loadMemberNames(): Promise<Map<string, string> | null> {
  try {
    const res = await authFetch("/api/account/members", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { members?: AccountMember[] };
    return new Map((json.members ?? []).map((m) => [m.user_id, m.full_name || m.email || ""]));
  } catch {
    return null;
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? fallback;
}

/** The Instagram automation area's tabs (Stage 5): My automations, Basics, Sequences. */
export function AutomationHubRail({ active }: { active: "flows" | "basics" | "sequences" }) {
  const t = useTranslations("Automations.hub");
  const tabs = [
    { key: "flows", href: channelPath("instagram", "flows"), label: t("myAutomations") },
    { key: "basics", href: channelPath("instagram", "basics"), label: t("basics") },
    { key: "sequences", href: channelPath("instagram", "sequences"), label: t("sequences") },
  ] as const;
  return (
    <nav aria-label={t("myAutomations")} className="flex gap-1 overflow-x-auto border-b border-border md:w-44 md:shrink-0 md:flex-col md:border-b-0 md:border-r md:pr-3">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? "page" : undefined}
          className={cn(
            "whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
            active === tab.key ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

const isKindTab = (value: string | null): value is KindTab => !!value && (KIND_TABS as readonly string[]).includes(value);

export function FlowList({ channel }: { channel: Channel | "all" }) {
  const router = useRouter();
  const unified = channel === "all";
  const { data: channelData } = useWorkspaceChannels();
  const enabledChannels = navChannels(channelData?.enabled);
  const instagramOn = enabledChannels.includes("instagram") && (unified || channel === "instagram");
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("channel");
  const initialKind = searchParams.get("kind");
  const [channelFilter, setChannelFilter] = useState<"all" | Channel>(
    initialFilter === "whatsapp" || initialFilter === "instagram" ? initialFilter : "all",
  );
  const [kindTab, setKindTab] = useState<KindTab>(unified && isKindTab(initialKind) ? initialKind : "all");
  // The channel a new automation starts on: the list's own, or the channel filter's, else the first enabled one.
  const createChannel: Channel = unified
    ? (channelFilter !== "all" && enabledChannels.includes(channelFilter) ? channelFilter : enabledChannels[0])
    : channel;
  /** The section a flow opens in (a legacy 'any' flow opens in WhatsApp in the unified list). */
  const sectionOf = (item: { channel: Channel | "any" }): Channel =>
    unified ? (item.channel === "instagram" ? "instagram" : "whatsapp") : channel;
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tRow = useTranslations("Flows.listRow");
  const tFolders = useTranslations("Flows.folders");
  const tSection = useTranslations("Flows.channelSection");
  const tChannelName = useTranslations("Inbox.channel");
  const tGate = useTranslations("GatedButton");
  const tList = useTranslations("AutomationList");
  const tSeq = useTranslations("Instagram.sequences");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [memberNames, setMemberNames] = useState<Map<string, string> | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [triggerFilter, setTriggerFilter] = useState<FlowTriggerType | "all">("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AutomationItem | null>(null);
  const [moving, setMoving] = useState<FlowRow | null>(null);
  const [renaming, setRenaming] = useState<AutomationItem | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ mode: "create" } | { mode: "rename"; folder: FolderRow } | null>(null);
  const editorPath = (id: string, section: Channel = createChannel) => channelPath(section, "flows", id);

  const items = useMemo(() => automationItems(flows, rules, sequences), [flows, rules, sequences]);
  const showsTriggers = kindTab === "all" || kindTab === "flow";
  const visibleItems = useMemo(
    () => items.filter((item) => itemMatches(item, {
      kind: kindTab, status: statusFilter, trigger: showsTriggers ? triggerFilter : "all", folder: folderFilter, query, channel: channelFilter,
    })),
    [items, kindTab, statusFilter, showsTriggers, triggerFilter, folderFilter, query, channelFilter],
  );
  const counts = useMemo(() => kindCounts(items), [items]);
  const triggerTypes = useMemo(
    () => [...new Set(flows.flatMap((flow) => effectiveTriggers(flow).map((trigger) => trigger.trigger_type)))].sort(),
    [flows],
  );
  const folderName = useMemo(() => new Map(folders.map((folder) => [folder.id, folder.name])), [folders]);
  const filtered = query.trim() !== "" || statusFilter !== "all" || triggerFilter !== "all" || folderFilter !== "all"
    || channelFilter !== "all" || kindTab !== "all";

  const loadFolders = useCallback(async () => {
    // Folders belong to one channel; the unified list shows none.
    if (channel === "all") return;
    try {
      const res = await authFetch(`/api/flows/folders?channel=${channel}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { folders?: FolderRow[] };
      setFolders(json.folders ?? []);
    } catch {
      // Folders are an aid: the list still works without them.
    }
  }, [channel]);

  const loadRules = useCallback(async () => {
    // The unified list holds the channels' rules too; a failure leaves them out (the flows still list).
    if (!unified) return;
    try {
      const res = await authFetch("/api/automations", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { automations?: RuleRow[] };
      setRules(json.automations ?? []);
    } catch {
      // Rules stay reachable from their channel pages.
    }
  }, [unified]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes, names] = await Promise.all([
          authFetch(channel === "all" ? "/api/flows" : `/api/flows?channel=${channel}`),
          authFetch(channel === "all" ? "/api/flows/templates" : `/api/flows/templates?channel=${channel}`),
          loadMemberNames(),
          loadFolders(),
          loadRules(),
        ]);
        if (!cancelled) setMemberNames(names);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is stable for the page's locale; reload only when the section changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Instagram sequences list here while Instagram is on (the API answers 503 while it is off).
  useEffect(() => {
    if (!instagramOn || !unified) return;
    let live = true;
    sequenceApi.list().then((rows) => { if (live) setSequences(rows as SequenceRow[]); }, () => {});
    return () => { live = false; };
  }, [instagramOn, unified]);

  async function createFlow(name: string, section: Channel) {
    const res = await authFetch("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, trigger_type: "keyword", trigger_config: { keywords: [] }, channel_scope: section }),
    });
    if (!res.ok) throw new Error(await errorText(res, t("createError")));
    const json = (await res.json()) as { flow: FlowRow };
    router.push(editorPath(json.flow.id, section));
  }

  async function createRule(name: string, section: Channel) {
    // A draft rule (off); its builder picks the trigger and steps. New contact is the prototype's starting trigger.
    const res = await authFetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, channel: section, trigger_type: "new_contact_created", trigger_config: {}, is_active: false }),
    });
    if (!res.ok) throw new Error(await errorText(res, tList("createRuleError")));
    const json = (await res.json()) as { automation?: { id: string } };
    if (!json.automation?.id) throw new Error(tList("createRuleError"));
    router.push(channelPath(section, "automations", json.automation.id));
  }

  async function handleCreateNew(input: NewAutomationInput) {
    setCreating(true);
    try {
      if (input.kind === "flow") await createFlow(input.name, input.channel);
      else if (input.kind === "rule") await createRule(input.name, input.channel);
      else {
        try {
          const sequence = await sequenceApi.create(input.name);
          router.push(`/instagram/sequences/${encodeURIComponent(sequence.id)}`);
        } catch (error) {
          throw new Error(tSeq(`errors.${sequenceErrorKey(error)}`));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string, section: Channel) {
    setCreating(true);
    try {
      const res = await authFetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug, channel_scope: section }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(editorPath(json.flow.id, section));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  function openItem(item: AutomationItem) {
    if (item.kind === "flow") router.push(editorPath(item.id, sectionOf(item)));
    else if (item.kind === "rule") router.push(channelPath(sectionOf(item), "automations", item.id));
    else router.push(`/instagram/sequences/${encodeURIComponent(item.id)}`);
  }

  async function handleDuplicate(item: AutomationItem) {
    setBusyKey(item.key);
    try {
      if (item.kind === "rule") {
        const error = await duplicateRule(item);
        if (error !== null) { toast.error(error || tList("duplicateRuleError")); return; }
        toast.success(t("duplicateSuccess", { name: item.name }));
        await loadRules();
        return;
      }
      // The copy belongs to this section (a legacy 'any' flow's copy too).
      const res = await authFetch(`/api/flows/${item.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_scope: sectionOf(item) }),
      });
      const json = (await res.json().catch(() => ({}))) as { flow?: FlowRow; error?: string };
      if (!res.ok || !json.flow) throw new Error(json.error ?? t("duplicateError"));
      toast.success(t("duplicateSuccess", { name: json.flow.name }));
      router.push(editorPath(json.flow.id, sectionOf(item)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateError"));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSplit(item: AutomationItem) {
    setBusyKey(item.key);
    try {
      const ids = await splitFlow(item.id);
      if (!ids) {
        toast.error(tSection("splitFailed"));
        return;
      }
      toast.success(tSection("splitDone"));
      const section = unified ? "whatsapp" : channel;
      router.push(editorPath(ids[section], section));
    } finally {
      setBusyKey(null);
    }
  }

  /** Writes a row's new status into its source list. */
  function applyStatus(item: AutomationItem, status: ItemStatus) {
    if (item.kind === "flow") {
      const next: FlowRow["status"] = status === "testing" ? "draft" : status;
      setFlows((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: next } : f)));
    } else if (item.kind === "rule") {
      setRules((prev) => prev.map((r) => (r.id === item.id ? { ...r, is_active: status === "active" } : r)));
    } else {
      setSequences((prev) => prev.map((s) => (s.id === item.id ? { ...s, status: status === "active" ? "active" : "paused" } : s)));
    }
  }

  /** The Live switch: goes live through the server's checks, or stops new starts. */
  async function toggleLive(item: AutomationItem, on: boolean) {
    setBusyKey(item.key);
    try {
      const result = await setLive(item, on);
      if (result.ok) {
        applyStatus(item, result.status);
        toast.success(on ? tList("liveOn", { name: item.name }) : tList("liveOff", { name: item.name }));
      } else if (result.problems > 0) {
        toast.error(tList("hasProblems", { name: item.name, count: result.problems }), {
          action: { label: tList("openToFix"), onClick: () => openItem(item) },
        });
      } else {
        toast.error(("error" in result && result.error) || tList("liveError"));
      }
    } catch {
      toast.error(tList("liveError"));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveRename(item: AutomationItem, name: string) {
    // A network failure keeps the dialog open with the same message as a refusal.
    const error = await rename(item, name).catch(() => "");
    if (error !== null) {
      toast.error(error || tList("rename.error"));
      return;
    }
    if (item.kind === "flow") setFlows((prev) => prev.map((f) => (f.id === item.id ? { ...f, name } : f)));
    else if (item.kind === "rule") setRules((prev) => prev.map((r) => (r.id === item.id ? { ...r, name } : r)));
    else setSequences((prev) => prev.map((s) => (s.id === item.id ? { ...s, name } : s)));
    setRenaming(null);
    toast.success(tList("rename.done"));
  }

  async function setFlowStatus(flow: FlowRow, status: "archived" | "draft"): Promise<boolean> {
    const res = await authFetch(`/api/flows/${flow.id}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      toast.error(await errorText(res, t("deleteError")));
      return false;
    }
    // The server decides the resulting state: a restored flow that was ever live comes back stopped (paused).
    const json = (await res.json().catch(() => null)) as { flow?: Partial<FlowRow> } | null;
    const next = json?.flow?.status ?? status;
    setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, status: next } : f)));
    return true;
  }

  /**
   * A flow that was ever live is archived (restorable); a draft or an archived
   * flow is deleted. A rule is deleted; a sequence is archived.
   */
  async function confirmDelete(item: AutomationItem) {
    setBusyKey(item.key);
    try {
      if (item.kind !== "flow") {
        const error = await removeItem(item);
        if (error !== null) {
          toast.error(error || tList("deleteError"));
          return;
        }
        if (item.kind === "rule") setRules((prev) => prev.filter((r) => r.id !== item.id));
        else setSequences((prev) => prev.filter((s) => s.id !== item.id));
        toast.success(item.kind === "rule" ? tList("ruleDeleted") : tList("sequenceArchived"));
        return;
      }
      const flow = item.flow!;
      if (flow.published_version_id && flow.status !== "archived") {
        if (await setFlowStatus(flow, "archived")) toast.success(tRow("archivedDone"));
        return;
      }
      const res = await authFetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await errorText(res, t("deleteError")));
        return;
      }
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t("deleteSuccess"));
      void loadFolders();
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    } finally {
      setBusyKey(null);
      setDeleting(null);
    }
  }

  async function handleRestore(item: AutomationItem) {
    setBusyKey(item.key);
    try {
      if (item.flow && (await setFlowStatus(item.flow, "draft"))) toast.success(tRow("restored"));
    } finally {
      setBusyKey(null);
    }
  }

  async function moveFlow(flow: FlowRow, folderId: string | null) {
    const res = await authFetch(`/api/flows/${flow.id}/folder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    });
    if (!res.ok) {
      toast.error(await errorText(res, tFolders("saveFailed")));
      return;
    }
    setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, folder_id: folderId } : f)));
    toast.success(folderId ? tFolders("moved", { name: folderName.get(folderId) ?? "" }) : tFolders("movedTop"));
    setMoving(null);
    void loadFolders();
  }

  async function saveFolder(name: string) {
    if (!folderDialog) return;
    const res = folderDialog.mode === "create"
      ? await authFetch("/api/flows/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, name }),
        })
      : await authFetch(`/api/flows/folders/${folderDialog.folder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
    if (!res.ok) {
      toast.error(await errorText(res, tFolders("saveFailed")));
      return;
    }
    setFolderDialog(null);
    await loadFolders();
  }

  async function deleteFolder(folder: FolderRow) {
    if (!window.confirm(tFolders("deleteConfirm", { name: folder.name }))) return;
    const res = await authFetch(`/api/flows/folders/${folder.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await errorText(res, tFolders("saveFailed")));
      return;
    }
    // Its flows move to the top level (the database sets folder_id to NULL).
    setFlows((prev) => prev.map((f) => (f.folder_id === folder.id ? { ...f, folder_id: null } : f)));
    if (folderFilter === folder.id) setFolderFilter("all");
    await loadFolders();
  }

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setTriggerFilter("all");
    setFolderFilter("all");
    setChannelFilter("all");
    setKindTab("all");
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const statusLabel = (status: StatusFilter) =>
    status === "all" ? tList("anyStatus") : status === "testing" ? t("statusTesting") : tRow(`status.${STATUS_KEY[status]}`);
  const kindLabel = (kind: KindTab) => (kind === "all" ? t("filterAll") : tList(`tabs.${kind}`));
  const empty = items.length === 0 && folders.length === 0;

  const list = (
    <div className="min-w-0 flex-1">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">{unified ? t("unifiedTitle") : tSection(channel === "instagram" ? "instagramTitle" : "whatsappTitle")}</h1>
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t("beta")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {unified ? tList("description") : tSection(channel === "instagram" ? "instagramDescription" : "whatsappDescription")}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createFlows")}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("newFlow")}
        </GatedButton>
      </header>

      {empty ? (
        <div className="mt-6">
          <EmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} t={t} />
        </div>
      ) : (
        <>
          <div className="mb-3.5 mt-6 flex flex-wrap items-center justify-between gap-3">
            {unified ? (
              <div role="tablist" aria-label={tList("kindFilterLabel")}
                className="flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]">
                {KIND_TABS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    aria-selected={kindTab === kind}
                    onClick={() => setKindTab(kind)}
                    className={cn(
                      "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-primary",
                      kindTab === kind ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {kindLabel(kind)}
                    <span className="font-medium tabular-nums text-muted-foreground">{counts[kind]}</span>
                  </button>
                ))}
              </div>
            ) : <span />}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {unified && enabledChannels.length > 1 && (
                <div role="group" aria-label={t("channelFilterLabel")} className="flex flex-wrap items-center gap-1.5" data-testid="channel-filter">
                  {(["all", ...enabledChannels] as const).map((value) => (
                    <FolderChip key={value} active={channelFilter === value} onClick={() => setChannelFilter(value)}
                      label={value === "all" ? t("allChannels") : tChannelName(value)} />
                  ))}
                </div>
              )}
              <select
                aria-label={t("statusFilterLabel")}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className={cn(FILTER_SELECT, statusFilter === "all" ? "bg-card text-muted-foreground" : "border-transparent bg-primary/10 font-semibold text-primary")}
              >
                {STATUS_FILTERS.map((status) => (
                  <option key={status} value={status}>{statusLabel(status)}</option>
                ))}
              </select>
              {showsTriggers && triggerTypes.length > 0 && (
                <select
                  aria-label={tRow("triggerFilter")}
                  value={triggerFilter}
                  onChange={(e) => setTriggerFilter(e.target.value as FlowTriggerType | "all")}
                  className={cn(FILTER_SELECT, triggerFilter === "all" ? "bg-card text-muted-foreground" : "border-transparent bg-primary/10 font-semibold text-primary")}
                >
                  <option value="all">{tRow("anyTrigger")}</option>
                  {triggerTypes.map((type) => (
                    <option key={type} value={type}>{triggerTypeLabel(type, tRow)}</option>
                  ))}
                </select>
              )}
              <div className="relative w-full sm:w-[240px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={unified ? tList("searchPlaceholder") : t("searchPlaceholder")}
                  aria-label={unified ? tList("searchPlaceholder") : t("searchPlaceholder")}
                  className="h-9 rounded-xl border-transparent bg-muted pl-9 shadow-none"
                />
              </div>
            </div>
          </div>

          {!unified && (
          <div role="group" aria-label={tFolders("filterLabel")} className="mb-3.5 flex flex-wrap items-center gap-1.5">
            <FolderChip active={folderFilter === "all"} onClick={() => setFolderFilter("all")} label={tFolders("all")} />
            {folders.length > 0 && (
              <FolderChip active={folderFilter === "none"} onClick={() => setFolderFilter("none")} label={tFolders("noFolder")} />
            )}
            {folders.map((folder) => (
              <span key={folder.id} className="inline-flex items-center">
                <FolderChip
                  active={folderFilter === folder.id}
                  onClick={() => setFolderFilter(folder.id)}
                  label={folder.name}
                  count={folder.flow_count}
                  icon
                />
                {canCreate && (
                  <DropdownMenu>
                    <DropdownMenuTrigger className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label={`${tRow("actions")}: ${folder.name}`}>
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => setFolderDialog({ mode: "rename", folder })}>
                        <Pencil className="h-3.5 w-3.5" />
                        {tFolders("rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => void deleteFolder(folder)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {tFolders("delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            ))}
            {canCreate && (
              <Button variant="ghost" size="sm" onClick={() => setFolderDialog({ mode: "create" })}>
                <FolderPlus className="h-3.5 w-3.5" />
                {tFolders("new")}
              </Button>
            )}
          </div>
          )}

          {visibleItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border px-4 py-12 text-center">
              <span className="mb-2 inline-flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Search className="h-6 w-6" aria-hidden />
              </span>
              <p className="text-sm text-muted-foreground">{unified ? tList("noMatches") : t("noMatches")}</p>
              {filtered && <Button variant="outline" size="sm" className="mt-2" onClick={clearFilters}>{tList("clearFilters")}</Button>}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className={cn("hidden gap-3.5 bg-muted px-4 py-2.5 text-xs font-semibold text-muted-foreground lg:grid", ROW_GRID)}>
                <span>{tRow("nameColumn")}</span>
                <span>{tList("typeColumn")}</span>
                <span>{tList("startsWhen")}</span>
                <span className="text-right">{tRow("runs")}</span>
                <span className="text-right" title={tRow("ctrHelp")}>{tRow("ctr")}</span>
                <span>{tList("liveColumn")}</span>
                <span className="sr-only">{tRow("actions")}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {visibleItems.map((item) => (
                  <AutomationRow
                    key={item.key}
                    item={item}
                    folder={item.folderId ? folderName.get(item.folderId) ?? null : null}
                    creator={item.creatorId ? creatorLabel(memberNames, item.creatorId) : null}
                    canCreate={canCreate}
                    busy={busyKey === item.key}
                    showChannel={unified}
                    onOpen={() => openItem(item)}
                    onToggleLive={(on) => void toggleLive(item, on)}
                    onRename={() => setRenaming(item)}
                    onDuplicate={item.kind === "sequence" ? undefined : () => void handleDuplicate(item)}
                    onSplit={item.channel === "any" ? () => void handleSplit(item) : undefined}
                    onDelete={() => setDeleting(item)}
                    onRestore={item.kind === "flow" && item.status === "archived" ? () => void handleRestore(item) : undefined}
                    onMove={!unified && item.flow ? () => setMoving(item.flow!) : undefined}
                    onLogs={item.kind === "rule" ? () => router.push(channelPath(sectionOf(item), "automationLogs", item.id)) : undefined}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <NewAutomationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={unified ? enabledChannels : [channel]}
        initialChannel={createChannel}
        templates={templates}
        creating={creating}
        sequencesOn={instagramOn}
        onUseFlowTemplate={(slug, section) => void handleUseTemplate(slug, section)}
        onCreate={handleCreateNew}
        onAiCreated={(id) => { setCreateOpen(false); router.push(editorPath(id, "whatsapp")); }}
      />

      <DeleteDialog item={deleting} busy={!!deleting && busyKey === deleting.key} onCancel={() => setDeleting(null)}
        onConfirm={(item) => void confirmDelete(item)} />
      <RenameDialog item={renaming} onCancel={() => setRenaming(null)} onSave={saveRename} />
      <MoveDialog flow={moving} folders={folders} onCancel={() => setMoving(null)} onMove={(flow, id) => void moveFlow(flow, id)} />
      <FolderNameDialog state={folderDialog} onCancel={() => setFolderDialog(null)} onSave={(name) => void saveFolder(name)} />
    </div>
  );

  return channel === "instagram" || (unified && enabledChannels.includes("instagram")) ? (
    <div className="flex flex-col gap-6 md:flex-row">
      <AutomationHubRail active="flows" />
      {list}
    </div>
  ) : (
    <div>{list}</div>
  );
}

const FILTER_SELECT = "h-8 max-w-full rounded-full border border-border px-3 text-[13px] transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary";

/** The status words: Live, Stopped (paused), Draft, Archived (Testing has its own). */
const STATUS_KEY: Record<Exclude<ItemStatus, "testing">, "live" | "stopped" | "draft" | "archived"> = {
  active: "live", paused: "stopped", draft: "draft", archived: "archived",
};

/** The list's columns: name, type, starts when, runs, CTR, live, menu (name, live and menu below lg). */
const ROW_GRID = "lg:grid-cols-[minmax(0,2.1fr)_84px_minmax(0,1.6fr)_60px_56px_52px_34px]";

function FolderChip({ active, onClick, label, count, icon = false }: {
  active: boolean; onClick: () => void; label: string; count?: number; icon?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary",
        active ? "border-transparent bg-primary/10 font-semibold text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon && <Folder className="h-3 w-3" aria-hidden />}
      {label}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-14 text-center">
      <span className="mb-2 inline-flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Workflow className="h-6 w-6" />
      </span>
      <h2 className="text-[15px] font-semibold text-foreground">
        {t("emptyTitle")}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {t("emptyDesc")}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason={tGate("reasons.createFlows")}
        onClick={onCreate}
        className="mt-3"
      >
        <Plus className="h-4 w-4" />
        {t("createFirst")}
      </GatedButton>
    </div>
  );
}

/** A channel mark: the WhatsApp or Instagram dot, named for screen readers. */
function ChannelDot({ channel }: { channel: Channel }) {
  const tChannelName = useTranslations("Inbox.channel");
  return (
    <span role="img" aria-label={tChannelName(channel)} title={tChannelName(channel)} data-flow-channel={channel} className="inline-flex">
      <ChannelDotMark channel={channel} />
    </span>
  );
}

/** What starts a row, in plain words: a flow's triggers, a rule's trigger, a sequence's messages. */
function useStartsWhen(item: AutomationItem): string[] {
  const t = useTranslations("Flows.list");
  const tTriggers = useTranslations("Automations.builder.triggers");
  const tList = useTranslations("AutomationList");
  if (item.flow) return effectiveTriggers(item.flow).map((trigger) => describeTrigger(trigger, t));
  if (item.rule) {
    const type = item.rule.trigger_type;
    return [isKnownTrigger(type) ? tTriggers(`${type}.label`) : type];
  }
  return [tList("sequenceStarts", { count: item.sequence?.messages ?? 0 })];
}

function AutomationRow({
  item, folder, creator, canCreate, busy, showChannel, onOpen, onToggleLive, onRename, onDuplicate, onSplit, onDelete, onRestore, onMove, onLogs,
}: {
  item: AutomationItem;
  folder: string | null;
  creator: CreatorLabel | null;
  canCreate: boolean;
  busy: boolean;
  /** The unified list names each row's channel. */
  showChannel: boolean;
  onOpen: () => void;
  onToggleLive: (on: boolean) => void;
  onRename: () => void;
  onDuplicate?: () => void;
  onSplit?: () => void;
  onDelete: () => void;
  onRestore?: () => void;
  onMove?: () => void;
  onLogs?: () => void;
}) {
  const t = useTranslations("Flows.list");
  const tRow = useTranslations("Flows.listRow");
  const tFolders = useTranslations("Flows.folders");
  const tSection = useTranslations("Flows.channelSection");
  const tList = useTranslations("AutomationList");
  const format = useFormatter();
  const triggers = useStartsWhen(item);
  const both = item.channel === "any";
  const singleChannel: Channel | null = item.channel === "any" ? null : item.channel;
  const KindIcon = KIND_ICON[item.kind];
  const stateLabel = item.status === "testing" ? t("statusTesting") : tRow(`status.${STATUS_KEY[item.status]}`);
  const live = item.status === "active";
  const switchable = canSwitch(item) && canCreate;
  const firstTrigger = triggers.length === 0 ? tRow("noTrigger") : triggers[0];
  const moreTriggers = triggers.length > 1 ? ` ${tRow("moreTriggers", { count: triggers.length - 1 })}` : "";
  const runsLabel = item.kind === "sequence" ? tList("subscribers") : tRow("runs");
  return (
    <li
      className={cn("grid grid-cols-[minmax(0,1fr)_auto_34px] items-center gap-3.5 px-4 py-3 transition-colors duration-150 hover:bg-muted/50", ROW_GRID)}
      data-flow-row={item.kind === "flow" ? item.id : undefined}
      data-automation-row={item.key}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary" aria-hidden>
          <KindIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 truncate rounded-sm text-left text-sm font-semibold text-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
              {item.name}
            </button>
            {both && (
              <span
                title={tSection("bothChannelsHelp")}
                data-flow-channel="any"
                className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              >
                {tSection("bothChannels")}
              </span>
            )}
          </div>
          <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <span className="shrink-0 lg:hidden">{tList(`kinds.${item.kind}`)}</span>
            <span aria-hidden className="lg:hidden">·</span>
            <span className={cn("shrink-0", live && "font-medium text-emerald-700 dark:text-emerald-300")}>{stateLabel}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{tRow("modified", { time: format.relativeTime(new Date(item.updatedAt)) })}</span>
            {folder && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Folder className="h-3 w-3" aria-hidden />
                  {folder}
                </span>
              </>
            )}
            {creator && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">
                  {t("createdBy", {
                    name: creator.kind === "name" ? creator.name : creator.kind === "teammate" ? t("creatorTeammate") : t("creatorUnknown"),
                  })}
                </span>
              </>
            )}
          </p>
          {item.description && <p className="line-clamp-1 text-xs text-muted-foreground/80">{item.description}</p>}
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground lg:hidden">
            {showChannel && singleChannel && <ChannelDot channel={singleChannel} />}
            <span className="truncate">
              {firstTrigger}{moreTriggers}
              {" · "}
              {runsLabel} {format.number(item.runs)}
            </span>
          </p>
        </div>
      </div>
      <span className="hidden min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground lg:flex">
        <KindIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{tList(`kinds.${item.kind}`)}</span>
      </span>
      <div className="hidden min-w-0 items-center gap-2 text-[13px] text-muted-foreground lg:flex">
        {showChannel && singleChannel && <ChannelDot channel={singleChannel} />}
        <ul className="min-w-0" aria-label={tList("startsWhen")}>
          <li className="truncate">{firstTrigger}</li>
          {triggers.length > 1 && (
            <li className="truncate text-xs" title={triggers.slice(1).join("\n")}>
              {tRow("moreTriggers", { count: triggers.length - 1 })}
            </li>
          )}
        </ul>
      </div>
      <span className="hidden text-right text-[13px] tabular-nums text-foreground lg:block" title={runsLabel}>
        <span className="sr-only">{runsLabel}: </span>
        {format.number(item.runs)}
      </span>
      <span className="hidden text-right text-[13px] tabular-nums text-foreground lg:block" title={tRow("ctrHelp")} data-flow-ctr={item.ctr ?? ""}>
        <span className="sr-only">{tRow("ctr")}: </span>
        {item.ctr === null ? <span className="text-muted-foreground">{tRow("noCtr")}</span> : tRow("ctrValue", { value: item.ctr })}
      </span>
      <span className="flex items-center justify-start" title={item.status === "archived" ? tList("archivedNoSwitch") : undefined}>
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={tList("working")} />
        ) : (
          <Switch
            checked={live}
            disabled={!switchable}
            onCheckedChange={(on) => onToggleLive(!!on)}
            aria-label={tList("liveLabel", { name: item.name })}
          />
        )}
      </span>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" aria-label={`${tRow("actions")}: ${item.name}`} disabled={busy}>
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>
              <Pencil className="h-3.5 w-3.5" />
              {t("edit")}
            </DropdownMenuItem>
            {onLogs && (
              <DropdownMenuItem onClick={onLogs}>
                <FileText className="h-3.5 w-3.5" />
                {tList("logs")}
              </DropdownMenuItem>
            )}
            {canCreate && (
              <>
                {onDuplicate && (
                  <DropdownMenuItem onClick={onDuplicate}>
                    <Copy className="h-3.5 w-3.5" />
                    {t("duplicate")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onRename}>
                  <Tag className="h-3.5 w-3.5" />
                  {tList("rename.action")}
                </DropdownMenuItem>
                {onMove && (
                  <DropdownMenuItem onClick={onMove}>
                    <FolderInput className="h-3.5 w-3.5" />
                    {tFolders("moveTo")}
                  </DropdownMenuItem>
                )}
                {onSplit && (
                  <DropdownMenuItem onClick={onSplit}>
                    <Split className="h-3.5 w-3.5" />
                    {tSection("split")}
                  </DropdownMenuItem>
                )}
                {onRestore && (
                  <DropdownMenuItem onClick={onRestore}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {tRow("restore")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function DeleteDialog({ item, busy, onCancel, onConfirm }: {
  item: AutomationItem | null; busy: boolean; onCancel: () => void; onConfirm: (item: AutomationItem) => void;
}) {
  const tRow = useTranslations("Flows.listRow");
  const tList = useTranslations("AutomationList");
  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        {item && <DeleteBody item={item} busy={busy} onCancel={onCancel} onConfirm={onConfirm} tRow={tRow} tList={tList} />}
      </DialogContent>
    </Dialog>
  );
}

function DeleteBody({ item, busy, onCancel, onConfirm, tRow, tList }: {
  item: AutomationItem; busy: boolean; onCancel: () => void; onConfirm: (item: AutomationItem) => void;
  tRow: ReturnType<typeof useTranslations>; tList: ReturnType<typeof useTranslations>;
}) {
  const triggers = useStartsWhen(item);
  const archives = item.kind === "flow" && !!item.flow?.published_version_id && item.status !== "archived";
  const note = item.kind === "rule" ? tList("deleteRuleHint")
    : item.kind === "sequence" ? tList("deleteSequenceHint", { count: item.sequence?.subscribers ?? 0 })
      : archives ? tRow("deleteArchiveHint") : tRow("deletePermanent");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{tRow("deleteTitle")}</DialogTitle>
        <DialogDescription className="text-muted-foreground">{item.name}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2 text-sm">
        <p className="text-foreground">{tRow("deleteTriggers")}</p>
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          {triggers.map((trigger, index) => <li key={index}>{trigger}</li>)}
        </ul>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{tRow("cancel")}</Button>
        <Button variant="destructive" disabled={busy} onClick={() => onConfirm(item)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {tRow("confirmDelete")}
        </Button>
      </DialogFooter>
    </>
  );
}

function MoveDialog({ flow, folders, onCancel, onMove }: {
  flow: FlowRow | null; folders: FolderRow[]; onCancel: () => void; onMove: (flow: FlowRow, folderId: string | null) => void;
}) {
  return (
    <Dialog open={!!flow} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
        {flow && <MoveForm key={flow.id} flow={flow} folders={folders} onCancel={onCancel} onMove={onMove} />}
      </DialogContent>
    </Dialog>
  );
}

function MoveForm({ flow, folders, onCancel, onMove }: {
  flow: FlowRow; folders: FolderRow[]; onCancel: () => void; onMove: (flow: FlowRow, folderId: string | null) => void;
}) {
  const t = useTranslations("Flows.folders");
  const [target, setTarget] = useState<string>(flow.folder_id ?? "");
  return (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onMove(flow, target || null);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("moveTo")}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{flow.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="flow-move-folder">{t("filterLabel")}</Label>
              <select
                id="flow-move-folder"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                <option value="">{t("noFolder")}</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>{t("cancel")}</Button>
              <Button type="submit">{t("save")}</Button>
            </DialogFooter>
          </form>
  );
}

function FolderNameDialog({ state, onCancel, onSave }: {
  state: { mode: "create" } | { mode: "rename"; folder: FolderRow } | null; onCancel: () => void; onSave: (name: string) => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
        {state && <FolderNameForm key={state.mode === "rename" ? state.folder.id : "new"} state={state} onCancel={onCancel} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function FolderNameForm({ state, onCancel, onSave }: {
  state: { mode: "create" } | { mode: "rename"; folder: FolderRow }; onCancel: () => void; onSave: (name: string) => void;
}) {
  const t = useTranslations("Flows.folders");
  const [name, setName] = useState(state.mode === "rename" ? state.folder.name : "");
  const valid = name.trim().length >= 1 && name.trim().length <= 60;
  return (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) onSave(name.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle>{state.mode === "create" ? t("new") : t("rename")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="flow-folder-name">{t("name")}</Label>
              <Input id="flow-folder-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
              {!valid && name.length > 0 && <p className="text-xs text-destructive">{t("nameInvalid")}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>{t("cancel")}</Button>
              <Button type="submit" disabled={!valid}>{t("save")}</Button>
            </DialogFooter>
          </form>
  );
}

/** A trigger type's short name for the trigger filter. */
function triggerTypeLabel(type: FlowTriggerType, tRow: ReturnType<typeof useTranslations>): string {
  return tRow.has(`triggerTypes.${type}`) ? tRow(`triggerTypes.${type}`) : type;
}

/** One trigger in plain words, as the row and the delete dialog list it. */
export function describeTrigger(trigger: FlowTriggerConfig | { trigger_type: string; config: Record<string, unknown> },
  t: ReturnType<typeof useTranslations>): string {
  const cfg = trigger.config as Record<string, unknown>;
  const type = trigger.trigger_type;
  if (type === "keyword") {
    if (cfg.match_type === "regex") return t("triggerRegex");
    const keywords = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t(cfg.match_type === "not_contains" ? "triggerKeywordNot" : "triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (type === "template_reply") {
    return t("triggerTemplateReply", { template: String(cfg.template_name ?? "") });
  }
  if (type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  if (type === "order_received") return t("triggerOrderReceived");
  if (type === "contact_created") return t("triggerContactCreated");
  if (type === "tag_added") return t("triggerTagAdded");
  if (type === "outside_hours") return t("triggerOutsideHours");
  if (type === "ad_click") {
    const ids = Array.isArray(cfg.ad_ids) ? cfg.ad_ids.length : 0;
    return ids ? t("triggerAdClick", { count: ids }) : t("triggerAdClickAny");
  }
  if (type === "default_reply") return t("triggerDefaultReply");
  if (type === "ig_comment") {
    if (cfg.post_scope === "next") return t("triggerIgCommentNext");
    const posts = cfg.post_scope === "specific" && Array.isArray(cfg.media_ids) ? cfg.media_ids.length : 0;
    return posts ? t("triggerIgCommentSpecific", { count: posts }) : t("triggerIgCommentAny");
  }
  if (type === "ig_story_reply") return t("triggerIgStoryReply");
  if (type === "ig_story_mention") return t("triggerIgStoryMention");
  if (type === "ig_live_comment") return t("triggerIgLiveComment");
  if (type === "ig_share_to_story") return t("triggerIgShareToStory");
  if (type === "ig_ref") {
    const refs = Array.isArray(cfg.refs) ? cfg.refs.filter((r): r is string => typeof r === "string") : [];
    return refs.length ? t("triggerIgRef", { refs: refs.join(", ") }) : t("triggerIgRefNone");
  }
  return t("triggerManual");
}
