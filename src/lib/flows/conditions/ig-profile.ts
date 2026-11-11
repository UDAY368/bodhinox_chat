// The `ig_profile` condition subject (Instagram flows): a fact about the customer
// that the follow gate, "verified" and "in window" checks test. The engine calls
// igProfileSubject when a condition rule has subject 'ig_profile'; booleans come
// back as "true"/"false", the follower count as a number, unknown as undefined
// (so every operator but `absent` fails, never a guess).
//
//   follows_business / business_follows / is_verified / follower_count
//       read live from Meta when the run reaches the condition (refreshProfileFacts,
//       once per loaded run), falling back to the stored facts when Meta does not answer.
//       Meta's field names are documented, not yet seen live: needs live capture.
//   in_window
//       the customer wrote (or tapped a reply or postback) within 24 hours, the same
//       rule the automated sends use (instagramAutomatedWindowOpen); read from the
//       database now, so a run that waited past the window sees false.
//
// A run that is not an Instagram run, or has no conversation, gets undefined.
// Nothing is logged.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { instagramAutomatedWindowOpen } from '@/lib/channels/sender';
import { refreshProfileFacts, type ProfileFacts } from '@/lib/instagram/profile';

/** The fact `subject_key` values this module resolves (kept equal to IG_PROFILE_FACTS in ../types). */
export const IG_CONDITION_FACTS = ['follows_business', 'business_follows', 'is_verified', 'follower_count', 'in_window'] as const;

/** A profile fact as a condition subject value. */
export function igProfileValue(facts: ProfileFacts | null, key: string): string | undefined {
  if (!facts) return undefined;
  const value = key === 'follows_business' ? facts.followsBusiness
    : key === 'business_follows' ? facts.businessFollows
      : key === 'is_verified' ? facts.isVerified
        : key === 'follower_count' ? facts.followerCount : null;
  return value === null || value === undefined ? undefined : String(value);
}

/** One live profile read per loaded run object: a condition with several profile rules reads Meta once. */
const profileReads = new WeakMap<object, Promise<ProfileFacts | null>>();

/** "true" or "false": whether the customer is inside the 24-hour window right now. */
export async function igWindowValue(accountId: string, conversationId: string, now: Date = new Date()): Promise<string> {
  const open = await withTenant({ accountId, role: 'owner' }, (tx) => instagramAutomatedWindowOpen(tx, accountId, conversationId, now), getWorkerPrisma());
  return String(open);
}

/**
 * The subject value of one `ig_profile` rule. `run` is the loaded flow run (the
 * read cache key); `instagram` is whether its conversation is an Instagram one,
 * which the engine already knows.
 */
export async function igProfileSubject(
  run: { account_id: string; conversation_id: string | null },
  key: string,
  instagram: boolean,
): Promise<string | undefined> {
  if (!run.conversation_id || !instagram) return undefined;
  if (key === 'in_window') return igWindowValue(run.account_id, run.conversation_id);
  let read = profileReads.get(run);
  if (!read) {
    read = refreshProfileFacts(run.account_id, run.conversation_id);
    profileReads.set(run, read);
    read.catch(() => profileReads.delete(run));
  }
  return igProfileValue(await read, key);
}
