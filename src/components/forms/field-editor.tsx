"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FORM_LABEL_MAX, FORM_LIMITS } from "@/lib/whatsapp/forms/definition";
import type { FormField, FormSaveTo } from "@/lib/whatsapp/forms/types";
import type { FlowCustomField } from "@/components/flows/forms/use-pickers";
import { errorsUnder, fieldCapabilities, newOption } from "./form-editing";

const selectClass = "h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm text-foreground disabled:opacity-60";

function saveToValue(saveTo: FormSaveTo | null | undefined): string {
  if (!saveTo) return "";
  return saveTo.kind === "contact_field" ? `contact:${saveTo.field}` : `custom:${saveTo.field_id}`;
}

function parseSaveTo(value: string): FormSaveTo | null {
  if (value.startsWith("contact:")) return { kind: "contact_field", field: value.slice(8) as "name" | "email" | "company" };
  if (value.startsWith("custom:")) return { kind: "custom_field", field_id: value.slice(7) };
  return null;
}

/** Error text under one input; the id ties it to the input via aria-describedby. */
export function FieldErrors({ id, messages }: { id: string; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {messages.join(" ")}
    </p>
  );
}

export function FieldEditor({
  field,
  path,
  errors,
  readOnly,
  customFields,
  isFirst,
  isLast,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  path: string;
  errors: Map<string, string[]>;
  readOnly: boolean;
  customFields: FlowCustomField[];
  isFirst: boolean;
  isLast: boolean;
  onChange: (field: FormField) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const t = useTranslations("Forms.builder");
  const tType = useTranslations("Forms.fieldTypes");
  const uid = useId();
  const caps = fieldCapabilities(field.type);
  const display = !caps.required;
  const err = (key: string) => errors.get(`${path}.${key}`) ?? [];
  const errId = (key: string) => `${uid}-${key}-error`;
  const described = (key: string) => (err(key).length ? errId(key) : undefined);
  const set = (patch: Partial<FormField>) => onChange({ ...field, ...patch });
  const setNumber = (key: "min" | "max", raw: string) => {
    const next = { ...field };
    if (raw === "") delete next[key];
    else next[key] = Number(raw);
    onChange(next);
  };
  const hasErrors = errorsUnder(errors, path).length > 0;

  return (
    <div className={cn("space-y-3 rounded-xl border bg-card p-3", hasErrors ? "border-destructive/60" : "border-border")}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{tType(field.type)}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{field.label || t("untitledField")}</span>
        {!readOnly && (
          <div className="flex shrink-0 gap-0.5">
            <Button variant="ghost" size="icon-xs" aria-label={t("moveFieldUp")} disabled={isFirst} onClick={() => onMove(-1)}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={t("moveFieldDown")} disabled={isLast} onClick={() => onMove(1)}>
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={t("removeField")} onClick={onRemove} className="text-destructive">
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-label`}>{display ? t("textLabel") : t("questionLabel")}</Label>
        {field.type === "paragraph" ? (
          <Textarea
            id={`${uid}-label`}
            value={field.label}
            readOnly={readOnly}
            maxLength={FORM_LABEL_MAX.paragraph}
            aria-invalid={err("label").length > 0}
            aria-describedby={described("label")}
            onChange={(e) => set({ label: e.target.value })}
            className="min-h-20 bg-muted"
          />
        ) : (
          <Input
            id={`${uid}-label`}
            value={field.label}
            readOnly={readOnly}
            maxLength={FORM_LABEL_MAX[field.type]}
            aria-invalid={err("label").length > 0}
            aria-describedby={described("label")}
            onChange={(e) => set({ label: e.target.value })}
            className="bg-muted"
          />
        )}
        <p className="text-[11px] text-muted-foreground">{t("charCount", { count: field.label.length, max: FORM_LABEL_MAX[field.type] })}</p>
        <FieldErrors id={errId("label")} messages={err("label")} />
      </div>

      {!display && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-id`}>{t("fieldId")}</Label>
            <Input
              id={`${uid}-id`}
              value={field.id}
              readOnly={readOnly}
              maxLength={40}
              aria-invalid={err("id").length > 0}
              aria-describedby={described("id") ?? `${uid}-id-hint`}
              onChange={(e) => set({ id: e.target.value.toLowerCase() })}
              className="bg-muted font-mono text-xs"
            />
            <p id={`${uid}-id-hint`} className="text-[11px] text-muted-foreground">{t("fieldIdHint")}</p>
            <FieldErrors id={errId("id")} messages={err("id")} />
          </div>
          <div className="flex items-center gap-2 sm:pt-6">
            <Switch
              id={`${uid}-required`}
              checked={field.required === true}
              disabled={readOnly}
              onCheckedChange={(checked) => set({ required: checked })}
            />
            <Label htmlFor={`${uid}-required`}>{t("required")}</Label>
          </div>
        </div>
      )}

      {caps.helper && (
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-helper`}>{t("helper")}</Label>
          <Input
            id={`${uid}-helper`}
            value={field.helper ?? ""}
            readOnly={readOnly}
            maxLength={FORM_LIMITS.helperMax}
            aria-describedby={described("helper")}
            onChange={(e) => {
              const next = { ...field };
              if (e.target.value) next.helper = e.target.value;
              else delete next.helper;
              onChange(next);
            }}
            className="bg-muted"
          />
          <FieldErrors id={errId("helper")} messages={err("helper")} />
        </div>
      )}

      {caps.options && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("options")}</legend>
          {(field.options ?? []).map((option, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  value={option.title}
                  readOnly={readOnly}
                  maxLength={FORM_LIMITS.optionTitleMax}
                  aria-label={t("optionN", { n: i + 1 })}
                  aria-invalid={errorsUnder(errors, `${path}.options.${i}`).length > 0}
                  onChange={(e) => {
                    const options = [...(field.options ?? [])];
                    options[i] = { ...option, title: e.target.value };
                    set({ options });
                  }}
                  className="bg-muted"
                />
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("removeOptionN", { n: i + 1 })}
                    onClick={() => set({ options: (field.options ?? []).filter((_, j) => j !== i) })}
                  >
                    <X />
                  </Button>
                )}
              </div>
              <FieldErrors id={errId(`option-${i}`)} messages={errorsUnder(errors, `${path}.options.${i}`)} />
            </div>
          ))}
          <FieldErrors id={errId("options")} messages={err("options")} />
          {!readOnly && (field.options?.length ?? 0) < FORM_LIMITS.maxOptions && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => set({ options: [...(field.options ?? []), newOption(field, t("optionN", { n: (field.options?.length ?? 0) + 1 }))] })}
            >
              <Plus /> {t("addOption")}
            </Button>
          )}
        </fieldset>
      )}

      {(caps.min || caps.max) && (
        <div className="grid grid-cols-2 gap-3">
          {(["min", "max"] as const).filter((key) => caps[key]).map((key) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`${uid}-${key}`}>
                {field.type === "checkboxes" ? t(key === "min" ? "minSelected" : "maxSelected") : t(key === "min" ? "minChars" : "maxChars")}
              </Label>
              <Input
                id={`${uid}-${key}`}
                type="number"
                min={0}
                inputMode="numeric"
                value={field[key] ?? ""}
                readOnly={readOnly}
                aria-invalid={err(key).length > 0}
                aria-describedby={described(key)}
                onChange={(e) => setNumber(key, e.target.value)}
                className="bg-muted"
              />
              <FieldErrors id={errId(key)} messages={err(key)} />
            </div>
          ))}
        </div>
      )}

      {caps.saveTo && (
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-save`}>{t("saveTo")}</Label>
          <select
            id={`${uid}-save`}
            value={saveToValue(field.save_to)}
            disabled={readOnly}
            aria-describedby={described("save_to")}
            onChange={(e) => set({ save_to: parseSaveTo(e.target.value) })}
            className={selectClass}
          >
            <option value="">{t("saveToNone")}</option>
            <optgroup label={t("saveToContact")}>
              <option value="contact:name">{t("contactName")}</option>
              <option value="contact:email">{t("contactEmail")}</option>
              <option value="contact:company">{t("contactCompany")}</option>
            </optgroup>
            {customFields.length > 0 && (
              <optgroup label={t("saveToCustom")}>
                {customFields.map((cf) => (
                  <option key={cf.id} value={`custom:${cf.id}`}>{cf.field_name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <FieldErrors id={errId("save_to")} messages={err("save_to")} />
        </div>
      )}

      {/* Display fields have no ID input, so their id errors (e.g. a duplicate id) are listed here. */}
      <FieldErrors id={errId("type")} messages={[...err("type"), ...err("required"), ...(display ? err("id") : [])]} />
    </div>
  );
}
