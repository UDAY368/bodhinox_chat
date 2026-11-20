"use client";

/**
 * Unsaved-change tracking for the store settings sections. Each form or open draft in the visible section reports whether it
 * differs from what is saved; the screen asks before switching section and the browser warns before leaving the page.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Report = (id: string, dirty: boolean) => void;
const DirtyContext = createContext<Report | null>(null);

/** The registry the screen owns: whether anything is unsaved, and the report function DirtyScope hands down. */
export function useDirtyRegistry() {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>((id, dirty) => {
    setIds((all) => {
      if (all.has(id) === dirty) return all;
      const next = new Set(all);
      if (dirty) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const anyDirty = ids.size > 0;
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);
  return { anyDirty, report };
}

/** Wraps the visible section so its forms can report unsaved changes. */
export function DirtyScope({ report, children }: { report: Report; children: ReactNode }) {
  return <DirtyContext.Provider value={report}>{children}</DirtyContext.Provider>;
}

/** Report this form's unsaved state; cleared when the form unmounts. Outside the settings screen it does nothing. */
export function useReportDirty(id: string, dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report?.(id, dirty);
    return () => report?.(id, false);
  }, [report, id, dirty]);
}
