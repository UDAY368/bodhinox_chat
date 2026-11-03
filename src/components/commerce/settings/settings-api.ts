"use client";

// Browser-side calls to the store settings, shipping rate, coupon and
// storefront link APIs. authFetch adds the session and the mutation-origin headers.

import { authFetch } from "@/lib/auth/client";
import type { CouponView } from "@/lib/commerce/coupons";
import type { ShippingRateView, StoreSettings, StoreSettingsInput } from "@/lib/commerce/store-settings";

export type { CouponView, ShippingRateView, StoreSettings, StoreSettingsInput };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; code?: string; error?: string; field?: string };

async function result<T>(res: Response, key: string): Promise<ApiResult<T>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && json[key] !== undefined) return { ok: true, value: json[key] as T };
  return {
    ok: false, status: res.status,
    code: typeof json.code === "string" ? json.code : undefined,
    error: typeof json.error === "string" ? json.error : undefined,
    field: typeof json.field === "string" ? json.field : undefined,
  };
}

const send = (url: string, method: string, body?: unknown) => authFetch(url, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

export const storeApi = {
  settings: async () => result<StoreSettings>(await authFetch("/api/commerce/settings", { cache: "no-store" }), "settings"),
  saveSettings: async (input: StoreSettingsInput) => result<StoreSettings>(await send("/api/commerce/settings", "PUT", input), "settings"),
  rates: async () => result<ShippingRateView[]>(await authFetch("/api/commerce/shipping-rates", { cache: "no-store" }), "rates"),
  createRate: async (input: Omit<ShippingRateView, "id">) => result<ShippingRateView>(await send("/api/commerce/shipping-rates", "POST", input), "rate"),
  updateRate: async (id: string, input: Omit<ShippingRateView, "id">) =>
    result<ShippingRateView>(await send(`/api/commerce/shipping-rates/${encodeURIComponent(id)}`, "PATCH", input), "rate"),
  deleteRate: async (id: string) => result<true>(await send(`/api/commerce/shipping-rates/${encodeURIComponent(id)}`, "DELETE"), "ok"),
  coupons: async () => result<CouponView[]>(await authFetch("/api/commerce/coupons", { cache: "no-store" }), "coupons"),
  createCoupon: async (input: Record<string, unknown>) => result<CouponView>(await send("/api/commerce/coupons", "POST", input), "coupon"),
  updateCoupon: async (id: string, input: Record<string, unknown>) =>
    result<CouponView>(await send(`/api/commerce/coupons/${encodeURIComponent(id)}`, "PATCH", input), "coupon"),
  sendLink: async (input: { conversation_id: string; purpose: "shop" | "status"; ttl_hours: number; message: string | null; client_request_id: string }) =>
    result<{ sessionId: string; expiresAt: string }>(await send("/api/commerce/storefront-links", "POST", input), "session"),
};
