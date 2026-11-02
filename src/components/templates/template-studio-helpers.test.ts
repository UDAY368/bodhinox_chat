import { describe, expect, it } from 'vitest';
import {
  filterLanguages,
  filterLibrary,
  libraryDraft,
  previewSegments,
  type LibraryEntry,
} from './template-studio-helpers';

describe('previewSegments', () => {
  it('splits text and variables, using non-blank samples', () => {
    expect(previewSegments('Hi {{1}}, order {{2}} ready', ['Ana', '  '])).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'var', index: 1, sample: 'Ana' },
      { kind: 'text', value: ', order ' },
      { kind: 'var', index: 2 },
      { kind: 'text', value: ' ready' },
    ]);
  });

  it('handles empty text, no variables and adjacent variables', () => {
    expect(previewSegments(undefined)).toEqual([]);
    expect(previewSegments('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
    expect(previewSegments('{{1}}{{2}}')).toEqual([
      { kind: 'var', index: 1 },
      { kind: 'var', index: 2 },
    ]);
  });
});

const entry = (over: Partial<LibraryEntry>): LibraryEntry => ({
  slug: 's',
  industry: 'retail',
  industry_label: 'Retail',
  category: 'Marketing',
  title: 'Sale',
  description: 'desc',
  name: 'sale',
  body_text: 'Hello {{1}}',
  sample_values: { body: ['Ana'] },
  ...over,
});

describe('filterLibrary', () => {
  const list = [
    entry({ slug: 'a', title: 'Flash sale' }),
    entry({ slug: 'b', industry: 'food', industry_label: 'Food', category: 'Utility', title: 'Table booked' }),
  ];
  it('filters by query, industry and category together', () => {
    const none = { query: '', industry: null, category: null };
    expect(filterLibrary(list, none)).toHaveLength(2);
    expect(filterLibrary(list, { ...none, query: 'TABLE' }).map((e) => e.slug)).toEqual(['b']);
    expect(filterLibrary(list, { ...none, industry: 'retail' }).map((e) => e.slug)).toEqual(['a']);
    expect(filterLibrary(list, { ...none, category: 'Utility', query: 'flash' })).toEqual([]);
  });
});

describe('libraryDraft', () => {
  it('maps a library entry to the editor draft shape', () => {
    const draft = libraryDraft(
      entry({
        header: { type: 'text', text: 'Hi' },
        footer_text: 'Reply STOP',
        buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      }),
      'en_US'
    );
    expect(draft).toEqual({
      name: 'sale',
      category: 'Marketing',
      language: 'en_US',
      template_kind: 'standard',
      header_type: 'text',
      header_content: 'Hi',
      body_text: 'Hello {{1}}',
      footer_text: 'Reply STOP',
      buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      sample_values: { body: ['Ana'] },
    });
    expect(libraryDraft(entry({}), 'es')).not.toHaveProperty('header_type');
  });
});

describe('filterLanguages', () => {
  const langs = [
    { code: 'en_US', label: 'English (US)' },
    { code: 'pt_BR', label: 'Portuguese (Brazil)' },
  ];
  it('matches code or label case-insensitively', () => {
    expect(filterLanguages(langs, '')).toHaveLength(2);
    expect(filterLanguages(langs, 'pt_').map((l) => l.code)).toEqual(['pt_BR']);
    expect(filterLanguages(langs, 'english').map((l) => l.code)).toEqual(['en_US']);
  });
});
