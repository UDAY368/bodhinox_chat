"use client";

/**
 * Commerce → Store settings, split into sections (Apple Settings style): a grouped side list on the left on desktop, and on
 * phones a list that drills into one section with a back button. The selected section is in the URL (?section=), so links and
 * Back work. Only the open section is mounted, so each section loads its own data when it is opened; the store's core settings
 * row is one cheap call loaded up front (it holds the currency every money field needs). Each section saves with one Save
 * (switches in lists apply at once), and leaving a section with unsaved changes asks first. Admins edit; agents read (the APIs
 * and RLS enforce the same rule).
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BadgePercent, Bell, ChevronLeft, ChevronRight, CreditCard, Megaphone, Receipt, SlidersHorizontal, Store, Truck, Users, type LucideIcon,
} from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BuyerSettingsPanel } from "./buyer-settings-panel";
import { CoreSettingsForm, type CorePart } from "./core-settings-form";
import { DeliveryOptionsCard } from "./delivery-options";
import { AutoDiscounts, Coupons } from "./discounts";
import { MarketingPanel } from "./marketing-panel";
import { NoticeTemplates } from "./notice-templates";
import { PriceRulesPanel } from "./price-rules-panel";
import { DirtyScope, useDirtyRegistry } from "./section-dirty";
import { storeApi, type StoreSettings } from "./settings-api";
import { ShippingRates } from "./shipping-rates";
import {
  DEFAULT_STORE_SECTION, STORE_SECTION_GROUPS, resolveStoreSection, storeSectionHref, type StoreSection,
} from "./store-settings-sections";
import { PageHeader } from "@/components/ui/page-header";

const ICONS: Record<StoreSection, LucideIcon> = {
  general: Store, taxes: Receipt, checkout: CreditCard, shipping: Truck, discounts: BadgePercent,
  buyers: Users, notifications: Bell, marketing: Megaphone, advanced: SlidersHorizontal,
};

export function StoreSettingsPanel() {
  // useSearchParams needs a Suspense boundary so the page can still prerender around it.
  return (
    <Suspense fallback={<SectionSkeleton />}>
      <StoreSettingsLoader />
    </Suspense>
  );
}

function StoreSettingsLoader() {
  const canEdit = useCan("edit-settings");
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  const load = useCallback(() => {
    storeApi.settings().then((r) => (r.ok ? setSettings(r.value) : setLoadError(true))).catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);
  return (
    <StoreSettingsScreen settings={settings} loadError={loadError} canEdit={canEdit} savedVersion={savedVersion}
      onRetry={() => { setLoadError(false); load(); }}
      onSaved={(s) => { setSettings(s); setSavedVersion((n) => n + 1); }} />
  );
}

export function StoreSettingsScreen({ settings, loadError, canEdit, savedVersion, onRetry, onSaved }: {
  settings: StoreSettings | null; loadError: boolean; canEdit: boolean; savedVersion: number;
  onRetry: () => void; onSaved: (s: StoreSettings) => void;
}) {
  const t = useTranslations("Commerce.settings");
  const ts = useTranslations("Commerce.settings.sections");
  const params = useSearchParams();
  const pathname = usePathname();
  const selected = resolveStoreSection(params.get("section"));
  const shown = selected ?? DEFAULT_STORE_SECTION;
  const { anyDirty, report } = useDirtyRegistry();
  const [pending, setPending] = useState<{ to: StoreSection | null } | null>(null);

  // Native history keeps the switch on the client (no server round trip) and still updates useSearchParams.
  const navigate = (to: StoreSection | null) => {
    window.history.pushState(null, "", storeSectionHref(pathname, params.toString(), to));
    window.scrollTo({ top: 0 });
  };
  const go = (to: StoreSection | null) => {
    if (to === selected) return;
    // Only a change of the section on screen drops its edits (phones: Back to the list keeps the default section mounted).
    if (anyDirty && (to ?? DEFAULT_STORE_SECTION) !== shown) return setPending({ to });
    navigate(to);
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader className={cn("mb-0", selected && "hidden md:flex")} title={t("title")} subtitle={t("subtitle")} />

      <div className="mt-5 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:items-start md:gap-8">
        <nav aria-label={ts("navLabel")} className={cn("space-y-5 md:sticky md:top-4 md:space-y-4", selected && "hidden md:block")}>
          {STORE_SECTION_GROUPS.map((group) => (
            <div key={group.id}>
              <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts(`groups.${group.id}`)}</p>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card md:divide-y-0 md:rounded-none md:border-0 md:bg-transparent">
                {group.sections.map((id) => {
                  const Icon = ICONS[id];
                  const active = id === shown;
                  return (
                    <li key={id}>
                      <button type="button" onClick={() => go(id)} aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-muted/60 md:min-h-9 md:rounded-lg",
                          active ? "md:bg-muted md:font-medium md:text-foreground" : "md:text-muted-foreground",
                        )}>
                        <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{ts(`${id}.title`)}</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <section aria-labelledby="store-section-title" className={cn("min-w-0 space-y-5", !selected && "hidden md:block")}>
          <div>
            <button type="button" onClick={() => go(null)} className="-ml-1 flex min-h-11 items-center gap-1 text-sm text-primary md:hidden">
              <ChevronLeft className="size-4" aria-hidden /> {t("title")}
            </button>
            <h2 id="store-section-title" className="text-[22px] font-bold tracking-tight md:text-lg md:font-semibold">{ts(`${shown}.title`)}</h2>
            <p className="text-sm text-muted-foreground">{ts(`${shown}.help`)}</p>
          </div>
          {loadError ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{t("loadError")}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>{ts("retry")}</Button>
            </div>
          ) : !settings ? (
            <SectionSkeleton />
          ) : (
            <DirtyScope report={report}>
              <div key={shown} className="space-y-5">
                <SectionBody section={shown} settings={settings} canEdit={canEdit} savedVersion={savedVersion} onSaved={onSaved}
                  onOpenGeneral={() => go("general")} />
              </div>
            </DirtyScope>
          )}
        </section>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{ts("leave.title")}</DialogTitle>
            <DialogDescription>{ts("leave.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>{ts("leave.stay")}</Button>
            <Button variant="destructive" onClick={() => { const to = pending?.to ?? null; setPending(null); navigate(to); }}>
              {ts("leave.discard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionBody({ section, settings, canEdit, savedVersion, onSaved, onOpenGeneral }: {
  section: StoreSection; settings: StoreSettings; canEdit: boolean; savedVersion: number;
  onSaved: (s: StoreSettings) => void; onOpenGeneral: () => void;
}) {
  const ts = useTranslations("Commerce.settings.sections");
  // Keyed by the save count, so after a save the form starts again from the saved row.
  const core = (part: CorePart) => <CoreSettingsForm key={`${part}-${savedVersion}`} part={part} initial={settings} canEdit={canEdit} onSaved={onSaved} />;
  if (section === "general") return core("general");
  const currency = settings.configured ? settings.currency : null;
  if (!currency) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border bg-card p-5">
        <Store className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm">{ts("needsSetup")}</p>
        <Button size="sm" onClick={onOpenGeneral}>{ts("openGeneral")}</Button>
      </div>
    );
  }
  switch (section) {
    case "taxes": return core("taxes");
    case "checkout": return core("checkout");
    case "shipping":
      return (
        <>
          <ShippingRates currency={currency} canEdit={canEdit} />
          <DeliveryOptionsCard currency={currency} canEdit={canEdit} />
        </>
      );
    case "discounts":
      return (
        <>
          <Coupons currency={currency} canEdit={canEdit} />
          <AutoDiscounts currency={currency} canEdit={canEdit} />
          <PriceRulesPanel currency={currency} canEdit={canEdit} />
        </>
      );
    case "buyers": return <BuyerSettingsPanel canEdit={canEdit} />;
    case "notifications":
      return (
        <>
          {core("notifications")}
          <NoticeTemplates canEdit={canEdit} />
        </>
      );
    case "marketing": return <MarketingPanel canEdit={canEdit} currency={currency} />;
    case "advanced": return core("advanced");
  }
}

/** A placeholder shaped like a section's form while it loads. */
function SectionSkeleton() {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-6" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
        </div>
      ))}
      <div className="h-9 w-20 animate-pulse rounded-full bg-muted" />
    </div>
  );
}
