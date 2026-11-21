"use client";

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
