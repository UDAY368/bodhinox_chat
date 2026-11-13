'use client';

import type { ReactNode } from 'react';

import { AnalyticsHeader } from '@/components/analytics/insights/analytics-header';
import { AnalyticsFiltersProvider } from '@/components/analytics/insights/context';

/**
 * Analytics, Conversations, Team and Campaigns share one header and one set of
 * filters (range, channel, number); the layout keeps them while moving between
 * the tabs.
 */
export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  return (
    <AnalyticsFiltersProvider>
      <div className="mx-auto w-full max-w-[1440px] min-w-0 space-y-4">
        <AnalyticsHeader />
        {children}
      </div>
    </AnalyticsFiltersProvider>
  );
}
