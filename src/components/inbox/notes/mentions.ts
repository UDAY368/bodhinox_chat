/**
 * Pure helpers for @mention autocomplete in the notes composer. A mention is
 * the text "@<member name>"; the composer remembers which member each picked
 * name belongs to, and only names still present in the text are sent.
 */

export interface MentionMember {
  id: string;
  name: string;
}

export const MAX_MENTIONS = 20;
const MAX_QUERY = 40;

/** The "@query" being typed at the caret, or null when not in a mention. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // "@" must start the text or follow whitespace/punctuation, so emails do not trigger it.
  if (at > 0 && /[\p{L}\p{N}_.]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n@]/.test(query) || /\s{2}/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Members whose name contains the query (prefix matches first), at most `limit`. */
export function matchMembers(members: MentionMember[], query: string, limit = 8): MentionMember[] {
  const q = query.trim().toLocaleLowerCase();
  const scored = members
    .map((member) => {
      const name = member.name.toLocaleLowerCase();
      const words = name.split(/\s+/);
      const score = !q || name.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
      return { member, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.member.name.localeCompare(b.member.name));
  return scored.slice(0, limit).map((entry) => entry.member);
}

/** Replace the "@query" from `start` to `caret` with "@Name ". */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, '');
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}

/** Ids of picked members whose "@Name" is still in the text (unique, capped). */
export function mentionedIds(text: string, picked: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const [id, name] of picked) {
    if (text.includes(`@${name}`) && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_MENTIONS) break;
  }
  return ids;
}

/** Split a note body into plain text and "@Name" parts for known member names. */
export function splitMentions(body: string, names: string[]): { text: string; mention: boolean }[] {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return [{ text: body, mention: false }];
  const escaped = unique.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(?:${escaped.join('|')})`, 'g');
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: body.slice(last, index), mention: false });
    parts.push({ text: match[0], mention: true });
    last = index + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}
