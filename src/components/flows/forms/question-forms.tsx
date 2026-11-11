"use client";

/**
 * Forms for the question nodes (collect_input and ask_*), set_attribute,
 * the rule-based condition, and the timing settings every node shares.
 * Mounted by NodeConfigForm, so the list and canvas views stay in step.
 */

import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { browserTimeZone, listTimeZones } from "@/lib/automations/time-of-day";
import { conditionRules } from "@/lib/flows/conditions";
import type { ConditionNodeConfig, ConditionRule, ConditionSubject, FlowChannelScope, FlowSaveTo } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow, TextRow } from "./fields";
import { useCustomFields, useSegments, useSequences, useUserTags } from "./use-pickers";
import { useWorkspaceFields } from "./variable-picker";
import { ActionsEditor, readActions } from "./actions-form";
import {
  conditionSubjectsFor,
  groupSubjects,
  INSTAGRAM_SUBJECTS,
  isYesNoSubject,
  linkSteps,
  operatorsFor,
  ruleForSubject,
  subjectKeys,
} from "./condition-subjects";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const WAITING = new Set(["send_buttons", "send_list", "collect_input", "ask_media", "ask_location", "ask_address", "send_form", "payment_link"]);

/** A whole-number input that stores `undefined` when cleared. */
function NumberField({ id, value, onChange, min, max }: { id: string; value: unknown; onChange: (v: number | undefined) => void; min?: number; max?: number }) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={typeof value === "number" ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      className="bg-muted"
    />
  );
}

function VarKeyField({ id, value, onChange, t }: { id: string; value: string; onChange: (v: string) => void; t: T }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{t("varKeyLabel")}</label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
        placeholder={t("varKeyPlaceholder")}
        className="bg-muted font-mono text-xs"
      />
      <p className={help}>
        {t("varKeyHelp")} <code className="rounded bg-muted px-1">{`{{vars.${value || "name"}}}`}</code>.
      </p>
    </div>
  );
}

// ------------------------------------------------------------ Save answer to (Stage 5)

export function readSaveTo(value: unknown): FlowSaveTo | undefined {
  const v = value as FlowSaveTo | null;
  return v && typeof v === "object" && (v.target === "contact_field" || v.target === "custom_field") && typeof v.key === "string" ? v : undefined;
}

const NO_SAVE = "__none__";

/**
 * "Save answer to": a contact field (name, email, phone, company) or a custom
 * field. A phone or email owned by another contact is not written (5B).
 */
function SaveToField({ id, value, onChange, t }: { id: string; value: FlowSaveTo | undefined; onChange: (v: FlowSaveTo | undefined) => void; t: T }) {
  const ts = useTranslations("Flows.saveTo");
  const fields = useCustomFields();
  const selected = value ? `${value.target}:${value.key}` : NO_SAVE;
  return (
    <div>
      <label htmlFor={id} className={label}>{ts("label")}</label>
      <Select value={selected} onValueChange={(v) => {
        if (!v || v === NO_SAVE) return onChange(undefined);
        const at = v.indexOf(":");
        onChange({ target: v.slice(0, at) as FlowSaveTo["target"], key: v.slice(at + 1) });
      }}>
        <SelectTrigger id={id} className="bg-muted">
          <SelectValue>{(v: string) => (v === NO_SAVE ? ts("none") : v.startsWith("custom_field:")
            ? fields.find((f) => `custom_field:${f.id}` === v)?.field_name ?? v.slice("custom_field:".length)
            : v.slice("contact_field:".length))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SAVE}>{ts("none")}</SelectItem>
          <SelectGroup>
            <SelectLabel>{ts("contactField")}</SelectLabel>
            {["name", "email", "phone", "company"].map((f) => <SelectItem key={f} value={`contact_field:${f}`}>{f}</SelectItem>)}
          </SelectGroup>
          {fields.length > 0 && (
            <SelectGroup>
              <SelectLabel>{ts("customField")}</SelectLabel>
              {fields.map((f) => <SelectItem key={f.id} value={`custom_field:${f.id}`}>{f.field_name}</SelectItem>)}
            </SelectGroup>
          )}
          {value?.target === "custom_field" && !fields.some((f) => f.id === value.key) && (
            <SelectItem value={selected}>{value.key}</SelectItem>
          )}
        </SelectContent>
      </Select>
      <p className={help}>{value && (value.key === "email" || value.key === "phone") ? ts("conflictNote") : t("varKeyHelp")}</p>
    </div>
  );
}

