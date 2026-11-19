"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/data/client";
import { authFetch } from "@/lib/auth/client";
import type { BoardView, OverviewRow, StageSummary } from "@/lib/pipelines/board";
import type { Pipeline, PipelineStage, Deal, Profile } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics, PipelineSummary } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GitBranch, Plus, ChevronDown, Settings, Search, User, Check, BarChart3, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { useTranslations } from "next-intl";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec. Names are
// message keys under `Pipelines.page.defaultStages` so the seeded
// stages come out in the UI language.
const SPEC_DEFAULT_STAGES = [
  { nameKey: "newLead", color: "#3b82f6", position: 0 }, // blue
  { nameKey: "qualified", color: "#eab308", position: 1 }, // yellow
  { nameKey: "proposalSent", color: "#f97316", position: 2 }, // orange
  { nameKey: "negotiation", color: "#8b5cf6", position: 3 }, // purple
  { nameKey: "won", color: "#22c55e", position: 4 }, // green
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS: BoardView[] = ["open", "won", "lost"];
const VIEW_LABEL = { open: "viewOpen", won: "viewWon", lost: "viewLost" } as const;

/** The board as loaded: deals so far, SQL stage summaries for the view, and the overview aggregate. */
interface BoardData {
  deals: Deal[];
  summaries: Record<string, StageSummary>;
  overview: OverviewRow[];
  hasMore: Record<string, boolean>;
}

function boardQuery(view: BoardView, owner: string, q: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ view, owner, ...extra });
  if (q) params.set("q", q);
  return params.toString();
}

function BoardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="h-7 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-8 w-28 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="flex gap-3 overflow-hidden">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-96 w-60 shrink-0 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}

export default function PipelinesPage() {
  // useSearchParams (the ?deal= link) needs a Suspense boundary for the production build.
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <PipelinesBoard />
    </Suspense>
  );
}

