'use client';

// Root error boundary: a render error anywhere below the root layout (auth pages, marketing,
// public booking and shop pages) shows a translated message with a retry instead of the bare
// framework text. Dashboard screens have their own boundary that keeps the sidebar.

import { ErrorState } from '@/components/error-state';

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorState error={error} retry={retry} />;
}