// ============================================================
// Questions: collect_input (Ask question), ask_media, ask_location, ask_address
// ============================================================

export function QuestionForm({ node, allNodes, onUpdateConfig, t, instagram = false }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  t: T;
  /** Instagram flows (Stage 5): "Save answer to" and actions on a valid answer. */
  instagram?: boolean;
}) {
  const cfg = node.config as Record<string, unknown>;
  const key = node.node_key;
  const format = typeof cfg.validation === "string" ? cfg.validation : "any";
  const canSkip = node.node_type === "collect_input" || node.node_type === "ask_media";
  const mediaTypes = Array.isArray(cfg.media_types) ? (cfg.media_types as string[]) : [];
  const varName = typeof cfg.var_key === "string" && cfg.var_key ? cfg.var_key : "answer";
  const tActions = useTranslations("Flows.nodes.actions");
  const formatHelp: Record<string, string> = {
    phone: "validationPhoneHelp",
    number: "validationNumberHelp",
    date: "validationDateHelp",
    boolean: "validationBooleanHelp",
  };
  return (
    <>
      <TextRow
        label={t("promptToCustomer")}
        value={typeof cfg.prompt_text === "string" ? cfg.prompt_text : ""}
        onChange={(v) => onUpdateConfig({ prompt_text: v })}
        rows={2}
        variables={{ nodes: allNodes, currentKey: key }}
      />
      {node.node_type === "collect_input" && (
        <div className="space-y-2">
          <label htmlFor={`validation-${key}`} className="block text-xs text-muted-foreground">{t("inputValidation")}</label>
          <Select value={format} onValueChange={(value) => onUpdateConfig({ validation: value })}>
            <SelectTrigger id={`validation-${key}`} className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t("validationAny")}</SelectItem>
              <SelectItem value="number">{t("validationNumber")}</SelectItem>
              <SelectItem value="date">{t("validationDate")}</SelectItem>
              <SelectItem value="boolean">{t("validationBoolean")}</SelectItem>
              <SelectItem value="email">{t("validationEmail")}</SelectItem>
              <SelectItem value="phone">{t("validationPhone")}</SelectItem>
              <SelectItem value="regex">{t("validationRegex")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t(formatHelp[format] ?? "validationHelp")}</p>
          {format === "regex" && (
            <TextRow label={t("validationPattern")} value={typeof cfg.regex === "string" ? cfg.regex : ""} onChange={(regex) => onUpdateConfig({ regex })} rows={2} />
          )}
          {format === "number" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`min-${key}`} className={label}>{t("minLabel")}</label>
                <NumberField id={`min-${key}`} value={cfg.min} onChange={(min) => onUpdateConfig({ min })} />
              </div>
              <div>
                <label htmlFor={`max-${key}`} className={label}>{t("maxLabel")}</label>
                <NumberField id={`max-${key}`} value={cfg.max} onChange={(max) => onUpdateConfig({ max })} />
              </div>
            </div>
          )}
        </div>
      )}
      {node.node_type === "ask_media" && (
        <fieldset>
          <legend className={label}>{t("acceptedMedia")}</legend>
          <div className="flex flex-wrap gap-3">
            {(["image", "video", "document", "audio"] as const).map((type) => (
              <label key={type} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={mediaTypes.includes(type)}
                  onChange={(e) => onUpdateConfig({ media_types: e.target.checked ? [...mediaTypes, type] : mediaTypes.filter((m) => m !== type) })}
                />
                {t(`mediaKind_${type}`)}
              </label>
            ))}
          </div>
          <p className={help}>{t("acceptedMediaHelp", { name: varName })}</p>
        </fieldset>
      )}
      {node.node_type === "ask_location" && <p className="text-xs text-muted-foreground">{t("locationHelp", { name: varName })}</p>}
      {node.node_type === "ask_address" && <p className="text-xs text-muted-foreground">{t("addressHelp", { name: varName })}</p>}
      <VarKeyField id={`var-${key}`} value={typeof cfg.var_key === "string" ? cfg.var_key : ""} onChange={(var_key) => onUpdateConfig({ var_key })} t={t} />
      {instagram && node.node_type === "collect_input" && (
        <>
          <SaveToField id={`save-to-${key}`} value={readSaveTo(cfg.save_to)} onChange={(save_to) => onUpdateConfig({ save_to })} t={t} />
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">{tActions("onSuccess")}</p>
            <ActionsEditor idBase={`on-success-${key}`} actions={readActions(cfg.on_success_actions)} allNodes={allNodes} currentKey={key}
              allowEmpty onChange={(next) => onUpdateConfig({ on_success_actions: next.length ? next : undefined })} />
          </div>
        </>
      )}
      <NextNodeRow
        value={typeof cfg.next_node_key === "string" ? cfg.next_node_key : ""}
        allNodes={allNodes}
        currentKey={key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advanceAfterCapture")}
      />

      <div className="space-y-3 rounded-md border border-border p-3">
        <p className="text-xs font-medium text-foreground">{t("retryTitle")}</p>
        <div>
          <label htmlFor={`attempts-${key}`} className={label}>{t("maxAttemptsLabel")}</label>
          <NumberField
            id={`attempts-${key}`}
            min={1}
            max={10}
            value={cfg.max_attempts}
            onChange={(max_attempts) => onUpdateConfig(max_attempts === undefined ? { max_attempts, exhausted_next: undefined } : { max_attempts })}
          />
          <p className={help}>{t("maxAttemptsHelp")}</p>
        </div>
        {typeof cfg.max_attempts === "number" && (
          <>
            <TextRow label={t("errorTextLabel")} value={typeof cfg.error_text === "string" ? cfg.error_text : ""} onChange={(error_text) => onUpdateConfig({ error_text })} rows={2}
              variables={{ nodes: allNodes, currentKey: key }} />
            <NextNodeRow
              value={typeof cfg.exhausted_next === "string" ? cfg.exhausted_next : ""}
              allNodes={allNodes}
              currentKey={key}
              onChange={(v) => onUpdateConfig({ exhausted_next: v })}
              label={t("exhaustedLabel")}
            />
            <p className={help}>{t("exhaustedHelp")}</p>
          </>
        )}
      </div>

      {canSkip && (
        <div className="space-y-3">
          <div>
            <label htmlFor={`skip-${key}`} className={label}>{t("skipLabelLabel")}</label>
            <Input
              id={`skip-${key}`}
              value={typeof cfg.skip_label === "string" ? cfg.skip_label : ""}
              maxLength={20}
              onChange={(e) => onUpdateConfig(e.target.value ? { skip_label: e.target.value } : { skip_label: undefined, skip_next: undefined })}
              className="bg-muted"
            />
            <p className={help}>{t("skipHelp")}</p>
          </div>
          {typeof cfg.skip_label === "string" && cfg.skip_label && (
            <NextNodeRow
              value={typeof cfg.skip_next === "string" ? cfg.skip_next : ""}
              allNodes={allNodes}
              currentKey={key}
              onChange={(v) => onUpdateConfig({ skip_next: v })}
              label={t("skipNextLabel")}
            />
          )}
        </div>
      )}
    </>
  );
}

