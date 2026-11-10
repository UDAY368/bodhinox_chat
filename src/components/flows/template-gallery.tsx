"use client";

import { useId, useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import {
  AtSign,
  BellRing,
  CalendarCheck,
  CalendarDays,
  ChefHat,
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
  Star,
  Stethoscope,
  Ticket,
  UserPlus,
  UtensilsCrossed,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
}

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  AtSign, BellRing, CalendarCheck, CalendarDays, ChefHat, Gift, GraduationCap, HelpCircle, Home, Landmark, Laptop, Leaf,
  LifeBuoy, Link, ListChecks, Luggage, Mail, MapPin, MessageCircle, MessageSquare, Package, PartyPopper, Plane, RotateCcw,
  School, Scissors, ShieldCheck, ShoppingBag, ShoppingCart, Signpost, Sparkles, Star, Stethoscope, Ticket, UserPlus,
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

export function TemplateGallery({
  templates,
  creating,
  onUse,
}: {
  templates: TemplateSummary[];
  creating: boolean;
  onUse: (slug: string) => void;
}) {
  const t = useTranslations("Flows.gallery");
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => {
    const present = [...new Set(templates.map((template) => template.category))];
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
    return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [templates]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter(
      (template) =>
        (category === null || template.category === category) &&
        (!needle ||
          template.name.toLowerCase().includes(needle) ||
          template.description.toLowerCase().includes(needle)),
    );
  }, [templates, query, category]);

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
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" role="status">
          {t("noResults")}
        </p>
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
