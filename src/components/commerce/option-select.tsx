"use client";

import type { ReactNode } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };

// Base UI's Select treats "" as "nothing picked"; the commerce forms use "" for "none/all" options.
const EMPTY = "__empty__";
const encode = (value: string) => (value === "" ? EMPTY : value);
const decode = (value: string) => (value === EMPTY ? "" : value);

/**
 * The shared Select from src/components/ui with a string value and an options list, so each commerce
 * form keeps its plain string state. The trigger always shows the option's label, never the raw value.
 */
export function OptionSelect({
  value,
  onValueChange,
  options,
  id,
  className,
  disabled,
  placeholder,
  size,
  invalid,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  size?: "sm" | "default";
  invalid?: boolean;
  "aria-label"?: string;
}) {
  const items = options.map((o) => ({ value: encode(o.value), label: o.label }));
  const known = options.some((o) => o.value === value);
  return (
    <Select
      items={items}
      value={known ? encode(value) : null}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(decode(next));
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} size={size} aria-label={ariaLabel} aria-invalid={invalid || undefined} className={cn("max-w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || EMPTY} value={encode(o.value)} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
