"use client";
import { authFetch } from "@/lib/auth/client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  Copy,
  Search,
} from "lucide-react";

import { useTranslations } from "next-intl";
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TemplateGallery, type TemplateSummary } from "@/components/flows/template-gallery";
import { AiGenerateFlowButton } from "@/components/flows/ai-generate-dialog";
import type { AccountMember } from "@/types";
import { cn } from "@/lib/utils";
import { creatorLabel, type CreatorLabel } from "@/lib/flows/creator-label";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  /** Who created the flow (audit identity; may have left the account). */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "template_reply" | "order_received" | "ad_click";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  test_numbers?: string[];
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

const STATUS_COLORS: Record<FlowRow["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
  archived: "border-border bg-muted/50 text-muted-foreground",
};

/** "testing" is a draft with test numbers — the same split the status badge shows. */
type StatusFilter = "all" | "active" | "draft" | "testing" | "archived";
const STATUS_FILTERS: StatusFilter[] = ["all", "active", "draft", "testing", "archived"];

function displayStatus(flow: FlowRow): Exclude<StatusFilter, "all"> {
  return flow.status === "draft" && (flow.test_numbers ?? []).length > 0 ? "testing" : flow.status;
}

/** Name, description and trigger keywords/template, lower-cased for the search box. */
function searchText(flow: FlowRow): string {
  const cfg = flow.trigger_config as Record<string, unknown>;
  const keywords = Array.isArray(cfg.keywords) ? (cfg.keywords as unknown[]).map(String) : [];
  return [flow.name, flow.description ?? "", ...keywords, String(cfg.template_name ?? "")].join(" ").toLowerCase();
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

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [memberNames, setMemberNames] = useState<Map<string, string> | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const visibleFlows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return flows.filter((flow) =>
      (statusFilter === "all" || displayStatus(flow) === statusFilter) &&
      (!needle || searchText(flow).includes(needle)));
  }, [flows, query, statusFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes, names] = await Promise.all([
          authFetch("/api/flows"),
          authFetch("/api/flows/templates"),
          loadMemberNames(),
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
  }, []);

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
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
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
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDuplicate(flow: FlowRow) {
    setDuplicatingId(flow.id);
    try {
      const res = await authFetch(`/api/flows/${flow.id}/duplicate`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { flow?: FlowRow; error?: string };
      if (!res.ok || !json.flow) throw new Error(json.error ?? t("duplicateError"));
      toast.success(t("duplicateSuccess", { name: json.flow.name }));
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateError"));
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(t("deleteConfirm", { name: flow.name }));
    if (!yes) return;
    try {
      const res = await authFetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t("deleteSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              {t("beta")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
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

      {flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
          t={t}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                className="bg-muted pl-8"
              />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("statusFilterLabel")}>
              {STATUS_FILTERS.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant={statusFilter === status ? "secondary" : "ghost"}
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                >
                  {status === "all" ? t("filterAll") : status === "testing" ? t("statusTesting") : STATUS_LABELS(t)[status]}
                </Button>
              ))}
            </div>
          </div>
          {visibleFlows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
              {t("noMatches")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleFlows.map((flow) => (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  creator={creatorLabel(memberNames, flow.user_id)}
                  canCreate={canCreate}
                  duplicating={duplicatingId === flow.id}
                  onEdit={() => router.push(`/flows/${flow.id}`)}
                  onDuplicate={() => handleDuplicate(flow)}
                  onDelete={() => handleDelete(flow)}
                  t={t}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("createDesc")}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("startTemplate")}
              </p>
              <TemplateGallery templates={templates} creating={creating} onUse={handleUseTemplate} />
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("startBlank")}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("placeholderName")}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <AiGenerateFlowButton disabled={creating} onCreated={(id) => { setCreateOpen(false); router.push(`/flows/${id}`); }} />
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("createBlank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Workflow className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        {t("emptyTitle")}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {t("emptyDesc")}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason={tGate("reasons.createFlows")}
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t("createFirst")}
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  creator,
  canCreate,
  duplicating,
  onEdit,
  onDuplicate,
  onDelete,
  t,
}: {
  flow: FlowRow;
  creator: CreatorLabel | null;
  canCreate: boolean;
  duplicating: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  const triggerSummary = describeTrigger(flow, t);
  const StatusIcon =
    flow.status === "active"
      ? PlayCircle
      : flow.status === "archived"
        ? Archive
        : PauseCircle;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 gap-1 text-[10px]",
            STATUS_COLORS[flow.status],
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {displayStatus(flow) === "testing" ? t("statusTesting") : STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {flow.description || triggerSummary}
      </p>

      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {t("runCount", { count: flow.execution_count })}
        </span>
        {creator && (
          <span className="min-w-0 truncate">
            {t("createdBy", {
              name:
                creator.kind === "name"
                  ? creator.name
                  : creator.kind === "teammate"
                    ? t("creatorTeammate")
                    : t("creatorUnknown"),
            })}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t("edit")}
        </Button>
        <GatedButton
          variant="ghost"
          size="sm"
          canAct={canCreate}
          gateReason={tGate("reasons.createFlows")}
          disabled={duplicating}
          onClick={onDuplicate}
        >
          {duplicating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
          {t("duplicate")}
        </GatedButton>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("delete")}
        </Button>
      </div>
    </div>
  );
}

function describeTrigger(flow: FlowRow, t: ReturnType<typeof useTranslations>): string {
  const cfg = flow.trigger_config as Record<string, unknown>;
  if (flow.trigger_type === "keyword") {
    if (cfg.match_type === "regex") return t("triggerRegex");
    const keywords = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t("triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (flow.trigger_type === "template_reply") {
    return t("triggerTemplateReply", { template: String(cfg.template_name ?? "") });
  }
  if (flow.trigger_type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  if (flow.trigger_type === "order_received") return t("triggerOrderReceived");
  if (flow.trigger_type === "ad_click") {
    const ids = Array.isArray(cfg.ad_ids) ? cfg.ad_ids.length : 0;
    return ids ? t("triggerAdClick", { count: ids }) : t("triggerAdClickAny");
  }
  return t("triggerManual");
}