function PipelinesBoard() {
  const t = useTranslations("Pipelines.page");
  const tGate = useTranslations("GatedButton");
  const tNav = useTranslations("Sidebar");
  const db = createClient();
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dealParam = searchParams.get("deal");

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState(true);
  // Board filters, applied in SQL: the view (open, won or lost deals), owner
  // ("all", "none" = unassigned, or a member id) and a deal search.
  const [view, setView] = useState<BoardView>("open");
  const [owner, setOwner] = useState<string>("all");
  const [dealQuery, setDealQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [board, setBoard] = useState<BoardData | null>(null);
  const [boardError, setBoardError] = useState(false);
  const [boardKey, setBoardKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});
  const boardRequest = useRef(0);
  const [members, setMembers] = useState<Profile[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [deletingDeal, setDeletingDeal] = useState<Deal | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const tSales = useTranslations("Sales.pipeline");

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await db
      .from("pipelines")
      .select("*")
      .order("created_at");
    if (error) {
      console.error("Failed to load pipelines:", error.message);
      return [];
    }
    return data ?? [];
  }, [db]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await db
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      return data ?? [];
    },
    [db],
  );

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await db.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await db
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: t("defaultPipelineName") })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: t(`defaultStages.${s.nameKey}`),
      color: s.color,
      position: s.position,
    }));
    await db.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [db, accountId, t]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Team members for the owner filter.
  useEffect(() => {
    let cancelled = false;
    void db.from("profiles").select("id,full_name,email").order("full_name").then(({ data }) => {
      if (!cancelled) setMembers((data ?? []) as Profile[]);
    });
    return () => {
      cancelled = true;
    };
  }, [db]);

  // Stages whenever the selected pipeline changes. Clearing on no-selection
  // is a legitimate sync with state; loads set state in promise callbacks.
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      return;
    }
    let cancelled = false;
    void loadStages(selectedPipelineId).then((s) => {
      if (!cancelled) setStages(s);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages]);

  // The search applies a moment after typing stops.
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(dealQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [dealQuery]);

  // The board: the first page of each stage, the stage totals and the overview, all from SQL.
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBoard(null);
      return;
    }
    const request = ++boardRequest.current;
    void (async () => {
      try {
        const res = await authFetch(
          `/api/pipelines/${encodeURIComponent(selectedPipelineId)}/board?${boardQuery(view, owner, searchTerm)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`board ${res.status}`);
        const body = (await res.json()) as { deals: Deal[]; stages: StageSummary[]; overview: OverviewRow[] };
        if (request !== boardRequest.current) return;
        const summaries = Object.fromEntries(body.stages.map((st) => [st.stage_id, st]));
        const loaded: Record<string, number> = {};
        for (const d of body.deals) loaded[d.stage_id] = (loaded[d.stage_id] ?? 0) + 1;
        const hasMore = Object.fromEntries(body.stages.map((st) => [st.stage_id, st.count > (loaded[st.stage_id] ?? 0)]));
        setBoard({ deals: body.deals, summaries, overview: body.overview, hasMore });
        setBoardError(false);
      } catch {
        if (request !== boardRequest.current) return;
        // An empty board would read as "no deals": say the load failed.
        setBoardError(true);
      }
    })();
  }, [selectedPipelineId, view, owner, searchTerm, boardKey]);

  const refreshBoard = useCallback(() => setBoardKey((k) => k + 1), []);

  const loadMore = useCallback(async (stageId: string) => {
    if (!board || !selectedPipelineId) return;
    const offset = board.deals.filter((d) => d.stage_id === stageId).length;
    setLoadingMore((m) => ({ ...m, [stageId]: true }));
    try {
      const res = await authFetch(
        `/api/pipelines/${encodeURIComponent(selectedPipelineId)}/deals?${boardQuery(view, owner, searchTerm, { stage: stageId, offset: String(offset) })}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`deals ${res.status}`);
      const page = (await res.json()) as { deals: Deal[]; hasMore: boolean };
      setBoard((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.deals.map((d) => d.id));
        return {
          ...prev,
          deals: [...prev.deals, ...page.deals.filter((d) => !seen.has(d.id))],
          hasMore: { ...prev.hasMore, [stageId]: page.hasMore },
        };
      });
    } catch {
      toast.error(t("toastFailedLoadDeals"));
    } finally {
      setLoadingMore((m) => ({ ...m, [stageId]: false }));
    }
  }, [board, selectedPipelineId, view, owner, searchTerm, t]);

  // /pipelines?deal=<id> (from the chat panel and the contact profile): open that deal
  // even when it is not on the loaded page, on its own pipeline. Another workspace's
  // deal is a 404 like any unknown id.
  const openedDealParam = useRef<string | null>(null);
  useEffect(() => {
    if (!dealParam || openedDealParam.current === dealParam) return;
    openedDealParam.current = dealParam;
    if (!UUID.test(dealParam)) {
      toast.error(tSales("dealNotFound"));
      return;
    }
    void (async () => {
      const res = await authFetch(`/api/deals/${encodeURIComponent(dealParam)}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) {
        toast.error(tSales("dealNotFound"));
        return;
      }
      const { deal } = (await res.json()) as { deal: Deal };
      setSelectedPipelineId(deal.pipeline_id);
      if (deal.status && deal.status !== "open") setView(deal.status);
      setEditingDeal(deal);
      setDefaultStageId(deal.stage_id);
      setDealFormOpen(true);
    })();
  }, [dealParam, tSales]);

  const handleDealFormOpenChange = useCallback((open: boolean) => {
    setDealFormOpen(open);
    // Closing the deal drops ?deal= so a reload does not reopen it.
    if (!open && dealParam) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("deal");
      const query = params.toString();
      openedDealParam.current = null;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }
  }, [dealParam, searchParams, router, pathname]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; persist, then reload the totals.
      setBoard((prev) => prev && {
        ...prev,
        deals: prev.deals.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      });
      const { error } = await db
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", dealId);
      refreshBoard();
      if (error) {
        toast.error(t("toastFailedMoveDeal"));
        return;
      }
      const stage = stages.find((s) => s.id === newStageId);
      if (stage) toast.success(tSales("moved", { stage: stage.name }));
    },
    [db, refreshBoard, t, stages, tSales],
  );

  const filtering = owner !== "all" || searchTerm !== "";
  const ownerMember = members.find((m) => m.id === owner);
  const ownerLabel = owner === "all" ? tSales("allOwners") : owner === "none" ? tSales("unassigned")
    : (ownerMember?.full_name || ownerMember?.email || tSales("allOwners"));

  async function confirmDeleteDeal() {
    if (!deletingDeal) return;
    setDeleteBusy(true);
    const { error } = await db.from("deals").delete().eq("id", deletingDeal.id);
    setDeleteBusy(false);
    if (error) {
      toast.error(tSales("deleteFailed"));
      return;
    }
    toast.success(tSales("deleted"));
    if (editingDeal?.id === deletingDeal.id) handleDealFormOpenChange(false);
    setDeletingDeal(null);
    refreshBoard();
  }

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await db.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t("toastNotLinkedToAccount"));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await db
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t("toastFailedCreatePipeline"));
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: t(`defaultStages.${s.nameKey}`),
      color: s.color,
      position: s.position,
    }));
    await db.from("pipeline_stages").insert(stagesPayload);

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t("toastPipelineCreated"));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loading) return <BoardSkeleton />;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          {tNav("pipelines")}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason={tGate("reasons.createPipelines")}
            onClick={() => setNewPipelineOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("addPipeline")}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason={tGate("reasons.createDeals")}
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
          >
            <Plus className="h-4 w-4" />
            {t("addDeal")}
          </GatedButton>
        </div>
      </div>

      {pipelines.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border bg-card px-3.5 text-sm text-foreground transition-colors duration-150 hover:bg-muted data-[popup-open]:bg-muted"
            >
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <span className="truncate font-medium">
                {selectedPipeline?.name ?? t("selectPipeline")}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t("noPipelinesYet")}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t("managePipelines")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {selectedPipeline && canEditSettings && (
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
              {tSales("manageStages")}
            </Button>
          )}
          <Tabs value={view} onValueChange={(v) => setView(v as BoardView)}>
            <TabsList aria-label={tSales("viewLabel")} className="bg-muted">
              {VIEWS.map((v) => (
                <TabsTrigger key={v} value={v} className="min-h-11 px-3 sm:min-h-0">
                  {tSales(VIEW_LABEL[v])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <span className="hidden flex-1 sm:block" />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={tSales("owner")}
              className="inline-flex h-8 max-w-[12rem] items-center gap-2 rounded-full border border-border bg-card px-3.5 text-sm text-foreground transition-colors duration-150 hover:bg-muted data-[popup-open]:bg-muted"
            >
              <User className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{ownerLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto border-border bg-popover text-popover-foreground">
              {[["all", tSales("allOwners")] as const,
                ...members.map((m) => [m.id, m.full_name || m.email || m.id.slice(0, 8)] as const),
                ["none", tSales("unassigned")] as const].map(([value, label]) => (
                <DropdownMenuItem key={value} onClick={() => setOwner(value)}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${owner === value ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative w-full min-w-0 sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={dealQuery}
              onChange={(e) => setDealQuery(e.target.value)}
              placeholder={tSales("searchDeals")}
              aria-label={tSales("searchDeals")}
              maxLength={100}
              className="h-8 pl-8"
            />
          </div>
        </div>
      )}

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
          <span className="mb-1 flex size-[52px] items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <GitBranch className="size-6" />
          </span>
          <h3 className="text-base font-semibold text-foreground">
            {t("noPipelinesYet")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("createToStartTracking")}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason={tGate("reasons.createPipelines")}
            onClick={() => setNewPipelineOpen(true)}
            className="mt-2"
          >
            <Plus className="h-4 w-4" />
            {t("createPipeline")}
          </GatedButton>
        </div>
      ) : (
        <>
          {boardError ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <AlertCircle className="size-6 text-destructive" />
              <p className="text-sm text-foreground">{tSales("loadFailed")}</p>
              <Button variant="outline" onClick={refreshBoard}>{tSales("retry")}</Button>
            </div>
          ) : !board ? (
            <div className="flex gap-3 overflow-hidden">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-72 w-60 shrink-0 animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : (
            <>
              <PipelineSummary overview={board.overview} />
              <div>
                <Button variant="ghost" size="sm" aria-expanded={showAnalytics} onClick={() => setShowAnalytics((v) => !v)}>
                  <BarChart3 className="h-4 w-4" />
                  {showAnalytics ? tSales("fewerStats") : tSales("moreStats")}
                </Button>
                {showAnalytics && <div className="mt-2"><PipelineAnalytics stages={stages} overview={board.overview} /></div>}
              </div>
              <PipelineBoard
                stages={stages}
                deals={board.deals}
                summaries={board.summaries}
                hasMore={board.hasMore}
                loadingMore={loadingMore}
                onLoadMore={(stageId) => void loadMore(stageId)}
                onDealMoved={canCreateDeals ? handleDealMoved : undefined}
                onAddDeal={view === "open" ? handleAddDeal : undefined}
                onEditDeal={handleEditDeal}
                onDeleteDeal={canCreateDeals ? setDeletingDeal : undefined}
                emptyText={filtering ? tSales("noMatches") : undefined}
              />
            </>
          )}
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("newPipeline")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t("pipelineName")}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t("pipelineNamePlaceholder")}
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t("defaultStagesDesc")}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t("creating") : t("createPipelineBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Delete a deal from its card menu or the deal panel */}
      <Dialog open={deletingDeal !== null} onOpenChange={(open) => { if (!open) setDeletingDeal(null); }}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{tSales("deleteTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{tSales("deleteBody", { title: deletingDeal?.title ?? "" })}</p>
          <DialogFooter className="bg-popover/50 border-border">
            <Button variant="outline" onClick={() => setDeletingDeal(null)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={deleteBusy} onClick={() => void confirmDeleteDeal()}>
              {tSales("deleteDeal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={handleDealFormOpenChange}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshBoard}
        onDelete={(deal) => setDeletingDeal(deal)}
      />
    </div>
  );
}
