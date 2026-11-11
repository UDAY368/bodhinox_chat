"use client";

/**
 * "Private reply" (`ig_private_reply`): the first DM to the person who
 * commented. One message of at most 1000 UTF-8 bytes, an optional opening
 * button (a quick reply of at most 20 characters) the run waits for, and,
 * while it waits, an optional reply timeout. No typing delay or question
 * may sit here, so this form has no timing section (the validator refuses
 * them too).
 */

import { useRef } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { INSTAGRAM_LIMITS } from "@/lib/instagram/graph-limits";
import { NextNodeRow } from "../forms/fields";
import { insertAtCursor, VariablePicker } from "../forms/variable-picker";
import type { BuilderNode } from "../shared";
import { bytesLeft, clipBytes, clipChars } from "./ig-node-config";

type Patch = (patch: Record<string, unknown>) => void;
const label = "text-muted-foreground mb-1 block text-xs";
const help = "text-muted-foreground mt-1 text-[10px]";

export function IgPrivateReplyForm({ node, allNodes, onUpdateConfig, notice, t }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  /** Shown when the step cannot run where it is (not first, or not a comment flow). */
  notice?: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const tn = useTranslations("Flows.nodes.igPrivateReply");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cfg = node.config;
  const key = node.node_key;
  const text = typeof cfg.text === "string" ? cfg.text : "";
  const optIn = typeof cfg.opt_in_label === "string" ? cfg.opt_in_label : "";
  const left = bytesLeft(text);
  const waits = optIn.trim() !== "";
  const timeout = typeof cfg.timeout_minutes === "number" ? cfg.timeout_minutes : undefined;
  return (
    <>
      <p className="text-muted-foreground text-xs">{tn("help")}</p>
      {notice && <p role="note" className="text-xs text-amber-500">{notice}</p>}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label htmlFor={`private-text-${key}`} className="block text-xs text-muted-foreground">{tn("text")}</label>
          {/* Stage 5: insert a placeholder at the cursor. */}
          <VariablePicker id={`private-text-${key}-vars`} nodes={allNodes} currentKey={key} onInsert={(token) => {
            const el = textRef.current;
            const next = insertAtCursor(text, el?.selectionStart, el?.selectionEnd, token);
            onUpdateConfig({ text: clipBytes(next.value) });
            requestAnimationFrame(() => { textRef.current?.focus(); textRef.current?.setSelectionRange(next.caret, next.caret); });
          }} />
        </div>
        <Textarea ref={textRef} id={`private-text-${key}`} rows={3} value={text} className="bg-muted"
          onChange={(e) => onUpdateConfig({ text: clipBytes(e.target.value) })} />
        <p className={left < 50 ? "mt-1 text-[10px] text-amber-500" : help}>{tn("bytesLeft", { count: Math.max(left, 0) })}</p>
      </div>
      <div>
        <label htmlFor={`private-optin-${key}`} className={label}>{tn("optIn")}</label>
        <Input id={`private-optin-${key}`} value={optIn} placeholder={tn("optInPlaceholder")} className="bg-muted"
          onChange={(e) => {
            const opt_in_label = clipChars(e.target.value, INSTAGRAM_LIMITS.quickReplyTitleChars);
            // Without the button the run does not wait, so a timeout would never fire.
            onUpdateConfig(opt_in_label.trim() ? { opt_in_label } : { opt_in_label, timeout_minutes: undefined, after_timeout: undefined });
          }} />
        <p className={help}>{tn("optInHelp")}</p>
      </div>
      <NextNodeRow value={typeof cfg.next_node_key === "string" ? cfg.next_node_key : ""} allNodes={allNodes} currentKey={key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })} label={t("advancesTo")} />
      {waits && (
        <div>
          <label htmlFor={`private-timeout-${key}`} className={label}>{t("timeoutLabel")}</label>
          <Input id={`private-timeout-${key}`} type="number" inputMode="numeric" min={1} max={10080} className="bg-muted"
            value={timeout ?? ""}
            onChange={(e) => {
              const n = e.target.value === "" ? undefined : Math.min(10080, Math.max(1, Math.round(Number(e.target.value))));
              onUpdateConfig(n === undefined || Number.isNaN(n) ? { timeout_minutes: undefined, after_timeout: undefined } : { timeout_minutes: n });
            }} />
          <p className={help}>{t("timeoutHelp")}</p>
        </div>
      )}
      {waits && timeout !== undefined && (
        <NextNodeRow value={typeof cfg.after_timeout === "string" ? cfg.after_timeout : ""} allNodes={allNodes} currentKey={key}
          onChange={(v) => onUpdateConfig({ after_timeout: v })} label={t("afterTimeoutLabel")} />
      )}
    </>
  );
}
