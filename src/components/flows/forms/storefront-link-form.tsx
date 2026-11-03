"use client";

/**
 * Form for the send_storefront_link step: the message sent above the secure
 * link, whether it opens the store or the contact's latest order, how long the
 * link stays valid, and where the run continues once sent or when it could
 * not be sent. Mounted by NodeConfigForm.
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { STOREFRONT_LINK_LIMITS, type SendStorefrontLinkNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

export function StorefrontLinkForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config as unknown as Partial<SendStorefrontLinkNodeConfig>;
  const id = (field: string) => `storefront-${node.node_key}-${field}`;
  return (
    <>
      <div>
        <label htmlFor={id("purpose")} className={label}>{t("storefrontPurpose")}</label>
        <Select value={cfg.purpose ?? "shop"} onValueChange={(value) => onUpdateConfig({ purpose: value })}>
          <SelectTrigger id={id("purpose")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="shop">{t("storefrontPurposeShop")}</SelectItem>
            <SelectItem value="status">{t("storefrontPurposeStatus")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor={id("message")} className={label}>{t("storefrontMessage", { max: STOREFRONT_LINK_LIMITS.messageMax })}</label>
        <Textarea
          id={id("message")}
          value={cfg.message ?? ""}
          maxLength={STOREFRONT_LINK_LIMITS.messageMax}
          rows={3}
          onChange={(e) => onUpdateConfig({ message: e.target.value })}
          className="bg-muted"
        />
        <p className={help}>{t("storefrontMessageHelp")}</p>
      </div>
      <div>
        <label htmlFor={id("ttl")} className={label}>{t("storefrontTtl")}</label>
        <Input
          id={id("ttl")}
          type="number"
          min={STOREFRONT_LINK_LIMITS.ttlMinHours}
          max={STOREFRONT_LINK_LIMITS.ttlMaxHours}
          value={typeof cfg.ttl_hours === "number" ? String(cfg.ttl_hours) : ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            onUpdateConfig({ ttl_hours: e.target.value === "" || !Number.isFinite(n) ? undefined : Math.trunc(n) });
          }}
          className="bg-muted"
        />
        <p className={help}>{t("storefrontTtlHelp", { min: STOREFRONT_LINK_LIMITS.ttlMinHours, max: STOREFRONT_LINK_LIMITS.ttlMaxHours })}</p>
      </div>
      <NextNodeRow
        label={t("storefrontNext")}
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
      />
      <NextNodeRow
        label={t("storefrontFailedNext")}
        value={cfg.failed_next ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ failed_next: v })}
      />
    </>
  );
}
