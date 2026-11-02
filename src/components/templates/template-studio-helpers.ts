/**
 * Pure helpers behind the template studio components: variable
 * interpolation for previews, library filtering and language search.
 * Kept free of React and translations so they are unit-tested in node.
 */

import type { TemplateLanguage } from '@/lib/whatsapp/template-languages';
import type { LibraryTemplate } from '@/lib/whatsapp/template-library';
import type { TemplateDraftInput } from './types';

export type PreviewSegment =
  | { kind: 'text'; value: string }
  | { kind: 'var'; index: number; sample?: string };

/**
 * Split template text into literal runs and {{n}} variables, attaching
 * the sample value for each variable when one is present and non-blank.
 */
export function previewSegments(
  text: string | undefined,
  samples?: readonly string[]
): PreviewSegment[] {
  if (!text) return [];
  const out: PreviewSegment[] = [];
  const re = /\{\{(\d+)\}\}/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });
    const index = Number(m[1]);
    const sample = samples?.[index - 1]?.trim();
    out.push(sample ? { kind: 'var', index, sample } : { kind: 'var', index });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** A library entry as returned by GET /api/whatsapp/templates/library. */
export type LibraryEntry = LibraryTemplate & { industry_label: string };

export interface LibraryFilter {
  query: string;
  industry: string | null;
  category: 'Marketing' | 'Utility' | null;
}

export function filterLibrary(
  entries: readonly LibraryEntry[],
  { query, industry, category }: LibraryFilter
): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!industry || e.industry === industry) &&
      (!category || e.category === category) &&
      (!q ||
        [e.title, e.description, e.body_text, e.name, e.industry_label].some(
          (s) => s.toLowerCase().includes(q)
        ))
  );
}

/** Map a library entry to the editor's draft shape. */
export function libraryDraft(
  tpl: LibraryTemplate,
  language: string
): TemplateDraftInput {
  return {
    name: tpl.name,
    category: tpl.category,
    language,
    template_kind: 'standard',
    ...(tpl.header
      ? { header_type: 'text' as const, header_content: tpl.header.text }
      : {}),
    body_text: tpl.body_text,
    ...(tpl.footer_text ? { footer_text: tpl.footer_text } : {}),
    ...(tpl.buttons?.length ? { buttons: tpl.buttons } : {}),
    sample_values: { body: [...tpl.sample_values.body] },
  };
}

/** Case-insensitive match on code or label, keeping list order. */
export function filterLanguages(
  languages: readonly TemplateLanguage[],
  query: string
): TemplateLanguage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...languages];
  return languages.filter(
    (l) => l.code.toLowerCase().includes(q) || l.label.toLowerCase().includes(q)
  );
}
