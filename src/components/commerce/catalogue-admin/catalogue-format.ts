// Pure helpers for the catalogue screens: money in integer minor units and
// tax rates in basis points, parsed from the decimal text staff type.

import { formatMoney, minorToDecimalString, MoneyError, parseMoney } from "@/lib/commerce/money";

/** "18" -> 1800, "12.5" -> 1250, "" -> null; anything else (or above 100%) -> undefined (invalid). */
export function percentToBps(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10000 ? bps : undefined;
}

/** 1250 -> "12.5", null -> "". */
export function bpsToPercent(bps: number | null): string {
  if (bps === null) return "";
  const whole = Math.floor(bps / 100), frac = bps % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}` : String(whole);
}

/** Decimal text to minor units in the store currency; "" -> null; invalid -> undefined. */
export function moneyInput(text: string, currency: string | null): number | null | undefined {
  if (!text.trim()) return null;
  if (!currency) return undefined;
  try {
    return parseMoney(text, currency);
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

/** Minor units back to the decimal text an input shows (no grouping, no symbol). */
export function moneyText(minor: number | null, currency: string | null): string {
  if (minor === null || !currency) return "";
  return minorToDecimalString(minor, currency);
}

/** "₹499.00", or the range "₹199.00 – ₹499.00"; null without a price or currency. */
export function priceRange(min: number | null, max: number | null, currency: string | null, locale: string): string | null {
  if (min === null || !currency) return null;
  const low = formatMoney(min, currency, locale);
  return max !== null && max !== min ? `${low} – ${formatMoney(max, currency, locale)}` : low;
}

/** "Size: M, Colour: Blue" -> { Size: "M", Colour: "Blue" }; null when malformed or more than four pairs. */
export function parseOptionsText(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 4) return null;
  for (const part of parts) {
    const i = part.indexOf(":");
    if (i < 1) return null;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (!k || !v || k.length > 40 || v.length > 80 || Object.hasOwn(out, k)) return null;
    out[k] = v;
  }
  return out;
}
