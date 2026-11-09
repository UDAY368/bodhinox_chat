import type { ReactNode } from 'react';

import { Markdown, readContent } from './markdown';

/** A legal document from content/legal/<name>.md, with optional content above it. */
export function LegalPage({ name, children }: { name: 'privacy' | 'terms' | 'data-deletion'; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      {children}
      <Markdown source={readContent('legal', name)} />
    </div>
  );
}
