"use client";

/**
 * Form for the ai_reply step: extra instructions for the AI agent, whether
 * it uses the knowledge base, how many answers it gives inside the step,
 * where the last answer is stored, its confidence threshold, and the
 * Answered / Handoff ports. With more than one answer the step waits for
 * follow-ups, so its reply timeout lives here too (the shared TimingFields
 * only knows the fixed waiting steps). Mounted by NodeConfigForm.
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AI_REPLY_LIMITS, aiReplyMaxTurns } from "@/lib/flows/ai-reply-node";
import type { AiReplyNodeConfig, NodeTiming } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { AiGoalsEditor } from "./ai-goals-editor";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

/** A whole or decimal number input that stores `undefined` when cleared. */
function numberOrUndefined(raw: string, parse: (n: number) => number): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? parse(n) : undefined;
}

export function AiReplyForm({ node, allNodes, onUpdateConfig, t, instagram = false }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  t: T;
  /** Instagram flows (Stage 5): tasks, context, goals and the "Goals finished" port. */
  instagram?: boolean;
}) {
  const cfg = node.config as unknown as Partial<AiReplyNodeConfig> & NodeTiming;
  const id = (field: string) => `ai-reply-${node.node_key}-${field}`;
  const waits = aiReplyMaxTurns(node.config) > 1;
  return (
    <>
      <div>
        <label htmlFor={id("instructions")} className={label}>{t("aiReplyInstructions", { max: AI_REPLY_LIMITS.instructions })}</label>
        <Textarea
          id={id("instructions")}
          value={cfg.instructions ?? ""}
          maxLength={AI_REPLY_LIMITS.instructions}
          rows={4}
          onChange={(e) => onUpdateConfig({ instructions: e.target.value || undefined })}
          placeholder={t("aiReplyInstructionsPlaceholder")}
          className="bg-muted"
        />
        <p className={help}>{t("aiReplyInstructionsHelp")}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id("knowledge")} className="text-xs text-muted-foreground">{t("aiReplyUseKnowledge")}</label>
        <Switch
          id={id("knowledge")}
          checked={cfg.use_knowledge !== false}
          onCheckedChange={(checked) => onUpdateConfig({ use_knowledge: checked })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={id("turns")} className={label}>{t("aiReplyMaxTurns")}</label>
          <Input
            id={id("turns")}
            type="number"
            inputMode="numeric"
            min={1}
            max={AI_REPLY_LIMITS.maxTurns}
            value={typeof cfg.max_turns === "number" ? String(cfg.max_turns) : ""}
            placeholder="1"
            onChange={(e) => {
              const max_turns = numberOrUndefined(e.target.value, Math.trunc);
              // One answer never waits, so a timeout would mean nothing.
              onUpdateConfig(max_turns !== undefined && max_turns > 1 ? { max_turns } : { max_turns, timeout_minutes: undefined, after_timeout: undefined });
            }}
            className="bg-muted"
          />
        </div>
        <div>
          <label htmlFor={id("threshold")} className={label}>{t("aiReplyThreshold")}</label>
          <Input
            id={id("threshold")}
            type="number"
            inputMode="decimal"
            min={0}
            max={1}
            step={0.05}
            value={typeof cfg.confidence_threshold === "number" ? String(cfg.confidence_threshold) : ""}
            placeholder={t("aiReplyThresholdPlaceholder")}
            onChange={(e) => onUpdateConfig({ confidence_threshold: numberOrUndefined(e.target.value, (n) => Math.min(1, Math.max(0, n))) })}
            className="bg-muted"
          />
        </div>
      </div>
      <p className={help}>{t("aiReplyTurnsHelp", { max: AI_REPLY_LIMITS.maxTurns })}</p>
      <p className={help}>{t("aiReplyThresholdHelp")}</p>
      <div>
        <label htmlFor={id("var")} className={label}>{t("aiReplyVarKey")}</label>
        <Input
          id={id("var")}
          value={cfg.var_key ?? ""}
          onChange={(e) => onUpdateConfig({ var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") || undefined })}
          placeholder="ai_answer"
          className="bg-muted font-mono"
        />
      </div>
      <NextNodeRow
        label={t("aiReplyAnsweredNext")}
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
      />
      <NextNodeRow
        label={t("aiReplyHandoffNext")}
        value={cfg.handoff_next ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ handoff_next: v })}
      />
      <p className={help}>{t("aiReplyHandoffHelp")}</p>
      {waits && (
        <>
          <div>
            <label htmlFor={id("timeout")} className={label}>{t("timeoutLabel")}</label>
            <Input
              id={id("timeout")}
              type="number"
              inputMode="numeric"
              min={1}
              max={10080}
              value={typeof cfg.timeout_minutes === "number" ? String(cfg.timeout_minutes) : ""}
              onChange={(e) => {
                const timeout_minutes = numberOrUndefined(e.target.value, Math.trunc);
                onUpdateConfig(timeout_minutes === undefined ? { timeout_minutes, after_timeout: undefined } : { timeout_minutes });
              }}
              className="bg-muted"
            />
            <p className={help}>{t("timeoutHelp")}</p>
          </div>
          {typeof cfg.timeout_minutes === "number" && (
            <NextNodeRow
              label={t("afterTimeoutLabel")}
              value={cfg.after_timeout ?? ""}
              allNodes={allNodes}
              currentKey={node.node_key}
              onChange={(v) => onUpdateConfig({ after_timeout: v })}
            />
          )}
        </>
      )}
      <p className={help}>{t("aiReplyWindowHelp")}</p>
      {instagram && <AiGoalsEditor node={node} allNodes={allNodes} onUpdateConfig={onUpdateConfig} />}
    </>
  );
}
