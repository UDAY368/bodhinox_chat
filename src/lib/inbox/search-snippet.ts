/**
 * Search snippets carry their highlights as two private-use characters
 * instead of HTML, so the browser renders them as text (no
 * dangerouslySetInnerHTML) and message content can never inject markup.
 * The server strips both characters from message text before marking it.
 * Client-safe: no server imports.
 */

export const SNIPPET_START = '\uE000';
export const SNIPPET_END = '\uE001';
const MARKERS = /[\uE000\uE001]/g;
const MAX_SNIPPET_LENGTH = 240;

export interface SnippetPart {
  text: string;
  match: boolean;
}

export function stripSnippetMarkers(text: string): string {
  return text.replace(MARKERS, '');
}

/** Split a marked snippet into plain and highlighted runs. Unbalanced markers are tolerated. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let current = '';
  for (const ch of snippet) {
    if (ch === SNIPPET_START || ch === SNIPPET_END) {
      if (current) parts.push({ text: current, match });
      current = '';
      match = ch === SNIPPET_START;
      continue;
    }
    current += ch;
  }
  if (current) parts.push({ text: current, match });
  return parts;
}

/**
 * Snippet for a substring ("contains") match: up to `radius` characters each
 * side of the first case-insensitive occurrence, with that occurrence marked.
 * Without an occurrence (e.g. a contact phone match) it returns the start of
 * the text, unmarked.
 */
export function containsSnippet(text: string | null | undefined, needle: string, radius = 80): string {
  const clean = stripSnippetMarkers(text ?? '').replace(/\s+/g, ' ').trim();
  const at = needle ? clean.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return clean.length > MAX_SNIPPET_LENGTH ? `${clean.slice(0, MAX_SNIPPET_LENGTH)}…` : clean;
  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + needle.length + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, at)}${SNIPPET_START}${clean.slice(at, at + needle.length)}${SNIPPET_END}${clean.slice(at + needle.length, end)}${end < clean.length ? '…' : ''}`;
}
