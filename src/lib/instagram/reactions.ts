// Staff reactions on Instagram (Meta Send API sender_action react / unreact).
// Instagram accepts one reaction, the heart ("love"), so that is the only one
// offered; removing it sends unreact. The target comes from the conversation
// row inside a worker tenant transaction (the app role cannot read the token)
// and the window is checked as for a text. A reaction is idempotent on Meta's
// side (reacting twice keeps one heart), so it is sent directly, the way
// WhatsApp reactions are. Nothing from the message is logged.
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import {
  checkInstagramReaction,
  loadInstagramTarget,
  sendInstagramReaction,
  type InstagramSendContext,
} from '@/lib/channels/sender';
import { InstagramError } from './errors';

export { INSTAGRAM_REACTION, instagramReactionIntent } from './reaction-emoji';

export async function reactOnInstagram(input: {
  accountId: string;
  conversationId: string;
  /** Meta's mid of the message being reacted to. */
  mid: string;
  react: boolean;
}): Promise<void> {
  const ctx: InstagramSendContext = { sender: 'staff', now: new Date() };
  const target = await withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
    const loaded = await loadInstagramTarget(tx, input.accountId, input.conversationId);
    checkInstagramReaction(loaded, input.mid, ctx);
    return loaded;
  }, getWorkerPrisma());
  if (!target) throw new InstagramError('not_found');
  await sendInstagramReaction(target, input.mid, input.react, ctx);
}
