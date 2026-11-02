"use client";

/**
 * Form for the send_form step: pick a published WhatsApp form, write the
 * message around it, name the variable for the answers and pick the next
 * step. Mounted by NodeConfigForm; timing (the timeout port) comes from
 * the shared TimingFields.
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SEND_FORM_LIMITS } from "@/lib/flows/validate";
import type { SendFormNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { usePublishedForms } from "./use-pickers";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";

export function SendFormStepForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config as unknown as Partial<SendFormNodeConfig>;
  const forms = usePublishedForms();
  const id = (field: string) => `form-${node.node_key}-${field}`;
  const varKey = cfg.var_key ?? "";
  // A form unpublished since it was picked still shows, so the step does not look empty.
  const missing = cfg.form_id && !forms.some((f) => f.id === cfg.form_id);
  const text = (field: "cta" | "header" | "footer", key: string) => (
    <div>
      <label htmlFor={id(field)} className={label}>{t(key, { max: SEND_FORM_LIMITS[field] })}</label>
      <Input
        id={id(field)}
        value={cfg[field] ?? ""}
        maxLength={SEND_FORM_LIMITS[field]}
        onChange={(e) => onUpdateConfig({ [field]: field === "cta" ? e.target.value : e.target.value || undefined })}
        className="bg-muted"
      />
    </div>
  );
  return (
    <>
      <div>
        <label htmlFor={id("form")} className={label}>{t("formLabel")}</label>
        <Select value={cfg.form_id ?? ""} onValueChange={(v) => onUpdateConfig({ form_id: v ?? "" })}>
          <SelectTrigger id={id("form")} className="bg-muted"><SelectValue placeholder={t("pickForm")} /></SelectTrigger>
          <SelectContent>
            {missing && <SelectItem value={cfg.form_id!}>{t("formUnavailable")}</SelectItem>}
            {forms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className={help}>{forms.length ? t("formHelp") : t("formNoneHelp")}</p>
      </div>
      {text("header", "formHeader")}
      <div>
        <label htmlFor={id("body")} className={label}>{t("formBody", { max: SEND_FORM_LIMITS.body })}</label>
        <Textarea
          id={id("body")}
          value={cfg.body ?? ""}
          maxLength={SEND_FORM_LIMITS.body}
          rows={3}
          onChange={(e) => onUpdateConfig({ body: e.target.value })}
          className="bg-muted"
        />
      </div>
      {text("footer", "formFooter")}
      {text("cta", "formCta")}
      <div>
        <label htmlFor={id("var")} className={label}>{t("varKeyLabel")}</label>
        <Input
          id={id("var")}
          value={varKey}
          onChange={(e) => onUpdateConfig({ var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
          placeholder={t("varKeyPlaceholder")}
          className="bg-muted font-mono text-xs"
        />
        <p className={help}>{t("formVarHelp", { name: varKey || "form" })}</p>
      </div>
      <NextNodeRow
        label={t("formAfterSubmit")}
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
      />
    </>
  );
}
