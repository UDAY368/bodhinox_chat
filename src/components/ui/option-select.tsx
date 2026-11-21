"use client";

/**
 * A plain value-and-label menu on the shared Select, for screens that keep a string in state.
 * The trigger always shows the option's label (via `items`), never the raw value. An option whose
 * value is "" (an "Any" / "None" row) still works: Base UI treats "" as no selection, so it is
 * swapped for a private sentinel inside. Options with a `group` are listed under that heading,
 * after the ungrouped ones. The trigger fills its container unless `fit` is set.
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

export const OPTION_SELECT_EMPTY = "__option_select_empty__";
const toInner = (v: string) => (v === "" ? OPTION_SELECT_EMPTY : v);
const toOuter = (v: string) => (v === OPTION_SELECT_EMPTY ? "" : v);

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
  invalid,
  fit,
  className,
  size,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Size the trigger to its label instead of filling the container. */
  fit?: boolean;
  className?: string;
  size?: "sm" | "default";
  "aria-label"?: string;
  "aria-labelledby"?: string;
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
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={invalid || undefined}
        size={size}
        className={cn(fit ? "max-w-full" : "w-full", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.filter((o) => !o.group).map((o) => (
          <Item key={o.value || OPTION_SELECT_EMPTY} option={o} />
        ))}
        {groups.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {options.filter((o) => o.group === group).map((o) => (
              <Item key={o.value || OPTION_SELECT_EMPTY} option={o} />
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
