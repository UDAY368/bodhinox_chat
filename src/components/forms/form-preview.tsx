"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Calendar, CheckCircle2, ChevronDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FormDefinition, FormField } from "@/lib/whatsapp/forms/types";

/**
 * An approximation of how WhatsApp draws the form: a full-height sheet with
 * the screen title, the components stacked in one column and a wide footer
 * button. Inputs are live but local; nothing is submitted. The footer and
 * back arrow move between screens, and the last footer shows the
 * confirmation the contact gets.
 */
export function FormPreview({
  definition,
  screenIndex,
  onScreenChange,
  formName,
}: {
  definition: FormDefinition;
  screenIndex: number;
  onScreenChange: (index: number) => void;
  formName: string;
}) {
  const t = useTranslations("Forms.preview");
  const [finished, setFinished] = useState(false);
  const index = Math.min(screenIndex, definition.screens.length - 1);
  const screen = definition.screens[index];
  const last = index === definition.screens.length - 1;

  if (!screen) return null;

  return (
    <div className="mx-auto w-full max-w-[340px]" aria-label={t("label")} role="region">
      <div className="overflow-hidden rounded-[1.75rem] border border-border bg-muted shadow-sm">
        <div className="bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">{formName}</div>
        <div className="flex min-h-[520px] flex-col bg-card text-foreground">
          <div className="flex items-center gap-3 border-b border-border px-3 py-3">
            {finished ? (
              <span className="h-5 w-5" />
            ) : index > 0 ? (
              <button type="button" aria-label={t("back")} onClick={() => onScreenChange(index - 1)} className="rounded p-0.5 hover:bg-muted">
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : (
              <X className="h-5 w-5" aria-hidden />
            )}
            <p className="min-w-0 flex-1 truncate text-center text-[15px] font-medium">{finished ? formName : screen.title || " "}</p>
            <span className="h-5 w-5" />
          </div>

          {finished ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden />
              <p className="whitespace-pre-wrap text-sm">{definition.success_message || t("successDefault")}</p>
              <button
                type="button"
                onClick={() => {
                  setFinished(false);
                  onScreenChange(0);
                }}
                className="mt-2 text-sm font-medium text-primary hover:underline"
              >
                {t("restart")}
              </button>
            </div>
          ) : (
            <>
              <div key={screen.id} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {screen.fields.length === 0 && <p className="text-center text-xs opacity-60">{t("emptyScreen")}</p>}
                {screen.fields.map((field) => (
                  <PreviewField key={field.id} field={field} optionalLabel={t("optional")} chooseLabel={t("choose")} />
                ))}
              </div>
              <div className="border-t border-border px-4 pb-4 pt-3">
                <button
                  type="button"
                  onClick={() => (last ? setFinished(true) : onScreenChange(index + 1))}
                  className="w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {screen.button_label || " "}
                </button>
                <p className="mt-2 text-center text-[10px] opacity-60">{t("managedBy")}</p>
              </div>
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        {t("screenOf", { current: index + 1, total: definition.screens.length })}
      </p>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-3 py-2.5 text-sm outline-none focus:border-primary";

function PreviewField({ field, optionalLabel, chooseLabel }: { field: FormField; optionalLabel: string; chooseLabel: string }) {
  const label = `${field.label}${field.required === false ? ` (${optionalLabel})` : ""}`;
  const helper = field.helper ? <span className="mt-1 block text-xs opacity-60">{field.helper}</span> : null;
  const options = field.options ?? [];

  switch (field.type) {
    case "heading":
      return <h3 className="text-lg font-bold leading-snug">{field.label}</h3>;
    case "paragraph":
      return <p className="whitespace-pre-wrap text-sm leading-relaxed">{field.label}</p>;
    case "short_text":
    case "email":
    case "phone":
    case "number":
      return (
        <label className="block text-sm">
          <input
            type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : field.type === "number" ? "number" : "text"}
            placeholder={label}
            aria-label={label}
            maxLength={field.max}
            className={inputClass}
          />
          {helper}
        </label>
      );
    case "long_text":
      return (
        <label className="block text-sm">
          <textarea placeholder={label} aria-label={label} maxLength={field.max} rows={3} className={cn(inputClass, "resize-none")} />
          {helper}
        </label>
      );
    case "date":
      return (
        <label className="block text-sm">
          <span className={cn(inputClass, "flex items-center justify-between opacity-80")}>
            {label}
            <Calendar className="h-4 w-4" aria-hidden />
          </span>
          {helper}
        </label>
      );
    case "dropdown":
      return (
        <label className="relative block text-sm">
          <span className="mb-1 block text-xs opacity-70">{label}</span>
          <select aria-label={label} defaultValue="" className={cn(inputClass, "appearance-none pr-8")}>
            <option value="" disabled>{chooseLabel}</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute bottom-3 right-3 h-4 w-4" aria-hidden />
        </label>
      );
    case "radio":
    case "checkboxes":
      return (
        <fieldset className="text-sm">
          <legend className="mb-2 font-medium">{label}</legend>
          <div className="divide-y divide-border">
            {options.map((o) => (
              <label key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                <span>{o.title}</span>
                <input
                  type={field.type === "radio" ? "radio" : "checkbox"}
                  name={field.id}
                  className="h-4 w-4 accent-primary"
                />
              </label>
            ))}
          </div>
        </fieldset>
      );
    case "opt_in":
      return (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
          <span>{label}</span>
        </label>
      );
    default:
      return null;
  }
}
