'use client';

import { useMessages } from 'next-intl';
import type { ReactNode } from 'react';
import { registerBrowserMessages } from './browser-messages';

/**
 * Hands the provider's catalogue to code outside React (see browser-messages.ts). It registers
 * while rendering, before its children render, so a child's first translate call already sees it.
 */
export function BrowserMessages({ children }: { children: ReactNode }) {
  registerBrowserMessages(useMessages() as Record<string, unknown>);
  return children;
}
