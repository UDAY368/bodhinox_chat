"use client";

/**
 * Editor top bar (Stage 5 layout).
 *
 * Left: back, breadcrumb (Automations › inline-editable name), status chip
 * (Draft / Live / Stopped) and the autosave state (Saving… / Saved / Not
 * saved with the reason). Right: Undo, Redo, Preview, the Canvas / Simple
 * builder switch, Settings, "Set live" (or Pause) and a more-actions menu
 * (Save now, Runs, Archive, Delete). The description stays as a subtle line
 * underneath.
 *
 * Autosave saves 1.5 s after the last edit (use-autosave.ts); when someone
 * else saved a newer draft the bar opens the Reload / Overwrite choice and
 * nothing is overwritten silently.
 *
 * Reads everything from the editor context (`useFlowEditor`) so it stays in
 * sync with whichever view is mutating state; the view, preview and
 * settings controls belong to FlowEditorShell and come in as props.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  GitFork,
  History,
  List,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Redo2,
  Rocket,
  Save,
  Smartphone,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { channelPath } from "@/lib/channels/routes";
import { useFlowEditor, type BuilderState } from "./flow-editor-state";
import type { AutosaveStatus } from "./use-autosave";

/** What the save-state chip says (Flows.autosave keys), or null to show nothing. */
export function saveStateView(status: AutosaveStatus, dirty: boolean): { key: "saving" | "saved" | "notSaved" | "notSavedReason"; reason?: "offline" | "failed"; message?: string | null } | null {
  switch (status.kind) {
    case "pending":
    case "saving":
      return { key: "saving" };
    case "error":
      if (status.reason === "server" && status.message) return { key: "notSavedReason", message: status.message };
      return { key: "notSavedReason", reason: status.reason === "offline" ? "offline" : "failed" };
    case "conflict":
      return { key: "notSaved" };
    case "saved":
      return dirty ? { key: "saving" } : { key: "saved" };
    case "idle":
      return dirty ? { key: "saving" } : null;
  }
}

export type EditorView = "canvas" | "list";

