"use client";

/**
 * Form for the payment_link step: the amount and currency, what the payment
 * page and the WhatsApp message say, when the link expires, and where the
 * run continues when the payment is made, the link expires or it could not
 * be sent. Mounted by NodeConfigForm; the timeout port comes from the shared
 * TimingFields.
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_LINK_LIMITS } from "@/lib/flows/payment-node";
import type { PaymentLinkNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

export function PaymentLinkForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config as unknown as Partial<PaymentLinkNodeConfig>;
  const id = (field: string) => `payment-${node.node_key}-${field}`;
  const port = (field: "paid_next" | "expired_next" | "failed_next", key: string) => (
    <NextNodeRow
      label={t(key)}
      value={cfg[field] ?? ""}
      allNodes={allNodes}
      currentKey={node.node_key}
      onChange={(v) => onUpdateConfig({ [field]: v })}
    />
  );
  const linkOrder = cfg.link_order === true;
  return (
    <>
      <div>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id("link-order")} className="text-xs text-muted-foreground">{t("paymentLinkOrder")}</label>
          <Switch
            id={id("link-order")}
            checked={linkOrder}
            onCheckedChange={(checked) => onUpdateConfig({ link_order: checked || undefined })}
          />
        </div>
        <p className={help}>{t("paymentLinkOrderHelp")}</p>
      </div>
      {!linkOrder && (<>
      <div className="grid grid-cols-[1fr_96px] gap-2">
        <div>
          <label htmlFor={id("amount")} className={label}>{t("paymentAmount")}</label>
          <Input
            id={id("amount")}
            value={cfg.amount ?? ""}
            inputMode="decimal"
            maxLength={100}
            onChange={(e) => onUpdateConfig({ amount: e.target.value })}
            placeholder="499.00"
            className="bg-muted"
          />
        </div>
        <div>
          <label htmlFor={id("currency")} className={label}>{t("paymentCurrency")}</label>
          <Input
            id={id("currency")}
            value={cfg.currency ?? ""}
            maxLength={3}
            onChange={(e) => onUpdateConfig({ currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })}
            className="bg-muted font-mono uppercase"
          />
        </div>
      </div>
      <p className={help}>{t("paymentAmountHelp")}</p>
      </>)}
      <div>
        <label htmlFor={id("description")} className={label}>{t("paymentDescription", { max: PAYMENT_LINK_LIMITS.description })}</label>
        <Input
          id={id("description")}
          value={cfg.description ?? ""}
          maxLength={PAYMENT_LINK_LIMITS.description}
          onChange={(e) => onUpdateConfig({ description: e.target.value || undefined })}
          className="bg-muted"
        />
      </div>
      <div>
        <label htmlFor={id("message")} className={label}>{t("paymentMessage", { max: PAYMENT_LINK_LIMITS.message })}</label>
        <Textarea
          id={id("message")}
          value={cfg.message ?? ""}
          maxLength={PAYMENT_LINK_LIMITS.message}
          rows={3}
          onChange={(e) => onUpdateConfig({ message: e.target.value })}
          className="bg-muted"
        />
        <p className={help}>{t("paymentMessageHelp")}</p>
      </div>
      <div>
        <label htmlFor={id("expire")} className={label}>{t("paymentExpire")}</label>
        <Input
          id={id("expire")}
          type="number"
          min={PAYMENT_LINK_LIMITS.expireMinMinutes}
          max={PAYMENT_LINK_LIMITS.expireMaxMinutes}
          value={typeof cfg.expire_minutes === "number" ? String(cfg.expire_minutes) : ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            onUpdateConfig({ expire_minutes: e.target.value === "" || !Number.isFinite(n) ? undefined : Math.trunc(n) });
          }}
          className="bg-muted"
        />
        <p className={help}>{t("paymentExpireHelp", { min: PAYMENT_LINK_LIMITS.expireMinMinutes })}</p>
      </div>
      {port("paid_next", "paymentPaidNext")}
      {port("expired_next", "paymentExpiredNext")}
      {port("failed_next", "paymentFailedNext")}
      <p className={help}>{t("paymentVarsHelp")}</p>
    </>
  );
}
