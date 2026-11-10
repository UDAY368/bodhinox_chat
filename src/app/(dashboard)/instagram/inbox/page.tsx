import { redirect } from 'next/navigation';
import { ChannelGate } from '@/components/channels/channel-gate';
import { InboxView } from '@/components/inbox/inbox-view';
import { resolveInboxRedirect } from '@/lib/inbox/channel-inbox';

// The Instagram inbox: only Instagram conversations. A ?c=<id> link to a
// WhatsApp conversation opens in the WhatsApp inbox (or the All view while
// WhatsApp is off). The layout shows the off state when Instagram is off or unavailable.
export default async function InstagramInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const target = await resolveInboxRedirect('instagram', await searchParams);
  if (target) redirect(target);
  // Gated here, not by the section layout, so the redirect above always runs first.
  return <ChannelGate channel="instagram"><InboxView channel="instagram" /></ChannelGate>;
}
