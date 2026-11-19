/** Order tags: short staff labels, stored lower-case, deduplicated, at most TAG_LIMITS.maxTags. Internal only. */

export const TAG_LIMITS = { maxTags: 10, maxLength: 24 } as const;
const TAG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

/** The cleaned tag list, or null when the input is not a list of valid tags. */
export function parseTags(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > TAG_LIMITS.maxTags * 2) return null;
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const tag = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag || tag.length > TAG_LIMITS.maxLength || !TAG_SHAPE.test(tag)) return null;
    seen.add(tag);
  }
  return seen.size > TAG_LIMITS.maxTags ? null : [...seen];
}
