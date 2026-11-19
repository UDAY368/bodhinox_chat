"use client";

/**
 * "New deal" from anywhere outside the board (the chat composer menu, a contact
 * profile): the deal sheet with a pipeline choice (the first pipeline by default)
 * and its stages, and the contact already chosen.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/data/client";
import type { Pipeline, PipelineStage } from "@/types";
import { DealForm, type DealContactChoice } from "./deal-form";

export interface NewDealSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultContact?: DealContactChoice;
  onSaved?: (dealId: string) => void;
}

export function NewDealSheet({ open, onOpenChange, defaultContact, onSaved }: NewDealSheetProps) {
  const db = createClient();
  const [pipelines, setPipelines] = useState<Pick<Pipeline, "id" | "name">[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [stages, setStages] = useState<PipelineStage[]>([]);

  // Pipelines once the sheet opens; keep the chosen one while it still exists.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void db.from("pipelines").select("id,name").order("created_at").limit(100).then(({ data }) => {
      if (cancelled) return;
      const list = (data ?? []) as Pick<Pipeline, "id" | "name">[];
      setPipelines(list);
      setPipelineId((prev) => (prev && list.some((p) => p.id === prev) ? prev : list[0]?.id ?? ""));
    });
    return () => {
      cancelled = true;
    };
  }, [open, db]);

  useEffect(() => {
    if (!open || !pipelineId) return;
    let cancelled = false;
    void db.from("pipeline_stages").select("*").eq("pipeline_id", pipelineId).order("position").then(({ data }) => {
      if (!cancelled) setStages((data ?? []) as PipelineStage[]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, pipelineId, db]);

  return (
    <DealForm
      open={open}
      onOpenChange={onOpenChange}
      deal={null}
      pipelineId={pipelineId}
      stages={stages}
      defaultStageId={stages[0]?.id}
      defaultContact={defaultContact}
      pipelineChoice={{
        pipelines,
        onChange: (id) => {
          setStages([]);
          setPipelineId(id);
        },
      }}
      onSaved={(dealId) => {
        if (dealId) onSaved?.(dealId);
      }}
    />
  );
}
