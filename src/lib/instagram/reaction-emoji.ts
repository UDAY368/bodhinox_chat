// Client-safe: Instagram's only reaction (Meta's "love") and how an emoji maps to it.

/** The only emoji Instagram reactions carry (Meta's "love"). */
export const INSTAGRAM_REACTION = '❤️';

/** '❤️' (or the bare heart) reacts, '' removes; anything else is not available on Instagram. */
export function instagramReactionIntent(emoji: string): 'react' | 'unreact' | null {
  if (emoji === '') return 'unreact';
  return emoji === INSTAGRAM_REACTION || emoji === '❤' ? 'react' : null;
}
