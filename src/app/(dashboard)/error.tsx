'use client';

// Dashboard error boundary: sits inside the dashboard layout, so a render error in one screen
// keeps the sidebar and header and offers a retry of that screen only.

import { ErrorState } from '@/components/error-state';

export default function DashboardError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorState error={error} retry={retry} />;
}
