import type { ReactNode } from 'react';

import { Markdown, readContent } from './markdown';

/**
 * A legal document from content/legal/<name>.md, with optional content above it.
 * `note` is the English-only notice for other locales (see english-only.ts).
 */
export function LegalPage({ name, note, children }: { name: 'privacy' | 'terms' | 'data-deletion'; note?: string | null; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      {note && <p role="note" data-testid="english-only" className="mb-6 text-sm text-muted-foreground">{note}</p>}
      {children}
      <Markdown source={readContent('legal', name)} />
    </div>
  );
}
