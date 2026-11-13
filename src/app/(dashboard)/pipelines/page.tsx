"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@/lib/data/client";
import { loadPipelineDeals } from "@/lib/pipelines/deals";
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
import { GitBranch, Plus, ChevronDown, Settings, Search, User, Check, BarChart3 } from "lucide-react";
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

export default function PipelinesPage() {
  const t = useTranslations("Pipelines.page");
  const tGate = useTranslations("GatedButton");
  const tNav = useTranslations("Sidebar");
  const db = createClient();
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  // Board filters (prototype bar): owner ("all", "none" = unassigned, or a member id) and a deal search.
  const [owner, setOwner] = useState<string>("all");
  const [dealQuery, setDealQuery] = useState("");
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

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      try {
        return await loadPipelineDeals(db, pipelineId);
      } catch (error) {
        // An empty board would read as "no deals": say the load failed.
        console.error("Failed to load deals:", error instanceof Error ? error.message : error);
        toast.error(t("toastFailedLoadDeals"));
        return [] as Deal[];
      }
    },
    [db, t],
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

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
       
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

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

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId));
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await db
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", dealId);
      if (error) {
        toast.error(t("toastFailedMoveDeal"));
        refreshDeals();
        return;
      }
      const stage = stages.find((s) => s.id === newStageId);
      if (stage) toast.success(tSales("moved", { stage: stage.name }));
    },
    [db, refreshDeals, t, stages, tSales],
  );

  const visibleDeals = useMemo(() => {
    const q = dealQuery.trim().toLowerCase();
    return deals.filter((d) => {
      if (owner === "none" ? Boolean(d.assigned_to) : owner !== "all" && d.assigned_to !== owner) return false;
      if (!q) return true;
      return [d.title, d.contact?.name, d.contact?.phone].some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [deals, owner, dealQuery]);
  const filtering = owner !== "all" || dealQuery.trim() !== "";
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
    if (editingDeal?.id === deletingDeal.id) setDealFormOpen(false);
    setDeletingDeal(null);
    refreshDeals();
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

  if (loading) {
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
          <PipelineSummary deals={visibleDeals} />
          <div>
            <Button variant="ghost" size="sm" aria-expanded={showAnalytics} onClick={() => setShowAnalytics((v) => !v)}>
              <BarChart3 className="h-4 w-4" />
              {showAnalytics ? tSales("fewerStats") : tSales("moreStats")}
            </Button>
            {showAnalytics && <div className="mt-2"><PipelineAnalytics stages={stages} deals={visibleDeals} /></div>}
          </div>
          <PipelineBoard
            stages={stages}
            deals={visibleDeals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            onDeleteDeal={canCreateDeals ? setDeletingDeal : undefined}
            emptyText={filtering ? tSales("noMatches") : undefined}
          />
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
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
        onDelete={(deal) => setDeletingDeal(deal)}
      />
    </div>
  );
}
