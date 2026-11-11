"use client";

/**
 * The settings of one trigger, by type. Shared by the list view's trigger
 * panel (primary trigger) and the Stage 5 trigger stack (every trigger, in
 * the canvas side panel and under the list view's panel).
 */

import { useTranslations } from "next-intl";

import type { FlowTriggerType } from "@/lib/flows/types";
import { AdClickTriggerFields, KeywordTriggerFields, OrderReceivedTriggerFields, TemplateReplyTriggerFields } from "../trigger-fields";
import {
  DefaultReplyTriggerFields,
  IgCommentTriggerFields,
  IgLiveCommentTriggerFields,
  IgRefTriggerFields,
  IgShareToStoryTriggerFields,
  IgStoryMentionTriggerFields,
  IgStoryReplyTriggerFields,
} from "./ig-trigger-fields";

type Config = Record<string, unknown>;

/** The title (Flows.builder) of each trigger type. */
export const TRIGGER_TITLE_KEYS: Record<FlowTriggerType, string> = {
  keyword: "triggerKeywordTitle",
  template_reply: "triggerTemplateReplyTitle",
  first_inbound_message: "triggerFirstInboundTitle",
  order_received: "triggerOrderReceivedTitle",
  ad_click: "triggerAdClickTitle",
  manual: "triggerManualTitle",
  default_reply: "triggerDefaultReplyTitle",
  ig_comment: "triggerIgCommentTitle",
  ig_story_reply: "triggerIgStoryReplyTitle",
  ig_story_mention: "triggerIgStoryMentionTitle",
  ig_live_comment: "triggerIgLiveCommentTitle",
  ig_ref: "triggerIgRefTitle",
  ig_share_to_story: "triggerIgShareToStoryTitle",
};

export function TriggerForm({ type, config, onChange, instagramOnly, shareToStoryOn }: {
  type: FlowTriggerType;
  config: Config;
  onChange: (config: Config) => void;
  /** The flow runs on Instagram only: the ad trigger describes click-to-Direct ads. */
  instagramOnly: boolean;
  shareToStoryOn: boolean;
}) {
  const t = useTranslations("Flows.builder");
  switch (type) {
    case "keyword":
      return <KeywordTriggerFields config={config} t={t} onChange={onChange} />;
    case "template_reply":
      return <TemplateReplyTriggerFields config={config} t={t} onChange={onChange} />;
    case "order_received":
      return <OrderReceivedTriggerFields t={t} />;
    case "ad_click":
      return <AdClickTriggerFields config={config} t={t} instagram={instagramOnly} onChange={onChange} />;
    case "default_reply":
      return <DefaultReplyTriggerFields config={config} onChange={onChange} />;
    case "ig_comment":
      return <IgCommentTriggerFields config={config} onChange={onChange} />;
    case "ig_story_reply":
      return <IgStoryReplyTriggerFields config={config} onChange={onChange} />;
    case "ig_story_mention":
      return <IgStoryMentionTriggerFields config={config} onChange={onChange} />;
    case "ig_live_comment":
      return <IgLiveCommentTriggerFields config={config} onChange={onChange} />;
    case "ig_ref":
      return <IgRefTriggerFields config={config} onChange={onChange} />;
    case "ig_share_to_story":
      return <IgShareToStoryTriggerFields config={config} onChange={onChange} enabled={shareToStoryOn} />;
    case "first_inbound_message":
    case "manual":
      return null;
  }
}
