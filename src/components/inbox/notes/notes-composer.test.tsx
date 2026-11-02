import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it } from 'vitest';
import { NotesComposer } from './notes-composer';

const messages = {
  Inbox: {
    notes: {
      placeholder: 'Add a note, @ to mention', composerLabel: 'Internal note', mentionList: 'Members',
      tooLong: 'Up to {max} characters', hint: 'Only your team sees notes', cancel: 'Cancel', add: 'Add note',
    },
  },
};
const render = (props: Partial<React.ComponentProps<typeof NotesComposer>> = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" messages={messages}>
    <NotesComposer members={[{ id: 'a', name: 'Asha' }]} onSubmit={async () => true} {...props} />
  </NextIntlClientProvider>,
);

it('renders an accessible mention combobox with saving disabled until there is text', () => {
  const html = render();
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-autocomplete="list"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add note<\/button>/);
  expect(html).not.toContain('role="listbox"');
});

it('pre-fills an edit with its text and offers cancel', () => {
  const html = render({ initialBody: 'Call @Asha', initialMentions: ['a'], onCancel: () => {}, submitLabel: 'Save' });
  expect(html).toContain('Call @Asha');
  expect(html).toContain('Cancel');
  expect(html).toMatch(/<button[^>]*>Save<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  // Ending in "@Asha" does not pop the member list open on edit.
  expect(html).not.toContain('role="listbox"');
});
