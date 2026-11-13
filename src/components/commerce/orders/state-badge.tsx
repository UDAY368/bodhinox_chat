"use client";

import type { ReactNode } from "react";
import type { Tone } from "./order-state";

const TONES: Record<Tone, string> = {
  ok: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/14 text-amber-700 dark:text-amber-400",
  bad: "bg-destructive/10 text-destructive",
  accent: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
};

/** A small soft-coloured state label (payment, fulfilment, stock). */
export function StateBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}