export function EditorHeader({ view, onViewChange, previewOpen, onTogglePreview, settings }: {
  /** Canvas or the simple (list) builder; omitted on phones, where only the list exists. */
  view?: EditorView;
  onViewChange?: (view: EditorView) => void;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  /** The Settings popover (FlowEditorShell owns it). */
  settings?: ReactNode;
} = {}) {
  const router = useRouter();
  const t = useTranslations("Flows.header");
  const tHistory = useTranslations("Flows.history");
  const tAuto = useTranslations("Flows.autosave");
  const tCanvas = useTranslations("Flows.canvas");
  const tBuilder = useTranslations("Flows.builder");
  const {
    flow,
    state,
    setState,
    dirty,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
    section,
    history,
    saveStatus,
    conflict,
    reloadDraft,
    overwriteDraft,
    flush,
  } = useFlowEditor();
  // Runs is another page: save what is pending first, and ask only when that save failed.
  const openRuns = async () => {
    const saved = !dirty || (await flush());
    if (saved || window.confirm(tAuto("leaveWarning"))) router.push(`/flows/${flow.id}/runs`);
  };
  const saveView = saveStateView(saveStatus, dirty);
  const backHref = channelPath(section, "flows");

  return (
    <div className="flex flex-col gap-1.5 px-6 pt-5">
      <div className="flex flex-wrap items-center gap-2">
        {/* ---- left: back · breadcrumb › name · status · save state ---- */}
        {/* A link (not router.push) so the leave guard can hold it while a save is pending. */}
        <Link
          href={backHref}
          title={t("backToFlows")}
          aria-label={t("backToFlows")}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <nav aria-label={t("breadcrumb")} className="flex min-w-0 items-center gap-1">
          <Link href={backHref} className="shrink-0 rounded px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
            {t("automations")}
          </Link>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            placeholder={t("namePlaceholder")}
            spellCheck={false}
            aria-label={t("namePlaceholder")}
            className="min-w-[120px] max-w-[340px] rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-bold leading-tight tracking-tight text-foreground outline-none transition-colors hover:bg-muted focus:border-primary focus:bg-transparent focus:shadow-[0_0_0_3px_var(--primary-soft)]"
          />
        </nav>
        <StatusChip status={state.status} />
        {saveView && (
          <span
            role="status"
            aria-live="polite"
            data-save-state={saveView.key}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
              saveView.key === "saved" ? "text-muted-foreground" : saveView.key === "saving" ? "text-muted-foreground" : "text-amber-500",
            )}
          >
            {saveView.key === "saving" ? <Loader2 className="h-3 w-3 animate-spin" />
              : saveView.key === "saved" ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
            {saveView.key === "notSavedReason"
              ? tAuto("notSavedReason", { reason: saveView.message ?? tAuto(saveView.reason ?? "failed") })
              : tAuto(saveView.key)}
          </span>
        )}

        {/* ---- right: undo · redo · preview · view · settings · set live · more ---- */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={history.undo} disabled={!history.canUndo}
            aria-label={tHistory("undo")} title={history.canUndo ? tHistory("undoShortcut") : tHistory("nothingToUndo")}>
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={history.redo} disabled={!history.canRedo}
            aria-label={tHistory("redo")} title={history.canRedo ? tHistory("redoShortcut") : tHistory("nothingToRedo")}>
            <Redo2 className="h-4 w-4" />
          </Button>
          {onTogglePreview && (
            <Button variant="ghost" size="sm" onClick={onTogglePreview} aria-pressed={!!previewOpen}
              className={cn(previewOpen && "bg-primary-soft text-primary")}>
              <Smartphone className="h-3.5 w-3.5" />{tCanvas("preview")}
            </Button>
          )}
          {view && onViewChange && (
            <div role="group" aria-label={tBuilder("editorView")} className="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
              {(["canvas", "list"] as const).map((v) => (
                <button key={v} type="button" onClick={() => onViewChange(v)} aria-pressed={view === v}
                  className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary",
                    view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {v === "canvas" ? <GitFork className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                  {v === "canvas" ? tCanvas("canvasBuilder") : tCanvas("simpleBuilder")}
                </button>
              ))}
            </div>
          )}
          {settings}
          {/* Autosave does the saving; "Save now" stays for anyone who wants it at once. */}
          <Button variant="outline" size="sm" onClick={() => void save()} disabled={conflict}>
            <Save className="h-3.5 w-3.5" />{tAuto("saveNow")}
          </Button>
          {state.status === "active" ? (
            <Button variant="outline" size="sm" onClick={() => void setStatus("draft")} disabled={activating}>
              {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />}
              {t("pause")}
            </Button>
          ) : (
            // Publishing waits for a pending autosave (flush) instead of being disabled while one runs.
            <Button size="sm" onClick={() => void setStatus("active")} disabled={activating || !canActivate || conflict}
              title={!canActivate ? t("fixIssues") : undefined}>
              {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              {tCanvas("setLive")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger aria-label={tCanvas("more")} title={tCanvas("more")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={() => void openRuns()}>
                <History className="h-4 w-4" />{t("runs")}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{flow.execution_count}</span>
              </DropdownMenuItem>
              {state.status !== "archived" && (
                <DropdownMenuItem onClick={() => void setStatus("archived")}>
                  <Archive className="h-4 w-4" />{t("archive")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void deleteFlow()}>
                <Trash2 className="h-4 w-4" />{t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ---- description note (subtle, inline-editable) ---- */}
      <input
        value={state.description}
        onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
        placeholder={t("descriptionPlaceholder")}
        aria-label={t("descriptionLabel")}
        className="w-full max-w-[78ch] rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] text-muted-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:bg-muted/50 focus:border-primary focus:bg-transparent focus:text-foreground"
      />

      {/* Someone saved a newer draft: autosave stopped until the author picks. */}
      <Dialog open={conflict}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tAuto("conflictTitle")}</DialogTitle>
            <DialogDescription>{tAuto("conflictBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={reloadDraft}>{tAuto("reload")}</Button>
            <Button variant="destructive" onClick={() => void overwriteDraft()}>{tAuto("overwrite")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusChip({ status }: { status: BuilderState["status"] }) {
  const t = useTranslations("Flows.header.status");
  const cfg = {
    draft: { cls: "border-border bg-muted text-muted-foreground", label: t("draft") },
    active: { cls: "border-emerald-600/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", label: t("live") },
    paused: { cls: "border-sky-600/40 bg-sky-500/10 text-sky-600 dark:text-sky-300", label: t("stopped") },
    archived: { cls: "border-border bg-muted/50 text-muted-foreground", label: t("archived") },
  }[status];
  return (
    <span
      data-status={status}
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium", cfg.cls)}
    >
      <CircleDot className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}
