'use client';

/**
 * The analytics tabs' shared filters (range, channel, WhatsApp number) and the
 * range the last report resolved, kept by the /analytics layout so moving
 * between Overview, Conversations, Team and Campaigns keeps them.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { rangeParams, type RangeValue } from '@/components/analytics/range-picker';
import { reportQuery } from '@/components/analytics/shared';
import type { ChannelFilterValue } from '@/components/analytics/channel-filter';

export interface ShownRange {
  range: { preset?: string; startDay: string; endDay: string; days: number; timezone?: string };
  previousRange?: { startDay: string; endDay: string } | null;
}

interface AnalyticsFilters {
  range: RangeValue;
  setRange: (value: RangeValue) => void;
  channel: ChannelFilterValue;
  setChannel: (value: ChannelFilterValue) => void;
  number: string;
  setNumber: (value: string) => void;
  numbers: { id: string; label: string | null; isDefault: boolean }[];
  setNumbers: (value: { id: string; label: string | null; isDefault: boolean }[]) => void;
  shown: ShownRange | null;
  setShown: (value: ShownRange | null) => void;
  /** The range only, for reports that take no filters. */
  rangeQuery: string;
  /** Range, channel and number. */
  query: string;
  /** Range and channel (no number): campaign and automation figures. */
  channelQuery: string;
}

const Context = createContext<AnalyticsFilters | null>(null);

export function AnalyticsFiltersProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [channel, setChannel] = useState<ChannelFilterValue>('');
  const [number, setNumber] = useState('');
  const [numbers, setNumbers] = useState<AnalyticsFilters['numbers']>([]);
  const [shown, setShown] = useState<ShownRange | null>(null);
  const value = useMemo<AnalyticsFilters>(() => {
    const params = rangeParams(range);
    const whatsappNumber = channel === 'instagram' ? '' : number;
    return {
      range, setRange, channel, setChannel, number, setNumber, numbers, setNumbers, shown, setShown,
      rangeQuery: reportQuery(params),
      query: reportQuery({ ...params, channel, number: whatsappNumber }),
      channelQuery: reportQuery({ ...params, channel }),
    };
  }, [range, channel, number, numbers, shown]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAnalyticsFilters(): AnalyticsFilters {
  const value = useContext(Context);
  if (!value) throw new Error('useAnalyticsFilters needs AnalyticsFiltersProvider');
  return value;
}
