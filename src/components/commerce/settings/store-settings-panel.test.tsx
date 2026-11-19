import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoreSettings } from "@/lib/commerce/store-settings";

const h = vi.hoisted(() => ({ fetch: vi.fn(), search: "" }));
vi.mock("@/lib/auth/client", () => ({ authFetch: h.fetch }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountRole: "admin", profileLoading: false }) }));
vi.mock("@/components/flows/forms/use-pickers", () => ({ useApprovedTemplates: () => [] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(h.search),
  usePathname: () => "/commerce/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { StoreSettingsScreen } from "./store-settings-panel";
import { STORE_SECTIONS, resolveStoreSection, storeSectionHref, type StoreSection } from "./store-settings-sections";

const settings: StoreSettings = {
  configured: true, currency: "INR", prices_include_tax: true, default_tax_rate_bps: 1800, reservation_minutes: 30, checkout_enabled: true,
  low_stock_default: 5, legal_name: "Shop Pvt Ltd", gstin: null, address: null, state_code: "MH", document_prefix: "INV",
  storefront_title: "Shop", return_window_days: 7, checkout_template_name: null, checkout_template_language: null, cod_enabled: true,
  cod_fee_minor: 0, abandoned_cart_delay_minutes: 60, cod_confirm_enabled: false, review_requests_enabled: false, currency_locked: false,
  online_payment_ready: true,
} as StoreSettings;

function render(search: string, s: StoreSettings | null = settings) {
  h.search = search;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <StoreSettingsScreen settings={s} loadError={false} canEdit savedVersion={0} onRetry={() => {}} onSaved={() => {}} />
    </NextIntlClientProvider>,
  );
}

/** Something only that section renders (a field id or a card title), so the test proves the right body is mounted. */
const marker: Record<StoreSection, string> = {
  general: 'id="ss-currency"',
  taxes: 'id="ss-gstin"',
  checkout: 'id="ss-cod-fee"',
  shipping: "Commerce.settings.shippingTitle",
  discounts: "Commerce.settings.couponsTitle",
  buyers: "",
  notifications: 'id="ss-abandoned"',
  marketing: "",
  advanced: 'id="ss-hold"',
};

describe("store settings sections", () => {
  beforeEach(() => h.fetch.mockReset());

  it("reads the section from the URL and ignores unknown values", () => {
    expect(resolveStoreSection("shipping")).toBe("shipping");
    expect(resolveStoreSection("nope")).toBeNull();
    expect(resolveStoreSection(null)).toBeNull();
    expect(storeSectionHref("/commerce/settings", "x=1", "taxes")).toBe("/commerce/settings?x=1&section=taxes");
    expect(storeSectionHref("/commerce/settings", "section=taxes", null)).toBe("/commerce/settings");
  });

  it.each(STORE_SECTIONS)("renders the %s section with its own title and fields when the URL selects it", (section) => {
    const html = render(`section=${section}`);
    expect(html).toContain(`Commerce.settings.sections.${section}.title`);
    expect(html).toContain('aria-current="page"');
    // The selected row in the side list is the one marked current.
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>(?:(?!</button>).)*Commerce\\.settings\\.sections\\.${section}\\.title`));
    if (marker[section]) expect(html).toContain(marker[section]);
    for (const other of STORE_SECTIONS) {
      if (other !== section && marker[other]) expect(html).not.toContain(marker[other]);
    }
  });

  it("puts every core setting in exactly one section", () => {
    const ids = ["ss-title", "ss-currency", "ss-tax", "ss-legal", "ss-gstin", "ss-state", "ss-prefix", "ss-address", "ss-cod-fee", "ss-return",
      "ss-template", "ss-hold", "ss-low", "ss-abandoned"];
    const seen = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const section of STORE_SECTIONS) {
      const html = render(`section=${section}`);
      for (const id of ids) if (html.includes(`id="${id}"`)) seen[id] += 1;
    }
    expect(seen).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
  });

  it("shows General on desktop and the list alone on phones when no section is chosen", () => {
    const html = render("");
    expect(html).toContain('id="ss-currency"');
    // The section body is hidden below md, the list is not.
    expect(html).toMatch(/<section[^>]*class="[^"]*hidden md:block/);
    expect(html).not.toMatch(/<nav[^>]*class="[^"]*hidden md:block/);
  });

  it("hides the list on phones once a section is open and offers Back", () => {
    const html = render("section=taxes");
    expect(html).toMatch(/<nav[^>]*class="[^"]*hidden md:block/);
    expect(html).toContain("md:hidden");
  });

  it("asks for the currency before any other section of an unconfigured store", () => {
    const html = render("section=shipping", { ...settings, configured: false, currency: null });
    expect(html).toContain("Commerce.settings.sections.needsSetup");
    expect(html).not.toContain("Commerce.settings.shippingTitle");
  });

  it("shows a placeholder, not a section, while settings load", () => {
    const html = render("section=taxes", null);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain('id="ss-gstin"');
  });
});