// ============================================================
// set_attribute
// ============================================================

export function SetAttributeForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config as { target?: string; key?: string; value?: string; next_node_key?: string };
  const target = cfg.target ?? "var";
  const fields = useCustomFields();
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={`target-${node.node_key}`} className={label}>{t("setTarget")}</label>
          <Select value={target} onValueChange={(v) => onUpdateConfig({ target: v, key: "" })}>
            <SelectTrigger id={`target-${node.node_key}`} className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="var">{t("targetVar")}</SelectItem>
              <SelectItem value="contact_field">{t("targetContactField")}</SelectItem>
              <SelectItem value="custom_field">{t("targetCustomField")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor={`key-${node.node_key}`} className={label}>
            {target === "var" ? t("varName") : target === "contact_field" ? t("fieldLabel") : t("targetCustomField")}
          </label>
          {target === "var" ? (
            <Input
              id={`key-${node.node_key}`}
              value={cfg.key ?? ""}
              onChange={(e) => onUpdateConfig({ key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
              placeholder={t("varKeyPlaceholder")}
              className="bg-muted font-mono text-xs"
            />
          ) : (
            <Select value={cfg.key ?? ""} onValueChange={(v) => onUpdateConfig({ key: v })}>
              <SelectTrigger id={`key-${node.node_key}`} className="bg-muted">
                <SelectValue placeholder={target === "contact_field" ? t("pickField") : t("pickCustomField")} />
              </SelectTrigger>
              <SelectContent>
                {target === "contact_field"
                  ? ["name", "email", "company"].map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)
                  : fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.field_name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <div>
        <TextRow label={t("attributeValue")} value={cfg.value ?? ""} onChange={(value) => onUpdateConfig({ value })} rows={2}
          variables={{ nodes: allNodes, currentKey: node.node_key }} />
        <p className={help}>{t.raw("attributeValueHelp")}</p>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

// ============================================================
// condition (rules joined by all / any)
// ============================================================

const VALUE_OPERATORS = new Set(["equals", "not_equals", "contains", "gt", "gte", "lt", "lte", "between"]);

export function ConditionForm({ node, allNodes, onUpdateConfig, t, scope = "whatsapp" }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  t: T;
  /** The flow's channel scope: Instagram flows get the Stage 5 subjects. */
  scope?: FlowChannelScope;
}) {
  const tc = useTranslations("Flows.conditions");
  const cfg = node.config as unknown as ConditionNodeConfig;
  const rules = conditionRules(cfg);
  const tags = useUserTags();
  const fields = useCustomFields();
  const usesClock = rules.some((r) => r.subject === "time" || r.subject === "date");
  // Rules are always saved in the grouped shape; the single-test fields are cleared.
  const save = (next: ConditionRule[], extra: Record<string, unknown> = {}) => {
    const clock = next.some((r) => r.subject === "time" || r.subject === "date");
    onUpdateConfig({
      rules: next,
      subject: undefined,
      subject_key: undefined,
      operator: undefined,
      value: undefined,
      value2: undefined,
      ...(clock && !cfg.timezone ? { timezone: browserTimeZone() } : {}),
      ...extra,
    });
  };
  const update = (i: number, patch: Partial<ConditionRule>) => save(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {scope === "instagram" ? (
          // Stage 5: "Does the contact match all / any of these conditions?" as a toggle.
          <div className="md:col-span-2">
            <p id={`match-${node.node_key}`} className={label}>{tc("question", { match: tc(cfg.match === "any" ? "any" : "all") })}</p>
            <div role="radiogroup" aria-labelledby={`match-${node.node_key}`} className="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
              {(["all", "any"] as const).map((match) => {
                const active = (cfg.match ?? "all") === match;
                return (
                  <button key={match} type="button" role="radio" aria-checked={active} onClick={() => { if (!active) save(rules, { match }); }}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                    {tc(match)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div>
            <label htmlFor={`match-${node.node_key}`} className={label}>{t("matchLabel")}</label>
            <Select value={cfg.match ?? "all"} onValueChange={(match) => save(rules, { match })}>
              <SelectTrigger id={`match-${node.node_key}`} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("matchAll")}</SelectItem>
                <SelectItem value="any">{t("matchAny")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {usesClock && (
          <div>
            <label htmlFor={`tz-${node.node_key}`} className={label}>{t("timezoneLabel")}</label>
            <Select value={cfg.timezone ?? "UTC"} onValueChange={(timezone) => onUpdateConfig({ timezone })}>
              <SelectTrigger id={`tz-${node.node_key}`} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                {listTimeZones(cfg.timezone).map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {rules.map((rule, i) => {
        const id = `${node.node_key}-rule-${i}`;
        const clock = rule.subject === "time" || rule.subject === "date";
        // Stage 5 subjects (Instagram flows) have their own key, operator and value pickers.
        if (isStage5Subject(rule.subject)) {
          return (
            <Stage5RuleRow key={i} id={id} n={i + 1} rule={rule} scope={scope} allNodes={allNodes} currentKey={node.node_key}
              canRemove={rules.length > 1} onRemove={() => save(rules.filter((_, j) => j !== i))}
              onChange={(next) => save(rules.map((r, j) => (j === i ? next : r)))} t={t} />
          );
        }
        return (
          <div key={i} className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">{t("ruleN", { n: i + 1 })}</p>
              {rules.length > 1 && (
                <Button type="button" variant="ghost" size="sm" aria-label={t("removeRule")} onClick={() => save(rules.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label htmlFor={`${id}-subject`} className={label}>{t("ifLabel")}</label>
                <SubjectSelect id={`${id}-subject`} value={rule.subject} scope={scope} t={t}
                  onChange={(subject) => save(rules.map((r, j) => (j !== i ? r : isStage5Subject(subject) ? ruleForSubject(subject) : {
                    ...r,
                    subject,
                    subject_key: "",
                    operator: subject === "time" ? "between" : subject === "date" ? "equals" : r.operator,
                  })))} />
              </div>
              {!clock && (
                <div>
                  <label htmlFor={`${id}-key`} className={label}>
                    {rule.subject === "var" ? t("varName") : rule.subject === "tag" ? t("tagLabel") : t("fieldLabel")}
                  </label>
                  {rule.subject === "tag" && tags.length > 0 ? (
                    <Select value={rule.subject_key} onValueChange={(subject_key) => update(i, { subject_key: subject_key ?? "" })}>
                      <SelectTrigger id={`${id}-key`} className="bg-muted"><SelectValue placeholder={t("pickTag")} /></SelectTrigger>
                      <SelectContent>{tags.map((tag) => <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : rule.subject === "contact_field" || rule.subject === "custom_field" ? (
                    <Select value={rule.subject_key} onValueChange={(subject_key) => update(i, { subject_key: subject_key ?? "" })}>
                      <SelectTrigger id={`${id}-key`} className="bg-muted">
                        <SelectValue placeholder={rule.subject === "contact_field" ? t("pickField") : t("pickCustomField")} />
                      </SelectTrigger>
                      <SelectContent>
                        {rule.subject === "contact_field"
                          ? ["name", "email", "phone", "company"].map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)
                          : fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.field_name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`${id}-key`}
                      value={rule.subject_key}
                      onChange={(e) => update(i, { subject_key: e.target.value })}
                      placeholder={rule.subject === "var" ? t("varKeyPlaceholder") : t("tagUuidPlaceholder")}
                      className="bg-muted font-mono text-xs"
                    />
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label htmlFor={`${id}-op`} className={label}>{t("operatorLabel")}</label>
                <Select value={rule.operator} onValueChange={(operator) => update(i, { operator: operator as ConditionRule["operator"] })}>
                  <SelectTrigger id={`${id}-op`} className="bg-muted"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!clock && <SelectItem value="present">{t("isPresent")}</SelectItem>}
                    {!clock && <SelectItem value="absent">{t("isAbsent")}</SelectItem>}
                    <SelectItem value="equals">{t("equals")}</SelectItem>
                    <SelectItem value="not_equals">{t("notEquals")}</SelectItem>
                    {!clock && <SelectItem value="contains">{t("contains")}</SelectItem>}
                    <SelectItem value="gt">{t("opGt")}</SelectItem>
                    <SelectItem value="gte">{t("opGte")}</SelectItem>
                    <SelectItem value="lt">{t("opLt")}</SelectItem>
                    <SelectItem value="lte">{t("opLte")}</SelectItem>
                    <SelectItem value="between">{t("opBetween")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {VALUE_OPERATORS.has(rule.operator) && (
                <div>
                  <label htmlFor={`${id}-value`} className={label}>{t("valueLabel")}</label>
                  <Input
                    id={`${id}-value`}
                    value={rule.value ?? ""}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder={rule.subject === "time" ? "09:00" : rule.subject === "date" ? "2026-12-25" : undefined}
                    className="bg-muted"
                  />
                </div>
              )}
              {rule.operator === "between" && (
                <div>
                  <label htmlFor={`${id}-value2`} className={label}>{t("value2Label")}</label>
                  <Input
                    id={`${id}-value2`}
                    value={rule.value2 ?? ""}
                    onChange={(e) => update(i, { value2: e.target.value })}
                    placeholder={rule.subject === "time" ? "18:00" : rule.subject === "date" ? "2026-12-31" : undefined}
                    className="bg-muted"
                  />
                </div>
              )}
            </div>
            {rule.subject === "time" && <p className={help}>{t("timeHelp")}</p>}
            {rule.subject === "date" && <p className={help}>{t("dateHelp")}</p>}
          </div>
        );
      })}
      {rules.length < 10 && (scope === "instagram" ? (
        // Stage 5: a searchable, grouped field picker (Recommended, General filters, System fields).
        <SubjectSearchPicker scope={scope} t={t} onPick={(subject) => save([...rules, ruleForSubject(subject)])} />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => save([...rules, { subject: "var", subject_key: "", operator: "equals", value: "" }])}
        >
          <Plus className="size-3.5" /> {t("addRule")}
        </Button>
      ))}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.true_next ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ true_next: v })}
          label={t("ifTrueAdvance")}
        />
        <NextNodeRow
          value={cfg.false_next ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ false_next: v })}
          label={t("ifFalseAdvance")}
        />
      </div>
    </>
  );
}

// ------------------------------------------------------------ Stage 5 condition subjects

/** Subjects whose rule has its own pickers (Stage 5 rows), not the classic key / operator / value row. */
export function isStage5Subject(subject: ConditionSubject): boolean {
  return INSTAGRAM_SUBJECTS.includes(subject);
}

/** The label of a subject: the classic keys for the original six, Flows.conditions.subjects for the rest. */
function useSubjectLabel(t: T): (subject: ConditionSubject) => string {
  const tc = useTranslations("Flows.conditions");
  const classic: Partial<Record<ConditionSubject, string>> = {
    var: "capturedVariable", tag: "contactHasTag", contact_field: "contactField",
    custom_field: "targetCustomField", time: "subjectTime", date: "subjectDate",
  };
  return (subject) => (classic[subject] ? t(classic[subject]) : tc(`subjects.${subject}`));
}

/** The subject of one rule. WhatsApp flows list the original six, exactly as before; Instagram flows add grouped Stage 5 subjects. */
function SubjectSelect({ id, value, scope, onChange, t }: {
  id: string;
  value: ConditionSubject;
  scope: FlowChannelScope;
  onChange: (subject: ConditionSubject) => void;
  t: T;
}) {
  const tc = useTranslations("Flows.conditions");
  const labelOf = useSubjectLabel(t);
  const subjects = conditionSubjectsFor(scope);
  const grouped = scope === "instagram";
  return (
    <Select value={value} onValueChange={(subject) => onChange(subject as ConditionSubject)}>
      <SelectTrigger id={id} className="bg-muted"><SelectValue>{(v: ConditionSubject) => labelOf(v)}</SelectValue></SelectTrigger>
      <SelectContent>
        {grouped
          ? groupSubjects(subjects).map((g) => (
            <SelectGroup key={g.group}>
              <SelectLabel>{tc(`groups.${g.group}`)}</SelectLabel>
              {g.subjects.map((s) => <SelectItem key={s} value={s}>{labelOf(s)}</SelectItem>)}
            </SelectGroup>
          ))
          : subjects.map((s) => <SelectItem key={s} value={s}>{labelOf(s)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** "+ Condition" on Instagram flows: a searchable picker grouped as Recommended, General filters and System fields. */
function SubjectSearchPicker({ scope, onPick, t }: { scope: FlowChannelScope; onPick: (subject: ConditionSubject) => void; t: T }) {
  const tc = useTranslations("Flows.conditions");
  const labelOf = useSubjectLabel(t);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const groups = groupSubjects(conditionSubjectsFor(scope).filter((s) => !q || labelOf(s).toLocaleLowerCase().includes(q)));
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 self-start rounded-md border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
        <Plus className="size-3.5" />{tc("add")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <Input autoFocus aria-label={tc("search")} placeholder={tc("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-7 text-xs" />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group} className="mb-1.5">
              <p className="px-1 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{tc(`groups.${g.group}`)}</p>
              {g.subjects.map((s) => (
                <button key={s} type="button" onClick={() => { onPick(s); setOpen(false); setQuery(""); }}
                  className="flex w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary">
                  {labelOf(s)}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const OPERATOR_LABEL: Record<ConditionRule["operator"], string> = {
  present: "isPresent", absent: "isAbsent", equals: "equals", not_equals: "notEquals", contains: "contains",
  gt: "opGt", gte: "opGte", lt: "opLt", lte: "opLte", between: "opBetween",
};

/** Yes / no wording per subject: "is in the segment", "clicked a link in this step", … */
function yesNoLabels(subject: ConditionSubject, tc: T): { yes: string; no: string } {
  switch (subject) {
    case "segment": return { yes: tc("inSegment"), no: tc("notInSegment") };
    case "link_click": return { yes: tc("clicked"), no: tc("notClicked") };
    case "sequence":
    case "system": return { yes: tc("subscribed"), no: tc("notSubscribed") };
    default: return { yes: tc("yes"), no: tc("no") };
  }
}

/**
 * One Stage 5 rule: the subject, its key (a fact, segment, step, workspace
 * field or sequence), then a yes/no choice or an operator and value as the
 * subject's type allows (condition-subjects.ts operatorsFor).
 */
function Stage5RuleRow({ id, n, rule, scope, allNodes, currentKey, canRemove, onRemove, onChange, t }: {
  id: string;
  n: number;
  rule: ConditionRule;
  scope: FlowChannelScope;
  allNodes: BuilderNode[];
  currentKey: string;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (rule: ConditionRule) => void;
  t: T;
}) {
  const tc = useTranslations("Flows.conditions");
  const segments = useSegments();
  const sequences = useSequences();
  const workspaceFields = useWorkspaceFields();
  const subject = rule.subject;
  const facts = subjectKeys(subject);
  const keyOptions: Array<{ id: string; name: string }> = facts
    ? facts.map((f) => ({ id: f, name: subject === "ig_profile" ? tc(`igFacts.${f}`) : tc(`systemFacts.${f}`) }))
    : subject === "segment" ? segments
      : subject === "sequence" ? sequences
        : subject === "workspace_field" ? workspaceFields.map((a) => ({ id: a.key, name: a.key }))
          : linkSteps(allNodes.filter((x) => x.node_key !== currentKey)).map((x) => ({ id: x.node_key, name: x.node_key }));
  const yesNo = isYesNoSubject(subject, rule.subject_key);
  const operators = operatorsFor(subject, rule.subject_key);
  const words = yesNoLabels(subject, tc);
  const setKey = (subject_key: string) => {
    const nextOps = operatorsFor(subject, subject_key);
    const nextYesNo = isYesNoSubject(subject, subject_key);
    onChange({
      ...rule,
      subject_key,
      operator: nextOps.includes(rule.operator) ? rule.operator : nextOps[0],
      value: nextYesNo ? (rule.value === "false" ? "false" : "true") : nextYesNo === yesNo ? rule.value : "",
      value2: undefined,
    });
  };
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-subject={subject}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">{t("ruleN", { n })}</p>
        {canRemove && (
          <Button type="button" variant="ghost" size="sm" aria-label={t("removeRule")} onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={`${id}-subject`} className={label}>{t("ifLabel")}</label>
          <SubjectSelect id={`${id}-subject`} value={subject} scope={scope} t={t}
            onChange={(next) => onChange(isStage5Subject(next) ? ruleForSubject(next) : { subject: next, subject_key: "", operator: next === "time" ? "between" : "equals", value: "" })} />
        </div>
        <div>
          <label htmlFor={`${id}-key`} className={label}>{tc(`subjects.${subject}`)}</label>
          <Select value={rule.subject_key} onValueChange={(v) => setKey(v ?? "")}>
            <SelectTrigger id={`${id}-key`} className="bg-muted">
              <SelectValue placeholder={tc("search")}>{(v: string) => (v ? keyOptions.find((o) => o.id === v)?.name ?? v : tc("search"))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {keyOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
              {rule.subject_key && !keyOptions.some((o) => o.id === rule.subject_key) && <SelectItem value={rule.subject_key}>{rule.subject_key}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>
      {yesNo ? (
        <div role="radiogroup" aria-label={tc(`subjects.${subject}`)} className="inline-flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
          {(["true", "false"] as const).map((v) => {
            const active = (rule.value === "false" ? "false" : "true") === v;
            return (
              <button key={v} type="button" role="radio" aria-checked={active}
                onClick={() => onChange({ ...rule, operator: "equals", value: v })}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {v === "true" ? words.yes : words.no}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label htmlFor={`${id}-op`} className={label}>{t("operatorLabel")}</label>
            <Select value={operators.includes(rule.operator) ? rule.operator : operators[0]}
              onValueChange={(operator) => onChange({ ...rule, operator: operator as ConditionRule["operator"] })}>
              <SelectTrigger id={`${id}-op`} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                {operators.map((op) => <SelectItem key={op} value={op}>{t(OPERATOR_LABEL[op])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {VALUE_OPERATORS.has(rule.operator) && (
            <div>
              <label htmlFor={`${id}-value`} className={label}>{t("valueLabel")}</label>
              <Input id={`${id}-value`} value={rule.value ?? ""} onChange={(e) => onChange({ ...rule, value: e.target.value })}
                inputMode={subject === "ig_profile" ? "numeric" : undefined}
                placeholder={rule.subject_key === "last_interaction_at" || rule.subject_key === "window_open_until" ? "2026-12-31T09:00" : undefined}
                className="bg-muted" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Timing: a delay on any node, a reply timeout on waiting nodes
// ============================================================

const UNITS = [
  { id: "hours", seconds: 3600 },
  { id: "minutes", seconds: 60 },
  { id: "seconds", seconds: 1 },
] as const;

export function TimingFields({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const cfg = node.config;
  const delay = typeof cfg.delay_seconds === "number" ? cfg.delay_seconds : undefined;
  const [unit, setUnit] = useState<(typeof UNITS)[number]>(
    () => UNITS.find((u) => delay !== undefined && delay % u.seconds === 0) ?? UNITS[2],
  );
  // Open once if already set; afterwards opening and closing stay with the user.
  const [initiallyOpen] = useState(() => delay !== undefined || cfg.timeout_minutes !== undefined);
  if (node.node_type === "start") return null;
  const key = node.node_key;
  return (
    <details className="rounded-md border border-border p-3" open={initiallyOpen}>
      <summary className="cursor-pointer text-xs font-medium text-foreground">{t("timingTitle")}</summary>
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor={`delay-${key}`} className={label}>{t("delayLabel")}</label>
          <div className="flex gap-2">
            <Input
              id={`delay-${key}`}
              type="number"
              inputMode="numeric"
              min={1}
              value={delay === undefined ? "" : delay / unit.seconds}
              onChange={(e) => onUpdateConfig({ delay_seconds: e.target.value === "" ? undefined : Math.round(Number(e.target.value) * unit.seconds) })}
              className="bg-muted"
            />
            <Select
              value={unit.id}
              onValueChange={(id) => {
                const next = UNITS.find((u) => u.id === id)!;
                setUnit(next);
                if (delay !== undefined) onUpdateConfig({ delay_seconds: Math.round((delay / unit.seconds) * next.seconds) });
              }}
            >
              <SelectTrigger className="w-32 bg-muted" aria-label={t("delayUnit")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => <SelectItem key={u.id} value={u.id}>{t(`unit_${u.id}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <p className={help}>{t("delayHelp")}</p>
        </div>
        {(WAITING.has(node.node_type) || (node.node_type === "send_template" && Array.isArray(cfg.buttons) && cfg.buttons.length > 0)) && (
          <>
            <div>
              <label htmlFor={`timeout-${key}`} className={label}>{t("timeoutLabel")}</label>
              <NumberField
                id={`timeout-${key}`}
                min={1}
                max={10080}
                value={cfg.timeout_minutes}
                onChange={(timeout_minutes) => onUpdateConfig(timeout_minutes === undefined ? { timeout_minutes, after_timeout: undefined } : { timeout_minutes })}
              />
              <p className={help}>{t("timeoutHelp")}</p>
            </div>
            {typeof cfg.timeout_minutes === "number" && (
              <NextNodeRow
                value={typeof cfg.after_timeout === "string" ? cfg.after_timeout : ""}
                allNodes={allNodes}
                currentKey={key}
                onChange={(v) => onUpdateConfig({ after_timeout: v })}
                label={t("afterTimeoutLabel")}
              />
            )}
          </>
        )}
      </div>
    </details>
  );
}
