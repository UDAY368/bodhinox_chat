import { Suspense } from 'react';
import { FlowList } from '@/components/flows/flow-list';

// Automation: every channel's flows in one list (the ManyChat-style unified
// section). 'New automation' asks which channel a new one is for.
export default function AutomationPage() {
  return (
    <Suspense>
      <FlowList channel="all" />
    </Suspense>
  );
}
