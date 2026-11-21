"use client";

/**
 * A plain value-and-label menu built on the shared Select (src/components/ui/select.tsx), for
 * screens that used a native <select>. The trigger always shows the option's label, never the raw
 * value, and an option whose value is "" (an "Any" / "None" row) still works: Base UI treats ""
 * as no selection, so it is swapped for a private sentinel inside. Options with a `group` are
 * listed under that heading, after the ungrouped ones.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SelectOption = { value: string; label: React.ReactNode; disabled?: boolean; group?: string };

const EMPTY = "__option_select_empty__";
const toInner = (v: string) => (v === "" ? EMPTY : v);
const toOuter = (v: string) => (v === EMPTY ? "" : v);

function Item({ option }: { option: SelectOption }) {
  return (
    <SelectItem value={toInner(option.value)} disabled={option.disabled}>
      {option.label}
    </SelectItem>
  );
}

export function OptionSelect({
  value,
  onValueChange,
  options,
  id,
  placeholder,
  disabled,
  className,
  size,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
  "aria-label"?: string;
}) {
  const items = React.useMemo(() => options.map((o) => ({ value: toInner(o.value), label: o.label })), [options]);
  const known = options.some((o) => o.value === value);
  const groups = [...new Set(options.flatMap((o) => (o.group ? [o.group] : [])))];
  return (
    <Select
      items={items}
      value={known ? toInner(value) : null}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(toOuter(next));
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} size={size} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.filter((o) => !o.group).map((o) => (
          <Item key={o.value || EMPTY} option={o} />
        ))}
        {groups.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {options.filter((o) => o.group === group).map((o) => (
              <Item key={o.value || EMPTY} option={o} />
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
