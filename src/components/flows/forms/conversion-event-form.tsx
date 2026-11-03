"use client";

/**
 * Form for the conversion_event step: which Conversions API event to report,
 * an optional value (from a run variable) with its currency, and the next step.
 * Purchase is not offered: payment links and orders report it themselves.
 * Shows a hint when Meta ads are not enabled on this deployment, since the
 * step then queues nothing and simply moves on.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { FLOW_CONVERSION_EVENT_NAMES } from "@/lib/flows/conversion-node";
import type { ConversionEventNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

/** false only when the status route says Meta ads are off; null while unknown or unreachable. */
function useMetaAdsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await authFetch("/api/meta-ads/status", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { enabled?: unknown };
        if (live && typeof json.enabled === "boolean") setEnabled(json.enabled);
      } catch {
        // Unknown: show no hint rather than a wrong one.
      }
    })();
    return () => { live = false; };
  }, []);
  return enabled;
}

export function ConversionEventForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config as unknown as Partial<ConversionEventNodeConfig>;
  const id = (field: string) => `conversion-${node.node_key}-${field}`;
  const enabled = useMetaAdsEnabled();
  return (
    <>
      {enabled === false && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
          {t("conversionNotEnabled")}
        </p>
      )}
      <div>
        <label htmlFor={id("event")} className={label}>{t("conversionEventName")}</label>
        <Select value={cfg.event_name ?? ""} onValueChange={(value) => onUpdateConfig({ event_name: value })}>
          <SelectTrigger id={id("event")} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FLOW_CONVERSION_EVENT_NAMES.map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={help}>{t("conversionPurchaseNote")}</p>
      </div>
      <div className="grid grid-cols-[1fr_96px] gap-2">
        <div>
          <label htmlFor={id("value")} className={label}>{t("conversionValueVar")}</label>
          <Input
            id={id("value")}
            value={cfg.value_var ?? ""}
            maxLength={64}
            onChange={(e) => onUpdateConfig({ value_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") || undefined })}
            placeholder="order_total"
            className="bg-muted font-mono"
          />
        </div>
        <div>
          <label htmlFor={id("currency")} className={label}>{t("conversionCurrency")}</label>
          <Input
            id={id("currency")}
            value={cfg.currency ?? ""}
            maxLength={3}
            onChange={(e) => onUpdateConfig({ currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") || undefined })}
            placeholder={t("conversionCurrencyPlaceholder")}
            className="bg-muted font-mono uppercase"
          />
        </div>
      </div>
      <p className={help}>{t("conversionValueVarHelp")}</p>
      <NextNodeRow
        label={t("conversionNext")}
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
      />
      <p className={help}>{t("conversionHelp")}</p>
    </>
  );
}
