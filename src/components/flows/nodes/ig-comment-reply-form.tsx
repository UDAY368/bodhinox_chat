"use client";

/**
 * "Reply to comment" (`ig_comment_reply`): 1–3 public replies, one posted
 * under the comment that started the run (sent once per comment). Runs only
 * in a comment flow; elsewhere the form says so.
 */

import { useTranslations } from "next-intl";

import { INSTAGRAM_LIMITS } from "@/lib/instagram/graph-limits";
import { NextNodeRow } from "../forms/fields";
import type { BuilderNode } from "../shared";
import { IgReplyVariants } from "../triggers/ig-reply-variants";
import { MAX_REPLY_VARIANTS, replyVariants } from "./ig-node-config";

type Patch = (patch: Record<string, unknown>) => void;

export function IgCommentReplyForm({ node, allNodes, onUpdateConfig, notice, t }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  /** Shown when the step cannot run where it is (not a comment flow). */
  notice?: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const tn = useTranslations("Flows.nodes.igCommentReply");
  const stored = replyVariants(node.config.replies);
  const variants = stored.length ? stored : [""];
  return (
    <>
      <p className="text-muted-foreground text-xs">{tn("help")}</p>
      {notice && <p role="note" className="text-xs text-amber-500">{notice}</p>}
      <div>
        <span className="text-muted-foreground mb-1 block text-xs">{tn("replies")}</span>
        <IgReplyVariants id={`comment-reply-${node.node_key}`} variants={variants} keepOne
          onChange={(replies) => onUpdateConfig({ replies })}
          labels={{ add: tn("addReply"), remove: (n) => tn("removeReply", { n }), variant: (n) => tn("replyN", { n }) }} />
        <p className="text-muted-foreground mt-1 text-[10px]">
          {tn("maxReplies", { max: MAX_REPLY_VARIANTS })} {tn("tooLong", { max: INSTAGRAM_LIMITS.commentReplyChars })}
        </p>
      </div>
      <NextNodeRow
        value={typeof node.config.next_node_key === "string" ? node.config.next_node_key : ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}
