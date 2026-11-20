"use client";

// Small helpers shared by the store settings sections: percent <-> basis points, money text <-> minor units,
// the labelled field wrapper and the API error text.

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import type { ApiResult } from "./settings-api";

/** "18" or "12.5" percent -> basis points; null for empty; NaN when invalid. */
export function percentToBps(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return NaN;
  const [whole, fraction = ""] = v.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= 10000 ? bps : NaN;
}
export const bpsToPercent = (bps: number | null) => (bps === null ? "" : (bps / 100).toString());

export const minorText = (minor: number | null, currency: string) => (minor === null ? "" : minorToDecimalString(minor, currency));

/** A decimal money string -> minor units; null for empty; NaN when invalid. */
export function toMinor(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  try {
    return parseMoney(value, currency);
  } catch {
    return NaN;
  }
}

export function useErrorText() {
  const te = useTranslations("Commerce.settings.errors");
  return (r: ApiResult<unknown>) => (r.ok ? "" : r.code ? te(r.code as never) : r.error ?? te("invalid"));
}

export function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
