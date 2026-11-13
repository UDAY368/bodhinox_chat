'use client';

/**
 * The current section's pages as tabs above the page (Campaigns: Broadcasts · Templates · Forms ·
 * Ads). Nothing for a section with one page. Links, not buttons: every tab is its own URL.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { activeTab, buildSections, sectionFor } from './sections';

export function SectionTabs() {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const { data: channels } = useWorkspaceChannels();
  const section = sectionFor(pathname, buildSections(channels?.enabled));
  if (!section || section.tabs.length < 2) return null;
  const current = activeTab(pathname, section);
  const label = (tab: (typeof section.tabs)[number]) =>
    tab.channel ? `${t(tab.labelKey)} · ${t(`groups.${tab.channel}`)}` : t(tab.labelKey);
  return (
    <nav aria-label={t(section.labelKey)} data-testid="section-tabs" className="studio-section-tabs -mx-1 mb-5 overflow-x-auto px-1 [scrollbar-width:none]">
      <ul className="bg-muted inline-flex min-w-max gap-0.5 rounded-xl p-[3px]">
        {section.tabs.map((tab) => {
          const active = current?.href === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-8 items-center rounded-[9px] px-3.5 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-primary',
                  active
                    ? 'bg-card text-foreground shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-[#3a3a3e]'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label(tab)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
