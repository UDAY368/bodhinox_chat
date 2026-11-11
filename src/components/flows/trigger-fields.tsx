"use client";

/**
 * Trigger settings for keyword (chips, exact / contains / regex, case,
 * ice breakers), template-reply, order and ad-click flows. Mounted by the trigger panel.
 */

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIceBreakers, useQuickReplyTemplates } from "./forms/use-pickers";

type T = ReturnType<typeof useTranslations>;
type Config = Record<string, unknown>;
const label = "text-muted-foreground mb-1 block text-xs";
const chip = "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs";

/** Keywords as chips: Enter or a comma adds one, × removes it. */
function KeywordChips({ keywords, onChange, t }: { keywords: string[]; onChange: (k: string[]) => void; t: T }) {
  const [draft, setDraft] = useState("");
  // Splits the given text (the live input value when a comma arrives, so a pasted list is kept).
  const add = (text = draft) => {
    const fresh = [...new Set(text.split(",").map((k) => k.trim()))].filter((k) => k && !keywords.includes(k));
    if (fresh.length) onChange([...keywords, ...fresh]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted p-1.5">
      {keywords.map((k) => (
        <span key={k} className={chip}>
          {k}
          <button type="button" aria-label={t("removeKeyword", { keyword: k })} onClick={() => onChange(keywords.filter((x) => x !== k))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={t("keywordsLabel")}
        value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={() => add()}
        placeholder={keywords.length ? "" : t("keywordsPlaceholder")}
        className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
      />
    </div>
  );
}

export function KeywordTriggerFields({ config, onChange, t }: { config: Config; onChange: (c: Config) => void; t: T }) {
  const iceBreakers = useIceBreakers();
  const keywords = Array.isArray(config.keywords) ? (config.keywords as string[]) : [];
  const matchType = typeof config.match_type === "string" ? config.match_type : "contains";
  return (
    <div className="space-y-3 md:col-span-2">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="trigger-match" className={label}>{t("matchTypeLabel")}</label>
          <Select value={matchType} onValueChange={(match_type) => onChange({ ...config, match_type })}>
            <SelectTrigger id="trigger-match" className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="contains">{t("matchContains")}</SelectItem>
              <SelectItem value="exact">{t("matchExact")}</SelectItem>
              <SelectItem value="regex">{t("matchRegex")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-xs">
          <input type="checkbox" checked={Boolean(config.case_sensitive)} onChange={(e) => onChange({ ...config, case_sensitive: e.target.checked })} />
          {t("caseSensitive")}
        </label>
      </div>
      {matchType === "regex" ? (
        <div>
          <label htmlFor="trigger-pattern" className={label}>{t("patternLabel")}</label>
          <Input id="trigger-pattern" value={typeof config.pattern === "string" ? config.pattern : ""} placeholder="^order\s*#?\d+"
            onChange={(e) => onChange({ ...config, pattern: e.target.value })} className="bg-muted font-mono text-xs" />
          <p className="mt-1 text-[10px] text-muted-foreground">{t("patternHelp")}</p>
        </div>
      ) : (
        <div>
          <span className={label}>{t("keywordsLabel")}</span>
          <KeywordChips keywords={keywords} onChange={(k) => onChange({ ...config, keywords: k })} t={t} />
        </div>
      )}
      {iceBreakers.length > 0 && matchType !== "regex" && (
        <div>
          <span className={label}>{t("iceBreakersLabel")}</span>
          <div className="flex flex-wrap gap-1.5">
            {iceBreakers.map((prompt) => (
              <button key={prompt} type="button" className={chip} disabled={keywords.includes(prompt)}
                onClick={() => onChange({ ...config, match_type: "exact", icebreaker: true, keywords: [...keywords, prompt] })}>
                + {prompt}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">{t("iceBreakersHelp")}</p>
        </div>
      )}
    </div>
  );
}

export function TemplateReplyTriggerFields({ config, onChange, t }: { config: Config; onChange: (c: Config) => void; t: T }) {
  const templates = useQuickReplyTemplates();
  const name = typeof config.template_name === "string" ? config.template_name : "";
  const chosen = Array.isArray(config.buttons) ? (config.buttons as string[]) : [];
  // Every language variant's quick replies, plus saved ones the template no longer has (so they can be unticked).
  const buttons = [...new Set([
    ...templates.filter((x) => x.name === name).flatMap((x) => (x.buttons ?? []).filter((b) => b.type === "QUICK_REPLY").map((b) => b.text)),
    ...chosen,
  ])];
  return (
    <div className="space-y-3 md:col-span-2">
      <div>
        <label htmlFor="trigger-template" className={label}>{t("templateLabel")}</label>
        <Select value={name} onValueChange={(template_name) => onChange({ ...config, template_name, buttons: [] })}>
          <SelectTrigger id="trigger-template" className="bg-muted"><SelectValue placeholder={t("pickTemplate")} /></SelectTrigger>
          <SelectContent>
            {[...new Set(templates.map((x) => x.name))].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {buttons.length > 0 && (
        <fieldset>
          <legend className={label}>{t("templateButtonsLabel")}</legend>
          <div className="flex flex-wrap gap-3">
            {buttons.map((b) => (
              <label key={b} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={chosen.includes(b)}
                  onChange={(e) => onChange({ ...config, buttons: e.target.checked ? [...chosen, b] : chosen.filter((x) => x !== b) })} />
                {b}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">{t.raw("templateButtonsHelp")}</p>
        </fieldset>
      )}
    </div>
  );
}

/** The variables an order_received flow starts with (set by the engine; see lib/commerce/order-format). */
export const ORDER_TRIGGER_VARIABLES = ["order_id", "order_total", "order_currency", "order_items_count", "order_items"] as const;

/** No settings: explains what starts the flow and lists the variables it gets. */
export function OrderReceivedTriggerFields({ t }: { t: T }) {
  return (
    <div className="space-y-2 md:col-span-2">
      <p className="text-xs text-muted-foreground">{t("orderTriggerHelp")}</p>
      <div className="flex flex-wrap gap-1.5" aria-label={t("orderTriggerVariables")}>
        {ORDER_TRIGGER_VARIABLES.map((v) => <code key={v} className={chip}>{`{{vars.${v}}}`}</code>)}
      </div>
    </div>
  );
}

/** The variables an ad_click flow starts with (set by the engine; never the click id). */
export const AD_CLICK_TRIGGER_VARIABLES = ["ad_id", "ad_headline", "ad_source_url"] as const;
const AD_CLICK_MAX_IDS = 50;

/**
 * Optional Meta ad ids as chips (empty = any ad), plus the variables the run
 * gets. `instagram`: the flow runs on Instagram, so the ads are click-to-Direct.
 */
export function AdClickTriggerFields({ config, onChange, t, instagram = false }: {
  config: Config; onChange: (c: Config) => void; t: T; instagram?: boolean;
}) {
  const ids = Array.isArray(config.ad_ids) ? (config.ad_ids as string[]) : [];
  const [draft, setDraft] = useState("");
  const set = (next: string[]) => {
    const { ad_ids: _drop, ...rest } = config;
    void _drop;
    onChange(next.length ? { ...rest, ad_ids: next } : rest);
  };
  const add = (text = draft) => {
    const fresh = [...new Set(text.split(/[\s,]+/).map((k) => k.trim()))].filter((k) => /^\d{1,32}$/.test(k) && !ids.includes(k));
    if (fresh.length) set([...ids, ...fresh].slice(0, AD_CLICK_MAX_IDS));
    setDraft("");
  };
  return (
    <div className="space-y-2 md:col-span-2">
      <p className="text-xs text-muted-foreground">{t(instagram ? "adClickTriggerHelpInstagram" : "adClickTriggerHelp")}</p>
      <div>
        <label htmlFor="trigger-ad-ids" className={label}>{t("adClickIdsLabel")}</label>
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted p-1.5">
          {ids.map((id) => (
            <span key={id} className={chip}>
              <span className="font-mono">{id}</span>
              <button type="button" aria-label={t("removeKeyword", { keyword: id })} onClick={() => set(ids.filter((x) => x !== id))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            id="trigger-ad-ids"
            value={draft}
            inputMode="numeric"
            onChange={(e) => (/[\s,]$/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            onBlur={() => add()}
            placeholder={ids.length ? "" : t("adClickIdsPlaceholder")}
            className="min-w-24 flex-1 bg-transparent px-1 font-mono text-sm outline-none"
          />
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("adClickIdsHelp", { max: AD_CLICK_MAX_IDS })}</p>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label={t("adClickVariables")}>
        {AD_CLICK_TRIGGER_VARIABLES.map((v) => <code key={v} className={chip}>{`{{vars.${v}}}`}</code>)}
      </div>
    </div>
  );
}
