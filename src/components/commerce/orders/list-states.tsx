"use client";

import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Loading rows shaped like the list (no whole-page spinner). */
export function RowPlaceholders({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" role="status" aria-label={label}>
      <div className="h-9 bg-muted" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-t border-border px-3.5 py-3">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          <div className="hidden h-5 w-20 animate-pulse rounded-full bg-muted sm:block" />
        </div>
      ))}
    </div>
  );
}

/** What happened, and a Retry button. */
export function ListError({ message, retry, onRetry }: { message: string; retry: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={onRetry}><RotateCw className="h-4 w-4" />{retry}</Button>
    </div>
  );
}
