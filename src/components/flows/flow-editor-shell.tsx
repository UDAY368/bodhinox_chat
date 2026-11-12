"use client";

/**
 * View-switcher + chrome for the flow editor.
 *
 * Lays the editor out as one app-like column that fills the dashboard
 * content area edge to edge (one top bar → stage → validation bar):
 *   - Stage 5: the top bar (header.tsx) carries the Canvas / Simple
 *     builder switch, Preview and Settings beside Undo / Redo, the save
 *     state, Save now and the version bar (status, Dry run, Versions, Publish).
 *   - The active view is mounted edge to edge in a "stage" that owns its
 *     own scroll/overflow, so the canvas can fill available height and
 *     the list scrolls internally.
 *
 * Why a separate component:
 *   - The page itself stays trivially small (loading + error + this).
 *   - Either view can stay unaware of the other — they share data
 *     (`{flow, nodes}`) and nothing else.
 *
 * View choice persists per-browser via localStorage so a power user
 * who prefers the list isn't fighting the default on every load.
 * Canvas is the default for everyone else — the original user
 * feedback was that the list shape made flows "hard to understand".
 */

import { useState } from "react";
import { useMatchMedia } from "@/hooks/use-match-media";
import { Settings2 } from "lucide-react";

import { FlowBuilder, FlowVersionBar } from "./flow-builder";
import { FlowCanvas } from "./flow-canvas";
import { FlowEditorProvider } from "./flow-editor-state";
import { EditorHeader } from "./header";
import { ValidationPanel } from "./validation-panel";
import { FlowSettings } from "./flow-settings";
import { FlowPreview } from "./flow-preview";
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";
import type { Channel } from "@/types";
import { useTranslations } from "next-intl";

/**
 * Below this viewport width we force list view and hide the toggle.
 * Canvas with drag-to-connect on a phone is unusable — handles are
 * ~10px and live finger drags from one node to another aren't a
 * practical workflow. Matches Tailwind's `md` breakpoint.
 */
const MOBILE_BREAKPOINT = "(max-width: 767px)";

type View = "canvas" | "list";

const STORAGE_KEY = "wacrm.flowEditor.view";

// Legend covers every node type, derived from NODE_META so a new type
// can't silently go undocumented. NODE_META's key order already reads
// the way a flow flows: start → talk → capture → branch → mutate → end.

interface Props {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
  initialDraftHash?: string | null;
  /** The channel section the editor is open in (Stage 1). */
  section?: Channel;
}

export function FlowEditorShell({ initialFlow, initialNodes, initialDraftHash = null, section }: Props) {
  const t = useTranslations("Flows.builder");

  // Read the persisted choice in the useState initializer. Safe even
  // though this is a client component because the parent page only
  // mounts us AFTER a client-side fetch resolves — there's no SSR
  // pass for this subtree, so no hydration mismatch to worry about.
  // Default to `canvas` (the new default) when nothing is saved.
  const [view, setView] = useState<View>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "canvas" || saved === "list") return saved;
    } catch {
      // Private browsing / disabled storage — fall through to default.
    }
    return "canvas";
  });

  // Live mobile detection. We don't render canvas under the
  // breakpoint regardless of `view` — but we keep `view` itself
  // intact so the user's preference comes back when they widen
  // again (e.g. rotating a tablet, resizing a window).
  const isMobile = useMatchMedia(MOBILE_BREAKPOINT);
  // WhatsApp-style preview beside either view; local only, never sends.
  const [previewOpen, setPreviewOpen] = useState(false);
  const effectiveView: View = isMobile ? "list" : view;

  const choose = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  return (
    <FlowEditorProvider initialFlow={initialFlow} initialNodes={initialNodes} initialDraftHash={initialDraftHash} section={section}>
      <div className="flow-studio flex h-full min-h-0 flex-col">
        {/* Stage 5 top bar: the view switch ("Simple builder"), Preview and
            Settings sit in the header beside Undo / Redo and Set live. Phones
            only get the list view, so the switch is left out there. */}
        <EditorHeader
          view={isMobile ? undefined : effectiveView}
          onViewChange={isMobile ? undefined : choose}
          previewOpen={previewOpen}
          onTogglePreview={() => setPreviewOpen((open) => !open)}
          settings={
            <Popover>
              <PopoverTrigger aria-label={t("studioSettings")} title={t("studioSettings")}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
                <Settings2 className="h-3.5 w-3.5" /><span className="hidden @7xl:inline">{t("studioSettings")}</span>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96"><FlowSettings /></PopoverContent>
            </Popover>
          }
          lifecycle={<FlowVersionBar />}
        />

        {/* ---- stage: the active view, edge to edge, owning its own overflow ---- */}
        <div className="relative min-h-0 flex-1 overflow-hidden border-t border-border bg-card-2">
          <div className="flex h-full min-h-0">
            <div className="relative h-full min-w-0 flex-1">
              {effectiveView === "canvas" ? (
                <FlowCanvas />
              ) : (
                <div className="absolute inset-0 overflow-y-auto">
                  <FlowBuilder />
                </div>
              )}
            </div>
            {previewOpen && <FlowPreview onClose={() => setPreviewOpen(false)} floating={effectiveView === "canvas"} />}
          </div>
        </div>

        {/* ---- validation / activate-readiness bar ---- */}
        <div className="flow-studio-validation shrink-0 border-t border-border px-3 py-1">
          <ValidationPanel />
        </div>
      </div>
    </FlowEditorProvider>
  );
}

