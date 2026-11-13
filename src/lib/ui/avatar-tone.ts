// Soft avatar tints, picked by a stable hash of a name so a person keeps their colour everywhere.
const AVATAR_TONES = [
  'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  'bg-teal-500/12 text-teal-700 dark:text-teal-300',
];

export function avatarTone(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Up to two initials ("Divya Patel" → "DP"); "?" for an empty name. */
export function initials(name?: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
}
