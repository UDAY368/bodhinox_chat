"use client";

import { useId, useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  AtSign,
  BellRing,
  CalendarCheck,
  CalendarDays,
  ChefHat,
  CreditCard,
  FileText,
  Gift,
  GraduationCap,
  HelpCircle,
  Home,
  Landmark,
  Laptop,
  Leaf,
  LifeBuoy,
  Link,
  ListChecks,
  Luggage,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  Package,
  PartyPopper,
  Plane,
  RotateCcw,
  School,
  Scissors,
  Search,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Signpost,
  Sparkles,
  Split,
  Star,
  StickyNote,
  Stethoscope,
  Ticket,
  UserPlus,
  UtensilsCrossed,
  Video,
  Workflow,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FlowTemplateMeta, TemplateGoal, TemplateTrigger } from "@/lib/flows/types";

/** Shallow card data served by GET /api/flows/templates. */
export interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  /** Set by the server for categories the gallery has no label of its own for (the Instagram starters). */
  category_label?: string;
  trigger_type: string;
  node_count: number;
  /** The channel sections the template can be created in. */
  channels?: string[];
  /** Stage 5: gallery filters, Recommended row and detail view (the Instagram starters). */
  meta?: FlowTemplateMeta;
  business_value?: string;
  how_it_works?: string;
  /** Canvas notes the new flow starts with. */
  note_count?: number;
}

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  AtSign, BellRing, CalendarCheck, CalendarDays, ChefHat, Gift, GraduationCap, HelpCircle, Home, Landmark, Laptop, Leaf,
  LifeBuoy, Link, ListChecks, Luggage, Mail, MapPin, MessageCircle, MessageSquare, Package, PartyPopper, Plane, RotateCcw,
  School, Scissors, ShieldCheck, ShoppingBag, ShoppingCart, Signpost, Sparkles, Split, Star, Stethoscope, Ticket, UserPlus,
  UtensilsCrossed, Video,
};

// Mirrors FLOW_TEMPLATE_CATEGORIES in src/lib/flows/templates.ts (not
// imported: that module pulls the server message catalogue). Unknown
// categories sort after these.
const CATEGORY_ORDER = [
  "general", "journeys", "retail", "food", "health", "education", "real_estate",
  "travel", "finance", "beauty", "events", "services",
  "instagram_comments", "instagram_growth", "instagram_stories", "instagram_dms",
];

// Mirrors TEMPLATE_GOALS and TEMPLATE_TRIGGERS in src/lib/flows/types.ts.
const GOALS: readonly TemplateGoal[] = ["grow_followers", "engage_audience", "drive_traffic"];
const TRIGGERS: readonly TemplateTrigger[] = ["post_comment", "dm", "story_reply", "live_comment"];

/** The rail's filter: everything, one goal or one trigger. */
export type GalleryFilter = { kind: "all" } | { kind: "goal"; value: TemplateGoal } | { kind: "trigger"; value: TemplateTrigger };

/** Whether a template shows under a filter and a search text (name or description). */
export function matchesGalleryFilter(template: TemplateSummary, filter: GalleryFilter, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle && !template.name.toLowerCase().includes(needle) && !template.description.toLowerCase().includes(needle)) return false;
  if (filter.kind === "goal") return !!template.meta?.goals.includes(filter.value);
  if (filter.kind === "trigger") return template.meta?.trigger === filter.value;
  return true;
}

/**
 * The template chooser. Templates that carry gallery metadata (the Instagram
 * starters, Stage 5) get a filter rail (all, by goal, by trigger), a
 * Recommended row, Quick / Flow labels and a detail view before install;
 * other sections keep the category chips.
 */
export function TemplateGallery({
  templates,
  creating,
  onUse,
}: {
  templates: TemplateSummary[];
  creating: boolean;
  onUse: (slug: string) => void;
}) {
  return templates.some((template) => template.meta)
    ? <FilteredGallery templates={templates} creating={creating} onUse={onUse} />
    : <CategoryGallery templates={templates} creating={creating} onUse={onUse} />;
}

