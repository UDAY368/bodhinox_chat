// Public marketing pages (Phase 14): pricing, help, privacy and terms. The landing
// page at `/` (src/app/page.tsx) uses the same shell.

import type { ReactNode } from 'react';

import { MarketingShell } from './shell';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <MarketingShell>{children}</MarketingShell>;
}
