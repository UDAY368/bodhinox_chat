'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SectionMeta,
  type SettingsSection,
} from './settings-sections';

/**
 * A rail entry the page adds on its own (e.g. the admin-only AI assistant
 * section), shown after the group's built-in sections with a ready label.
 */
export interface RailExtraItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: SectionMeta['group'];
}

// Width at/above which the rail is a vertical column (already in view, so
// no auto-scroll needed). Mirrors the Tailwind `lg:` breakpoint that
// drives the row→column switch in the markup below — keep the two in sync.
const RAIL_DESKTOP_MIN_PX = 1024;

// One look for every rail entry: a quiet row on desktop, a soft pill in the
// horizontal scroller; the active one sits on a muted fill with an accent icon.
const linkClass = (isActive: boolean) =>
  cn(
    'flex min-h-[34px] shrink-0 items-center gap-2.5 rounded-full border px-3 py-1.5 text-left text-sm font-medium whitespace-nowrap transition-colors duration-150',
    'lg:w-full lg:rounded-lg lg:border-0 lg:px-2.5',
    isActive
      ? 'border-transparent bg-muted text-foreground'
      : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  );

const iconClass = (isActive: boolean) =>
  cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground');

/**
 * The settings left rail — grouped, vertical on desktop and a
 * horizontal scroller on narrow screens (mirrors the mockup's ≤920px
 * behaviour). The active item auto-scrolls into view when the rail is
 * horizontal so a deep-linked section is never off-screen.
 */
export function SettingsRail({
  active,
  onSelect,
  hints,
  extraItems = [],
  onSelectExtra,
  hidden,
}: {
  active: SettingsSection | string;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
  extraItems?: readonly RailExtraItem[];
  onSelectExtra?: (id: string) => void;
  /** Sections not shown, e.g. the tabs of a channel the workspace does not use (hiddenSections). */
  hidden?: ReadonlySet<SettingsSection>;
}) {
  const t = useTranslations('Settings');
  const tChannels = useTranslations('Channels.settings');
  const activeRef = useRef<HTMLButtonElement>(null);

  // When horizontal (mobile), keep the active chip in view. On desktop
  // the rail is a static column, so skip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  return (
    <nav
      aria-label={t('sectionsNav')}
      className={cn(
        'flex gap-1 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'border-b border-border',
        'lg:max-h-[calc(100dvh-8rem)] lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:pb-4',
      )}
    >
      {RAIL_GROUPS.map(({ label, group }) => {
        const items = SETTINGS_SECTIONS.filter(
          (s) => SECTION_META[s].group === group && !hidden?.has(s),
        );
        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            {label ? (
              <div className="hidden px-2.5 pt-3.5 pb-1 text-xs font-semibold text-muted-foreground/80 lg:block">
                {group === 'account' ? t('members.you') : t(`groups.${group === 'billing' ? 'account' : group}`)}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <button
                  key={s}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? 'page' : undefined}
                  className={linkClass(isActive)}
                >
                  <Icon className={iconClass(isActive)} />
                  <span className="flex-1">{s === 'channels' ? tChannels('title') : t(`sections.${s}`)}</span>
                  {hints?.[s] != null ? (
                    <span
                      className={cn(
                        'hidden items-center gap-1.5 text-xs lg:inline-flex',
                        'text-muted-foreground',
                      )}
                    >
                      {hints[s]}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {extraItems
              .filter((item) => item.group === group)
              .map((item) => {
                const Icon = item.icon;
                const isActive = item.id === active;
                return (
                  <button
                    key={item.id}
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onClick={() => onSelectExtra?.(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={linkClass(isActive)}
                  >
                    <Icon className={iconClass(isActive)} />
                    <span className="flex-1">{item.label}</span>
                  </button>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}
