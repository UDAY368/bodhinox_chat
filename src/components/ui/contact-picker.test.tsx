import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import en from '../../../messages/en.json';
import { ContactPicker, contactLabel, contactSearchUrl } from './contact-picker';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);

describe('ContactPicker', () => {
  it('builds the search URL with only the parts it needs', () => {
    expect(contactSearchUrl('  ')).toBe('/api/contacts/search');
    expect(contactSearchUrl('+91 98765', 'whatsapp', 'abc')).toBe('/api/contacts/search?q=%2B91+98765&channel=whatsapp&cursor=abc');
  });

  it('labels a picked contact by name, then number', () => {
    expect(contactLabel({ id: '1', name: 'Asha', phone: '1' }, 'No name')).toBe('Asha');
    expect(contactLabel({ id: '1', name: null, phone: '+91 98' }, 'No name')).toBe('+91 98');
    expect(contactLabel({ id: '1', name: null, phone: null }, 'No name')).toBe('No name');
  });

  it('renders a closed combobox showing the picked contact with a clear button', () => {
    const html = render(<ContactPicker id="who" value={{ id: '1', name: 'Asha Rao', phone: null }} onChange={() => {}} />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="Asha Rao"');
    expect(html).toContain('aria-label="Clear contact"');
    expect(html).not.toContain('role="listbox"');
  });

  it('has no clear button when empty or disabled', () => {
    expect(render(<ContactPicker value={null} onChange={() => {}} />)).not.toContain('Clear contact');
    expect(render(<ContactPicker value={{ id: '1', name: 'A', phone: null }} disabled onChange={() => {}} />)).not.toContain('Clear contact');
  });
});