function FilteredGallery({ templates, creating, onUse }: { templates: TemplateSummary[]; creating: boolean; onUse: (slug: string) => void }) {
  const t = useTranslations("StarterFlows.instagram5");
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GalleryFilter>({ kind: "all" });
  const [detail, setDetail] = useState<TemplateSummary | null>(null);

  const visible = useMemo(() => templates.filter((template) => matchesGalleryFilter(template, filter, query)), [templates, filter, query]);
  const showRecommended = filter.kind === "all" && !query.trim();
  const recommended = showRecommended ? visible.filter((template) => template.meta?.recommended).slice(0, 3) : [];
  const rest = visible.filter((template) => !recommended.includes(template));

  if (detail) {
    return <TemplateDetail template={detail} creating={creating} onBack={() => setDetail(null)} onUse={() => onUse(detail.slug)} />;
  }

  const railButton = (key: string, label: string, active: boolean, next: GalleryFilter) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      onClick={() => setFilter(next)}
      className={cn(
        "w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  const same = (a: GalleryFilter, b: GalleryFilter) => a.kind === b.kind && (a.kind === "all" || (a as { value: string }).value === (b as { value: string }).value);

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav aria-label={t("galleryTitle")} className="shrink-0 space-y-3 md:w-48">
        {railButton("all", t("allTemplates"), filter.kind === "all", { kind: "all" })}
        <div>
          <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("byGoal")}</p>
          {GOALS.map((goal) => railButton(`goal:${goal}`, t(`goals.${goal}`), same(filter, { kind: "goal", value: goal }), { kind: "goal", value: goal }))}
        </div>
        <div>
          <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("byTrigger")}</p>
          {TRIGGERS.map((trigger) =>
            railButton(`trigger:${trigger}`, t(`triggers.${trigger}`), same(filter, { kind: "trigger", value: trigger }), { kind: "trigger", value: trigger }))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">{t("searchPlaceholder")}</label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-8" />
        </div>

        {recommended.length > 0 && (
          <section aria-label={t("recommended")} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("recommended")}</h3>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {recommended.map((template) => <TemplateCard key={template.slug} template={template} large onOpen={() => setDetail(template)} />)}
            </div>
          </section>
        )}

        {rest.length > 0 ? (
          <section aria-label={showRecommended ? t("more") : t("galleryTitle")} className="space-y-2">
            {recommended.length > 0 && <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("more")}</h3>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((template) => <TemplateCard key={template.slug} template={template} onOpen={() => setDetail(template)} />)}
            </div>
          </section>
        ) : recommended.length === 0 ? (
          <NoResults />
        ) : null}
      </div>
    </div>
  );
}

function NoResults() {
  const t = useTranslations("Flows.gallery");
  return (
    <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" role="status">
      {t("noResults")}
    </p>
  );
}

function KindLabel({ template }: { template: TemplateSummary }) {
  const t = useTranslations("StarterFlows.instagram5");
  if (!template.meta) return null;
  const Icon = template.meta.kind === "quick" ? Zap : Workflow;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Icon className="h-3 w-3" aria-hidden />
      {t(`kinds.${template.meta.kind}`)}
    </span>
  );
}

function TemplateCard({ template, large = false, onOpen }: { template: TemplateSummary; large?: boolean; onOpen: () => void }) {
  const t = useTranslations("StarterFlows.instagram5");
  const Icon = ICONS[template.icon] ?? FileText;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-template={template.slug}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        large && "bg-primary/5",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Icon className={cn("text-primary", large ? "h-6 w-6" : "h-5 w-5")} />
        {template.meta?.uses_ai && (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium text-primary">
            <Sparkles className="h-3 w-3" aria-hidden />
            {t("usesAi")}
          </span>
        )}
      </div>
      <span className="line-clamp-2 text-sm font-semibold text-popover-foreground">{template.name}</span>
      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{template.description}</span>
      <div className="mt-auto pt-1">
        <KindLabel template={template} />
      </div>
    </button>
  );
}

