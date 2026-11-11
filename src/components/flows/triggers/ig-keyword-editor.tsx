"use client";

/**
 * Keyword chips plus a match mode ("contains" / "is exactly") for the
 * Instagram triggers. Enter, a comma or leaving the field adds what was
 * typed; at most 50 keywords of 100 characters (addKeywords).
 */

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IG_TRIGGER_LIMITS, type IgKeywordMode } from "@/lib/flows/types";
import { addKeywords } from "./ig-trigger-config";

const chip = "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs";

export function IgKeywordEditor({ id, label, help, keywords, mode, onChange }: {
  id: string;
  label: string;
  help?: string;
  keywords: string[];
  mode: IgKeywordMode;
  onChange: (next: { keywords: string[]; mode: IgKeywordMode }) => void;
}) {
  const tb = useTranslations("Flows.builder");
  const t = useTranslations("Flows.triggers.igComment");
  const [draft, setDraft] = useState("");
  const full = keywords.length >= IG_TRIGGER_LIMITS.keywords;
  const add = (text = draft) => {
    const next = addKeywords(keywords, text);
    if (next.length !== keywords.length) onChange({ keywords: next, mode });
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-muted-foreground text-xs">{label}</label>
        <Select value={mode} onValueChange={(m) => onChange({ keywords, mode: m as IgKeywordMode })}>
          <SelectTrigger className="bg-muted h-7 w-32 text-xs" aria-label={t("matchMode")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="contains">{t("modeContains")}</SelectItem>
            <SelectItem value="exact">{t("modeExact")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="border-border bg-muted flex flex-wrap items-center gap-1.5 rounded-md border p-1.5">
        {keywords.map((k) => (
          <span key={k} className={chip}>
            {k}
            <button type="button" aria-label={tb("removeKeyword", { keyword: k })}
              onClick={() => onChange({ keywords: keywords.filter((x) => x !== k), mode })}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={full}
          maxLength={IG_TRIGGER_LIMITS.keywordChars + 1}
          onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          onBlur={() => add()}
          placeholder={keywords.length ? "" : tb("keywordsPlaceholder")}
          className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
        />
      </div>
      {full ? (
        <p className="mt-1 text-[10px] text-amber-500">{t("tooManyKeywords", { max: IG_TRIGGER_LIMITS.keywords })}</p>
      ) : help ? (
        <p className="text-muted-foreground mt-1 text-[10px]">{help}</p>
      ) : null}
    </div>
  );
}
