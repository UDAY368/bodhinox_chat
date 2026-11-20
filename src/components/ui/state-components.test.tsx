import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';
import { InlineError } from './inline-error';
import { PageLoading } from './page-loading';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );

describe('shared state components', () => {
  it('InlineError is an alert with the default message and a Retry only when retry is possible', () => {
    const withRetry = render(<InlineError onRetry={() => {}} />);
    expect(withRetry).toContain('role="alert"');
    expect(withRetry).toContain('UiPrimitives.loadFailed');
    expect(withRetry).toContain('UiPrimitives.retry');
    const noRetry = render(<InlineError message="Orders could not load." />);
    expect(noRetry).toContain('Orders could not load.');
    expect(noRetry).not.toContain('UiPrimitives.retry');
  });

  it('EmptyState renders title, body and action', () => {
    const html = render(<EmptyState title="No orders yet" body="Orders show here." action={<button>New order</button>} />);
    expect(html).toContain('No orders yet');
    expect(html).toContain('Orders show here.');
    expect(html).toContain('New order');
  });

  it('PageLoading renders the requested placeholder rows as a status', () => {
    const html = render(<PageLoading rows={3} />);
    expect(html).toContain('role="status"');
    expect(html.match(/animate-pulse rounded-full/g)).toHaveLength(3);
  });
});