/** What a template does, before it is installed. */
function TemplateDetail({ template, creating, onBack, onUse }: {
  template: TemplateSummary; creating: boolean; onBack: () => void; onUse: () => void;
}) {
  const t = useTranslations("StarterFlows.instagram5");
  const Icon = ICONS[template.icon] ?? FileText;
  const meta = template.meta;
  return (
    <div className="space-y-4" data-template-detail={template.slug}>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        {t("back")}
      </Button>
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Icon className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
            <div>
              <h3 className="text-lg font-semibold text-popover-foreground">{template.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
            </div>
          </div>
          {template.business_value && (
            <section>
              <h4 className="text-sm font-semibold text-popover-foreground">{t("businessValue")}</h4>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{template.business_value}</p>
            </section>
          )}
          {template.how_it_works && (
            <section>
              <h4 className="text-sm font-semibold text-popover-foreground">{t("howItWorks")}</h4>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{template.how_it_works}</p>
            </section>
          )}
        </div>
        <aside className="space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          {meta && (
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li><KindLabel template={template} /> · {t(`levels.${meta.level}`)}</li>
              <li>{meta.trigger ? t(`triggers.${meta.trigger}`) : t("noTrigger")}</li>
              {meta.goals.length > 0 && <li>{meta.goals.map((goal) => t(`goals.${goal}`)).join(" · ")}</li>}
              {meta.uses_ai && <li className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3" aria-hidden />{t("usesAi")}</li>}
              {meta.needs_payments && <li className="inline-flex items-center gap-1"><CreditCard className="h-3 w-3" aria-hidden />{t("needsPayments")}</li>}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("steps", { count: template.node_count })}</p>
          {(template.note_count ?? 0) > 0 && (
            <p className="flex gap-1.5 text-xs text-muted-foreground">
              <StickyNote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {t("notes", { count: template.note_count ?? 0 })}
            </p>
          )}
          <Button className="w-full" disabled={creating} onClick={onUse}>
            {t("install")}
          </Button>
        </aside>
      </div>
    </div>
  );
}

function CategoryGallery({ templates, creating, onUse }: { templates: TemplateSummary[]; creating: boolean; onUse: (slug: string) => void }) {
  const t = useTranslations("Flows.gallery");
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => {
    const present = [...new Set(templates.map((template) => template.category))];
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
    return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [templates]);

  const visible = useMemo(
    () => templates.filter((template) => (category === null || template.category === category) && matchesGalleryFilter(template, { kind: "all" }, query)),
    [templates, query, category],
  );

  const label = (c: string) =>
    t.has(`categories.${c}`) ? t(`categories.${c}`) : templates.find((template) => template.category === c)?.category_label ?? c;
  const chip = (value: string | null, text: string) => (
    <button
      key={value ?? "__all"}
      type="button"
      aria-pressed={category === value}
      onClick={() => setCategory(value)}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        category === value
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          {t("searchLabel")}
        </label>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="pl-8"
        />
      </div>

      {categories.length > 1 && (
        <div role="group" aria-label={t("categoriesLabel")} className="flex flex-wrap gap-1.5">
          {chip(null, t("all"))}
          {categories.map((c) => chip(c, label(c)))}
        </div>
      )}

      {visible.length === 0 ? (
        <NoResults />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((template) => {
            const Icon = ICONS[template.icon] ?? FileText;
            return (
              <div
                key={template.slug}
                className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <Icon className="h-5 w-5 text-primary" />
                  <span className="text-[11px] text-muted-foreground">{label(template.category)}</span>
                </div>
                <span className="text-sm font-semibold text-popover-foreground">{template.name}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{template.description}</span>
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2">
                  <span className="text-[11px] text-muted-foreground">
                    {t("nodeCount", { count: template.node_count })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={creating}
                    onClick={() => onUse(template.slug)}
                    aria-label={`${t("useThis")}: ${template.name}`}
                  >
                    {t("useThis")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
