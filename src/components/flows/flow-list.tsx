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
} from "lucide-react";

import { useFormatter, useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
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
import { TemplateGallery, type TemplateSummary } from "@/components/flows/template-gallery";
import { AiGenerateFlowButton } from "@/components/flows/ai-generate-dialog";
import type { AccountMember, Channel } from "@/types";
import { cn } from "@/lib/utils";
import { creatorLabel, type CreatorLabel } from "@/lib/flows/creator-label";
import { channelPath } from "@/lib/channels/routes";
import { effectiveTriggers } from "@/lib/flows/flow-triggers";
import type { FlowChannelScope, FlowTriggerConfig, FlowTriggerType } from "@/lib/flows/types";
import { splitFlow } from "./split-flow";
import { navChannels } from "@/components/layout/page-search-navigation";
import { useWorkspaceChannels } from "@/hooks/use-workspace-channels";
import { useSearchParams } from "next/navigation";

/**
 * Automations. `channel="all"` (/automation, the ManyChat-style unified
 * list) lists every channel's flows with a channel badge and a channel
 * filter; "New automation" asks which channel the new one is for, and the
 * template gallery follows it. Folders belong to one channel, so they show
 * only in a single-channel list. A single channel (`whatsapp` / `instagram`)
 * keeps the earlier per-channel list.
 *
 * Per channel (Stage 1, Stage 5):
 *
 * Lists the channel's own flows plus legacy 'any' flows, which run on both
 * channels and show a "Both channels" badge with a split action. Each row
 * shows its status, name, every trigger, runs, click-through rate (a dash for
 * a flow that never sent a tracked link) and when it was last edited; folders
 * (per channel) group them. A flow created here (blank, from a template or as
 * a duplicate) belongs to this channel. On Instagram a rail links the three
 * automation tabs: My automations, Basics and Sequences.
 *
 * Deleting a flow that was ever live archives it (restorable from the
 * Archived state); a draft that never went live, or an archived flow, is
 * deleted. Open to every authenticated user; the APIs enforce role, CSRF,
 * tenancy and the channel rules.
 */

interface FlowRow {
  id: string;
  /** Who created the flow (audit identity; may have left the account). */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "archived";
  trigger_type: FlowTriggerType;
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  extra_triggers?: unknown;
  execution_count: number;
  last_executed_at: string | null;
  test_numbers?: string[];
  test_usernames?: string[];
  /** Absent on rows read before Phase 11: WhatsApp. */
  channel_scope?: FlowChannelScope;
  published_version_id?: string | null;
  folder_id?: string | null;
  /** Stage 5: whole-percent click-through rate; null when no tracked link was sent. */
  ctr?: number | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: string;
  name: string;
  flow_count: number;
}

/** "testing" is a draft with test numbers or usernames — the same split the status badge shows. */
type StatusFilter = "all" | "active" | "paused" | "draft" | "testing" | "archived";
const STATUS_FILTERS: StatusFilter[] = ["all", "active", "paused", "draft", "testing", "archived"];

/** The row's status chip: Draft, Live, Stopped (paused) or Archived. */
const CHIP: Record<FlowRow["status"], { key: "draft" | "live" | "stopped" | "archived"; className: string }> = {
  draft: { key: "draft", className: "border-border bg-muted text-muted-foreground" },
  active: { key: "live", className: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  paused: { key: "stopped", className: "border-border bg-transparent text-muted-foreground" },
  archived: { key: "archived", className: "border-border bg-muted/50 text-muted-foreground" },
};

/** Folder filter: every flow, the top level only, or one folder. */
type FolderFilter = "all" | "none" | string;

export function displayStatus(flow: Pick<FlowRow, "status" | "test_numbers" | "test_usernames">): Exclude<StatusFilter, "all"> {
  const testers = (flow.test_numbers ?? []).length + (flow.test_usernames ?? []).length;
  return flow.status === "draft" && testers > 0 ? "testing" : flow.status;
}

/** Name, description and every trigger's keywords/template/refs, lower-cased for the search box. */
function searchText(flow: FlowRow): string {
  const words = effectiveTriggers(flow).flatMap(({ config }) => {
    const cfg = config as Record<string, unknown>;
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    return [...list(cfg.keywords), ...list(cfg.refs), String(cfg.template_name ?? "")];
  });
  return [flow.name, flow.description ?? "", ...words].join(" ").toLowerCase();
}

/** Whether a flow passes the list's filters (status, trigger type, folder, search). */
export function flowMatches(flow: FlowRow, filters: { status: StatusFilter; trigger: FlowTriggerType | "all"; folder: FolderFilter; query: string }): boolean {
  if (filters.status !== "all" && displayStatus(flow) !== filters.status) return false;
  if (filters.trigger !== "all" && !effectiveTriggers(flow).some((t) => t.trigger_type === filters.trigger)) return false;
  if (filters.folder === "none" && flow.folder_id) return false;
  if (filters.folder !== "all" && filters.folder !== "none" && flow.folder_id !== filters.folder) return false;
  const needle = filters.query.trim().toLowerCase();
  return !needle || searchText(flow).includes(needle);
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

export function FlowList({ channel }: { channel: Channel | "all" }) {
  const router = useRouter();
  const unified = channel === "all";
  const { data: channelData } = useWorkspaceChannels();
  const enabledChannels = navChannels(channelData?.enabled);
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("channel");
  const [channelFilter, setChannelFilter] = useState<"all" | Channel>(
    initialFilter === "whatsapp" || initialFilter === "instagram" ? initialFilter : "all",
  );
  const [chosenChannel, setChosenChannel] = useState<Channel | null>(null);
  // The channel a new automation is for: the list's own, or the one picked in the dialog.
  const createChannel: Channel = unified
    ? (chosenChannel && enabledChannels.includes(chosenChannel) ? chosenChannel : enabledChannels[0])
    : channel;
  /** The section a flow opens in (a legacy 'any' flow opens in WhatsApp in the unified list). */
  const sectionOf = (flow: { channel_scope?: FlowChannelScope | null }): Channel =>
    unified ? (flow.channel_scope === "instagram" ? "instagram" : "whatsapp") : channel;
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tRow = useTranslations("Flows.listRow");
  const tFolders = useTranslations("Flows.folders");
  const tSection = useTranslations("Flows.channelSection");
  const tChannelName = useTranslations("Inbox.channel");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [memberNames, setMemberNames] = useState<Map<string, string> | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [triggerFilter, setTriggerFilter] = useState<FlowTriggerType | "all">("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FlowRow | null>(null);
  const [moving, setMoving] = useState<FlowRow | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ mode: "create" } | { mode: "rename"; folder: FolderRow } | null>(null);
  const editorPath = (id: string, section: Channel = unified ? createChannel : channel) => channelPath(section, "flows", id);

  const visibleFlows = useMemo(
    () => flows.filter((flow) => flowMatches(flow, { status: statusFilter, trigger: triggerFilter, folder: folderFilter, query })
      && (channelFilter === "all" || flow.channel_scope === channelFilter || flow.channel_scope === "any")),
    [flows, query, statusFilter, triggerFilter, folderFilter, channelFilter],
  );
  const triggerTypes = useMemo(
    () => [...new Set(flows.flatMap((flow) => effectiveTriggers(flow).map((trigger) => trigger.trigger_type)))].sort(),
    [flows],
  );
  const folderName = useMemo(() => new Map(folders.map((folder) => [folder.id, folder.name])), [folders]);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes, names] = await Promise.all([
          authFetch(channel === "all" ? "/api/flows" : `/api/flows?channel=${channel}`),
          authFetch(channel === "all" ? "/api/flows/templates" : `/api/flows/templates?channel=${channel}`),
          loadMemberNames(),
          loadFolders(),
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

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await authFetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
          channel_scope: createChannel,
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(editorPath(json.flow.id));
    } catch (err) {
      console.error(err);
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await authFetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug, channel_scope: createChannel }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(editorPath(json.flow.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDuplicate(flow: FlowRow) {
    setBusyId(flow.id);
    try {
      // The copy belongs to this section (a legacy 'any' flow's copy too).
      const res = await authFetch(`/api/flows/${flow.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_scope: sectionOf(flow) }),
      });
      const json = (await res.json().catch(() => ({}))) as { flow?: FlowRow; error?: string };
      if (!res.ok || !json.flow) throw new Error(json.error ?? t("duplicateError"));
      toast.success(t("duplicateSuccess", { name: json.flow.name }));
      router.push(editorPath(json.flow.id, sectionOf(flow)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateError"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleSplit(flow: FlowRow) {
    setBusyId(flow.id);
    try {
      const ids = await splitFlow(flow.id);
      if (!ids) {
        toast.error(tSection("splitFailed"));
        return;
      }
      toast.success(tSection("splitDone"));
      const section = unified ? "whatsapp" : channel;
      router.push(editorPath(ids[section], section));
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(flow: FlowRow, status: "archived" | "draft"): Promise<boolean> {
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

  /** A flow that was ever live is archived (restorable); a draft or an archived flow is deleted. */
  async function confirmDelete(flow: FlowRow) {
    setBusyId(flow.id);
    try {
      if (flow.published_version_id && flow.status !== "archived") {
        if (await setStatus(flow, "archived")) toast.success(tRow("archivedDone"));
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
      setBusyId(null);
      setDeleting(null);
    }
  }

  async function handleRestore(flow: FlowRow) {
    setBusyId(flow.id);
    try {
      if (await setStatus(flow, "draft")) toast.success(tRow("restored"));
    } finally {
      setBusyId(null);
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

  // The unified list's dialog offers only the chosen channel's templates.
  const galleryTemplates = unified ? templates.filter((tpl) => !tpl.channels || tpl.channels.includes(createChannel)) : templates;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const statusCount = (status: StatusFilter) =>
    status === "all" ? flows.length : flows.filter((flow) => displayStatus(flow) === status).length;

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
            {unified ? t("unifiedDescription") : tSection(channel === "instagram" ? "instagramDescription" : "whatsappDescription")}
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

      {flows.length === 0 && folders.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            onCreate={() => setCreateOpen(true)}
            canCreate={canCreate}
            t={t}
          />
        </div>
      ) : (
        <>
          <div className="mb-3.5 mt-6 flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={t("statusFilterLabel")}
              className="flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]"
            >
              {STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150",
                    statusFilter === status
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {status === "all" ? t("filterAll") : status === "testing" ? t("statusTesting") : tRow(`status.${CHIP[status].key}`)}
                  <span className="font-medium tabular-nums text-muted-foreground">{statusCount(status)}</span>
                </button>
              ))}
            </div>
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
                aria-label={tRow("triggerFilter")}
                value={triggerFilter}
                onChange={(e) => setTriggerFilter(e.target.value as FlowTriggerType | "all")}
                className={cn(
                  "h-8 rounded-full border border-border px-3 text-[13px] transition-colors duration-150 hover:bg-muted",
                  triggerFilter === "all" ? "bg-card text-muted-foreground" : "border-transparent bg-primary/10 font-semibold text-primary",
                )}
              >
                <option value="all">{tRow("anyTrigger")}</option>
                {triggerTypes.map((type) => (
                  <option key={type} value={type}>{triggerTypeLabel(type, tRow)}</option>
                ))}
              </select>
              <div className="relative w-full sm:w-[260px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchPlaceholder")}
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

          {visibleFlows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border px-4 py-12 text-center">
              <span className="mb-2 inline-flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Search className="h-6 w-6" aria-hidden />
              </span>
              <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className={cn("hidden gap-3.5 bg-muted px-4 py-2.5 text-xs font-semibold text-muted-foreground lg:grid", ROW_GRID)}>
                <span>{tRow("nameColumn")}</span>
                <span>{tRow("triggerFilter")}</span>
                <span className="text-right">{tRow("runs")}</span>
                <span className="text-right" title={tRow("ctrHelp")}>{tRow("ctr")}</span>
                <span>{tRow("stateFilter")}</span>
                <span className="sr-only">{tRow("actions")}</span>
              </div>
              <ul className="divide-y divide-border/60">
                {visibleFlows.map((flow) => (
                  <FlowListRow
                    key={flow.id}
                    flow={flow}
                    folder={flow.folder_id ? folderName.get(flow.folder_id) ?? null : null}
                    creator={creatorLabel(memberNames, flow.user_id)}
                    canCreate={canCreate}
                    busy={busyId === flow.id}
                    showChannel={unified}
                    onEdit={() => router.push(editorPath(flow.id, sectionOf(flow)))}
                    onDuplicate={() => handleDuplicate(flow)}
                    onSplit={() => handleSplit(flow)}
                    onDelete={() => setDeleting(flow)}
                    onRestore={() => handleRestore(flow)}
                    onMove={() => setMoving(flow)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("createDesc")}
            </DialogDescription>
          </DialogHeader>

          {unified && enabledChannels.length > 1 && (
            <div role="tablist" aria-label={t("chooseChannel")} className="inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl bg-muted p-[3px]" data-testid="create-channel">
              {enabledChannels.map((value) => (
                <button key={value} type="button" role="tab" aria-selected={createChannel === value} onClick={() => setChosenChannel(value)}
                  className={cn("inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150",
                    createChannel === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", value === "instagram" ? "bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600" : "bg-emerald-500")} />
                  {tChannelName(value)}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-[13px] font-semibold text-foreground">
              {t("startBlank")}
            </p>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("placeholderName")}
                aria-label={t("placeholderName")}
                className="rounded-xl border-transparent bg-muted shadow-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
              <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("createBlank")}
              </Button>
            </div>
          </div>

          {galleryTemplates.length > 0 && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-[13px] font-semibold text-foreground">
                {t("startTemplate")}
              </p>
              <TemplateGallery key={createChannel} templates={galleryTemplates} creating={creating} onUse={handleUseTemplate} />
            </div>
          )}

          <DialogFooter>
            {/* The AI builder makes WhatsApp flows, so it is offered only in the WhatsApp section. */}
            {createChannel === "whatsapp" && (
              <AiGenerateFlowButton disabled={creating} onCreated={(id) => { setCreateOpen(false); router.push(editorPath(id)); }} />
            )}
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteDialog flow={deleting} busy={!!deleting && busyId === deleting.id} onCancel={() => setDeleting(null)}
        onConfirm={(flow) => void confirmDelete(flow)} />
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

/** The list's columns: name, trigger, runs, CTR, state, menu (name, state and menu below lg). */
const ROW_GRID = "lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_72px_64px_96px_34px]";

function FolderChip({ active, onClick, label, count, icon = false }: {
  active: boolean; onClick: () => void; label: string; count?: number; icon?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors duration-150",
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

/** The state pill's look: Live green, Testing accent, the rest neutral. */
const STATE_PILL: Record<Exclude<StatusFilter, "all">, string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  testing: "bg-primary/10 text-primary",
  draft: "bg-muted text-muted-foreground",
  paused: "border border-border text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
};

/** A channel mark: the WhatsApp or Instagram dot, named for screen readers. */
function ChannelDot({ channel }: { channel: Channel }) {
  const tChannelName = useTranslations("Inbox.channel");
  return (
    <span
      role="img"
      aria-label={tChannelName(channel)}
      title={tChannelName(channel)}
      data-flow-channel={channel}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        channel === "instagram" ? "bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600" : "bg-emerald-500",
      )}
    />
  );
}

function FlowListRow({
  flow, folder, creator, canCreate, busy, onEdit, onDuplicate, onSplit, onDelete, onRestore, onMove, showChannel = false,
}: {
  /** The unified list names each flow's channel. */
  showChannel?: boolean;
  flow: FlowRow;
  folder: string | null;
  creator: CreatorLabel | null;
  canCreate: boolean;
  busy: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onMove: () => void;
}) {
  const t = useTranslations("Flows.list");
  const tRow = useTranslations("Flows.listRow");
  const tFolders = useTranslations("Flows.folders");
  const tSection = useTranslations("Flows.channelSection");
  const format = useFormatter();
  const both = flow.channel_scope === "any";
  const triggers = effectiveTriggers(flow);
  const chip = CHIP[flow.status];
  const shown = displayStatus(flow);
  const stateLabel = shown === "testing" ? t("statusTesting") : tRow(`status.${chip.key}`);
  const ctr = flow.ctr ?? null;
  const singleChannel = !both && (flow.channel_scope === "whatsapp" || flow.channel_scope === "instagram") ? flow.channel_scope : null;
  return (
    <li
      className={cn("grid grid-cols-[minmax(0,1fr)_auto_34px] items-center gap-3.5 px-4 py-3 transition-colors duration-150 hover:bg-muted/50", ROW_GRID)}
      data-flow-row={flow.id}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary" aria-hidden>
          <Workflow className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onEdit} className="min-w-0 truncate text-left text-sm font-semibold text-foreground transition-colors duration-150 hover:text-primary">
              {flow.name}
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
            <span className="shrink-0">{stateLabel}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{tRow("modified", { time: format.relativeTime(new Date(flow.updated_at)) })}</span>
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
          {flow.description && <p className="line-clamp-1 text-xs text-muted-foreground/80">{flow.description}</p>}
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground lg:hidden">
            {showChannel && singleChannel && <ChannelDot channel={singleChannel} />}
            <span className="truncate">
              {triggers.length === 0 ? tRow("noTrigger") : describeTrigger(triggers[0], t)}
              {triggers.length > 1 && ` ${tRow("moreTriggers", { count: triggers.length - 1 })}`}
              {" · "}
              {tRow("runs")} {format.number(flow.execution_count)}
            </span>
          </p>
        </div>
      </div>
      <div className="hidden min-w-0 items-center gap-2 text-[13px] text-muted-foreground lg:flex">
        {showChannel && singleChannel && <ChannelDot channel={singleChannel} />}
        <ul className="min-w-0" aria-label={tRow("triggerFilter")}>
          {triggers.length === 0 ? (
            <li className="truncate">{tRow("noTrigger")}</li>
          ) : (
            <>
              <li className="truncate">{describeTrigger(triggers[0], t)}</li>
              {triggers.length > 1 && (
                <li className="truncate text-xs" title={triggers.slice(1).map((trigger) => describeTrigger(trigger, t)).join("\n")}>
                  {tRow("moreTriggers", { count: triggers.length - 1 })}
                </li>
              )}
            </>
          )}
        </ul>
      </div>
      <span className="hidden text-right text-[13px] tabular-nums text-foreground lg:block">
        <span className="sr-only">{tRow("runs")}: </span>
        {format.number(flow.execution_count)}
      </span>
      <span className="hidden text-right text-[13px] tabular-nums text-foreground lg:block" title={tRow("ctrHelp")} data-flow-ctr={ctr ?? ""}>
        <span className="sr-only">{tRow("ctr")}: </span>
        {ctr === null ? <span className="text-muted-foreground">{tRow("noCtr")}</span> : tRow("ctrValue", { value: ctr })}
      </span>
      <span className={cn("inline-flex w-fit items-center gap-1.5 justify-self-start rounded-full px-2.5 py-0.5 text-xs font-medium", STATE_PILL[shown])}>
        {shown === "active" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />}
        {stateLabel}
      </span>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label={`${tRow("actions")}: ${flow.name}`} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
              {t("edit")}
            </DropdownMenuItem>
            {canCreate && (
              <>
                <DropdownMenuItem onClick={onDuplicate}>
                  <Copy className="h-3.5 w-3.5" />
                  {t("duplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onMove}>
                  <FolderInput className="h-3.5 w-3.5" />
                  {tFolders("moveTo")}
                </DropdownMenuItem>
                {both && (
                  <DropdownMenuItem onClick={onSplit}>
                    <Split className="h-3.5 w-3.5" />
                    {tSection("split")}
                  </DropdownMenuItem>
                )}
                {flow.status === "archived" && (
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

function DeleteDialog({ flow, busy, onCancel, onConfirm }: {
  flow: FlowRow | null; busy: boolean; onCancel: () => void; onConfirm: (flow: FlowRow) => void;
}) {
  const t = useTranslations("Flows.list");
  const tRow = useTranslations("Flows.listRow");
  const archives = !!flow?.published_version_id && flow.status !== "archived";
  return (
    <Dialog open={!!flow} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        {flow && (
          <>
            <DialogHeader>
              <DialogTitle>{tRow("deleteTitle")}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{flow.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p className="text-foreground">{tRow("deleteTriggers")}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {effectiveTriggers(flow).map((trigger, index) => <li key={index}>{describeTrigger(trigger, t)}</li>)}
              </ul>
              <p className="text-xs text-muted-foreground">{archives ? tRow("deleteArchiveHint") : tRow("deletePermanent")}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={onCancel}>{tRow("cancel")}</Button>
              <Button variant="destructive" disabled={busy} onClick={() => onConfirm(flow)}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {tRow("confirmDelete")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
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
