"use client";

/**
 * A plain value-and-label menu built on the shared Select (src/components/ui/select.tsx), for the
 * automation, flow, form and campaign screens that used a native <select>. The trigger always shows
 * the option's label, never the raw value, and an option whose value is "" (an "Any" / "None" row)
 * still works: Base UI treats "" as no selection, so it is swapped for a private sentinel inside.
 * Same API as src/components/commerce/option-select.tsx and src/components/contacts/option-select.tsx.
 */

import * as React from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: React.ReactNode; disabled?: boolean };

const EMPTY = "__option_select_empty__";
const toInner = (v: string) => (v === "" ? EMPTY : v);
const toOuter = (v: string) => (v === EMPTY ? "" : v);

export function OptionSelect({
  value,
  onValueChange,
  options,
  id,
  disabled,
  className,
  placeholder,
  size,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  size?: "sm" | "default";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const items = React.useMemo(() => options.map((o) => ({ value: toInner(o.value), label: o.label })), [options]);
  const known = options.some((o) => o.value === value);
  return (
    <Select
      items={items}
      value={known ? toInner(value) : null}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(toOuter(next));
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} size={size} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || EMPTY} value={toInner(o.value)} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
