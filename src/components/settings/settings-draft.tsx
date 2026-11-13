'use client';

/**
 * Draft editing for Settings sections (Profile, Workspace, Notifications).
 * A section edits a local draft and registers it here; the page shows one
 * sticky "Unsaved changes" bar with Discard and Save, marks the section in the
 * rail, and asks before leaving the section or the page with unsaved changes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DraftHandlers {
  save: () => Promise<unknown> | unknown;
  discard: () => void;
}
interface DraftFlags {
  dirty: boolean;
  saving: boolean;
}
interface DraftContextValue {
  flags: Record<string, DraftFlags>;
  setFlags: (section: string, flags: DraftFlags | null) => void;
  handlers: React.MutableRefObject<Record<string, DraftHandlers>>;
}

const DraftContext = createContext<DraftContextValue | null>(null);

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const [flags, setAll] = useState<Record<string, DraftFlags>>({});
  const handlers = useRef<Record<string, DraftHandlers>>({});
  const setFlags = useCallback((section: string, next: DraftFlags | null) => {
    setAll((all) => {
      const current = all[section];
      if (!next) {
        if (!current) return all;
        const rest = { ...all };
        delete rest[section];
        return rest;
      }
      if (current && current.dirty === next.dirty && current.saving === next.saving) return all;
      return { ...all, [section]: next };
    });
  }, []);
  const anyDirty = Object.values(flags).some((f) => f.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  const value = useMemo(() => ({ flags, setFlags, handlers }), [flags, setFlags]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** Register a section's draft: whether it differs from what is saved, and how to save or discard it. */
export function useSettingsDraft(section: string, draft: DraftFlags & DraftHandlers): void {
  const ctx = useContext(DraftContext);
  const { dirty, saving, save, discard } = draft;
  useEffect(() => {
    if (ctx) ctx.handlers.current[section] = { save, discard };
  });
  const setFlags = ctx?.setFlags;
  useEffect(() => {
    setFlags?.(section, { dirty, saving });
  }, [setFlags, section, dirty, saving]);
  useEffect(() => () => {
    setFlags?.(section, null);
    if (ctx) delete ctx.handlers.current[section];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setFlags, section]);
}

/** Sections with unsaved changes (for the rail dots). */
export function useUnsavedSections(): ReadonlySet<string> {
  const ctx = useContext(DraftContext);
  const flags = ctx?.flags;
  return useMemo(() => new Set(Object.entries(flags ?? {}).filter(([, f]) => f.dirty).map(([s]) => s)), [flags]);
}

/** The sticky Discard / Save bar for whichever section has a dirty draft. */
export function SettingsSaveBar({ className }: { className?: string }) {
  const t = useTranslations('SettingsRedesign.saveBar');
  const ctx = useContext(DraftContext);
  const entry = Object.entries(ctx?.flags ?? {}).find(([, f]) => f.dirty);
  if (!ctx || !entry) return null;
  const [section, { saving }] = entry;
  const handlers = ctx.handlers.current[section];
  return (
    <div
      role="region"
      aria-label={t('label')}
      className={cn(
        'sticky bottom-3 z-30 mt-8 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
        className,
      )}
    >
      <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{t('unsaved')}</span>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="ghost" disabled={saving} onClick={() => handlers?.discard()}>
          {t('discard')}
        </Button>
        <Button type="button" disabled={saving} onClick={() => void handlers?.save()}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
